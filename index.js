const express = require('express');
const axios = require('axios');
const { google } = require('googleapis'); // For future OAuth if needed
const Airtable = require('airtable');
const moment = require('moment-timezone'); // For date/time handling
const nodemailer = require('nodemailer'); // NEW: For sending emails
require('dotenv').config(); // Load environment variables

const app = express();
app.use(express.json()); // Middleware to parse JSON request bodies

// --- Airtable Configuration ---
Airtable.configure({
    apiKey: process.env.AIRTABLE_API_KEY,
});
const base = Airtable.base(process.env.AIRTABLE_BASE_ID);

// --- Helper Functions ---

/**
 * Finds a specific context from Dialogflow's webhook request.
 * @param {string} contextName The display name of the context (e.g., "booking-flow").
 * @param {Array} contexts The array of contexts from the Dialogflow request.
 * @returns {object|null} The found context object, or null if not found.
 */
function findContext(contextName, contexts) {
    if (!contexts) {
        console.log(`DEBUG: No contexts provided to findContext.`);
        return null;
    }
    const fullContextName = `${process.env.DIALOGFLOW_PROJECT_ID}/agent/sessions/${process.env.DIALOGFLOW_SESSION_ID}/contexts/${contextName}`;
    const found = contexts.find(context => context.name === fullContextName || context.name.endsWith(`/contexts/${contextName}`));
    console.log(`DEBUG: Searching for context "${contextName}". Found:`, found ? "Yes" : "No");
    return found;
}

/**
 * Extracts a parameter from Dialogflow, checking multiple sources.
 * @param {object} dialogflowRequest The Dialogflow webhook request.
 * @param {string} paramName The name of the parameter to extract.
 * @returns {any} The parameter value, or undefined if not found.
 */
function getParameter(dialogflowRequest, paramName) {
    const queryResult = dialogflowRequest.queryResult;
    // Check parameters from the current intent
    if (queryResult.parameters && queryResult.parameters[paramName]) {
        console.log(`DEBUG: Parameter '${paramName}' found in current intent parameters.`);
        return queryResult.parameters[paramName];
    }
    // Check parameters from input contexts
    if (queryResult.outputContexts) {
        for (const context of queryResult.outputContexts) {
            if (context.parameters && context.parameters[paramName]) {
                console.log(`DEBUG: Parameter '${paramName}' found in output context: ${context.name}.`);
                return context.parameters[paramName];
            }
        }
    }
    console.log(`DEBUG: Parameter '${paramName}' not found.`);
    return undefined;
}

/**
 * Fetches all available venues from Airtable.
 * @returns {Array} An array of venue objects.
 */
async function getAvailableVenues() {
    console.log("Fetching available venues...");
    const venues = [];
    await base('Venues').select({
        view: "Grid view" // Ensure this view exists and is accessible
    }).eachPage((records, fetchNextPage) => {
        records.forEach(record => {
            venues.push({
                id: record.id,
                name: record.get('Name'),
                description: record.get('Description')
            });
        });
        fetchNextPage();
    });
    console.log(`Found ${venues.length} venues.`);
    return venues;
}

/**
 * Fetches all available packages from Airtable. (Still present but not used in group flow)
 * @returns {Array} An array of package objects.
 */
async function getAvailablePackages() {
    console.log("Fetching available packages...");
    const packages = [];
    await base('Packages').select({
        view: "Grid view"
    }).eachPage((records, fetchNextPage) => {
        records.forEach(record => {
            packages.push({
                id: record.id,
                name: record.get('Name'),
                price: record.get('Price') || 0 // Ensure price is a number
            });
        });
        fetchNextPage();
    });
    console.log(`Found ${packages.length} packages.`);
    return packages;
}

/**
 * Fetches all available add-ons from Airtable. (Still present but not used in group flow)
 * @returns {Array} An array of add-on objects.
 */
async function getAvailableAddOns() {
    console.log("Fetching available add-ons...");
    const addOns = [];
    await base('Add-Ons').select({
        view: "Grid view"
    }).eachPage((records, fetchNextPage) => {
        records.forEach(record => {
            addOns.push({
                id: record.id,
                name: record.get('Name'),
                price: record.get('Price') || 0 // Ensure price is a number
            });
        });
        fetchNextPage();
    });
    console.log(`Found ${addOns.length} add-ons.`);
    return addOns;
}

/**
 * Creates a new booking record in Airtable. (MODIFIED: Now handles both Table and Group Leads)
 * @param {object} bookingDetails Details from the booking-flow context.
 * @param {string} status The status to set for the booking (e.g., 'Confirmed', 'New Lead').
 * @returns {object} The created Airtable record.
 */
async function createBooking(bookingDetails, status) {
    console.log("Attempting to create booking with details:", JSON.stringify(bookingDetails, null, 2));

    const fields = {
        'Booking Type': bookingDetails.type,
        'Full Name': bookingDetails.full_name,
        'Email': bookingDetails.email_id,
        'Phone Number': bookingDetails.phone_number,
        'Guest Count': bookingDetails.guestCount,
        'Booking Date': bookingDetails.bookingDate,
        'Booking Time': bookingDetails.bookingTime,
        'Venue': bookingDetails.venue_id ? [bookingDetails.venue_id] : null, // Link to Venue record
        'Status': status // Set status based on booking type
    };

    // Only add package/add-on/grand total fields if they are relevant (i.e., for confirmed table bookings)
    // For group leads, these will be null/undefined as they are not collected by the bot.
    if (bookingDetails.type === 'table') {
        // These fields are typically for confirmed bookings with pricing
        if (bookingDetails.packages && bookingDetails.packages.length > 0) {
            fields.package_name = Array.isArray(bookingDetails.packages) ? bookingDetails.packages.join(', ') : bookingDetails.packages;
        }
        if (bookingDetails.package_ids && bookingDetails.package_ids.length > 0) {
            fields.package_id = bookingDetails.package_ids;
        }
        if (bookingDetails.selected_add_ons && bookingDetails.selected_add_ons.length > 0) {
            fields.selected_add_ons = Array.isArray(bookingDetails.selected_add_ons) ? bookingDetails.selected_add_ons.join(', ') : bookingDetails.selected_add_ons;
        }
        fields['Grand Total'] = bookingDetails.grand_total || 0;
    } else if (bookingDetails.type === 'group') {
        // Explicitly set these to null for group leads to ensure they are empty in Airtable
        fields.package_name = null;
        fields.package_id = null;
        fields.selected_add_ons = null;
        fields['Grand Total'] = null;
    }

    console.log("Fields for new booking record:", JSON.stringify(fields, null, 2));

    try {
        // IMPORTANT: Ensure your 'Bookings' table has all these columns,
        // even if some will be null for group leads.
        const record = await base('Bookings').create(fields, { typecast: true });
        console.log("Successfully created booking record:", record.id);
        return record;
    } catch (error) {
        console.error("Error creating booking record:", error.message, error.stack);
        throw new Error(`Failed to create booking: ${error.message}`);
    }
}

/**
 * Creates records in the Booking_Addons table to link add-ons to a booking. (Still present but not used in new group flow)
 * @param {string} bookingRecordId The ID of the newly created booking record.
 * @param {Array<string>} selectedAddOnNames An array of names of selected add-ons.
 * @param {Array<object>} allAvailableAddOns All add-on objects from Airtable (name and id).
 */
async function createBookingAddons(bookingRecordId, selectedAddOnNames, allAvailableAddOns) {
    console.log(`Creating add-on links for booking ID: ${bookingRecordId}`);
    const recordsToCreate = [];

    selectedAddOnNames.forEach(addOnName => {
        const addOn = allAvailableAddOns.find(a => a.name === addOnName);
        if (addOn) {
            recordsToCreate.push({
                fields: {
                    'Booking': [bookingRecordId], // Link to the main Booking record
                    'Add-On': [addOn.id],        // Link to the Add-On record
                    'Quantity': 1                 // Assuming 1 quantity per selected add-on for simplicity
                }
            });
        } else {
            console.warn(`Warning: Could not find Add-On ID for name: ${addOnName}`);
        }
    });

    if (recordsToCreate.length > 0) {
        try {
            const createdRecords = await base('Booking_Addons').create(recordsToCreate, { typecast: true });
            console.log(`Successfully created ${createdRecords.length} Booking_Addon records.`);
        } catch (error) {
            console.error("Error creating Booking_Addon records:", error.message, error.stack);
            throw new Error(`Failed to link add-ons to booking: ${error.message}`);
        }
    } else {
        console.log("No Booking_Addon records to create.");
    }
}

/**
 * Sends an email with a link to the PDF packages.
 * @param {string} toEmail The recipient's email address.
 * @param {string} customerName The customer's full name.
 * @returns {Promise<boolean>} True if email sent successfully, false otherwise.
 */
async function sendEmailWithPdf(toEmail, customerName) {
    // Configure your email transporter (e.g., Zoho Mail, Gmail, custom SMTP)
    let transporter = nodemailer.createTransport({
        host: process.env.EMAIL_SERVICE_HOST, // e.g., smtp.zoho.com
        port: parseInt(process.env.EMAIL_SERVICE_PORT), // e.g., 587
        secure: false, // Use 'true' for port 465 (SSL), 'false' for 587 (TLS)
        auth: {
            user: process.env.EMAIL_SERVICE_USER,
            pass: process.env.EMAIL_SERVICE_PASS
        },
        tls: {
            // WARNING: Do not fail on invalid certs - useful for testing, but remove in production if possible
            // if you encounter CERT_HAS_EXPIRED or similar errors, you might need this.
            // For production, ensure proper certificates or remove if not needed.
            rejectUnauthorized: false
        }
    });

    const pdfUrl = process.env.PDF_URL; // URL to your hosted PDF

    let mailOptions = {
        from: process.env.EMAIL_SERVICE_USER,
        to: toEmail,
        subject: 'Your Group Booking Package Details - [Your Company Name]',
        html: `
            <p>Dear ${customerName},</p>
            <p>Thank you for your interest in a group booking with us! We've received your inquiry details.</p>
            <p>Here is a link to our detailed package options for your perusal:</p>
            <p><a href="${pdfUrl}">View Our Group Booking Packages (PDF)</a></p>
            <p>Our manager will review your inquiry and get in touch with you shortly to assist with your package selection and finalize the details for your event.</p>
            <p>We look forward to helping you plan a fantastic event!</p>
            <p>Best regards,</p>
            <p>The [Your Company Name] Team</p>
        `
    };

    try {
        let info = await transporter.sendMail(mailOptions);
        console.log('Email sent: ' + info.response);
        return true;
    } catch (error) {
        console.error('Error sending email:', error);
        return false;
    }
}


/**
 * Placeholder for Gemini API call. Replace with actual API integration.
 * For now, it just returns the input text.
 * @param {string} text The text to send to Gemini.
 * @returns {Promise<string>} The response from Gemini.
 */
async function generateGeminiReply(text) {
    // In a real scenario, you would integrate with the Gemini API here.
    // Example using axios (replace with actual API endpoint and key)
    /*
    try {
        const response = await axios.post('YOUR_GEMINI_API_ENDPOINT', {
            prompt: text,
            // other Gemini parameters
        }, {
            headers: {
                'Authorization': `Bearer YOUR_GEMINI_API_KEY`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.generatedText; // Or whatever your Gemini response structure is
    } catch (error) {
        console.error("Error calling Gemini API:", error);
        return text; // Fallback to original text if API call fails
    }
    */
    return text; // For now, just return the input text
}

// --- Webhook Endpoint ---
app.post('/webhook', async (req, res) => {
    const dialogflowRequest = req.body;
    const intent = dialogflowRequest.queryResult.intent ? dialogflowRequest.queryResult.intent.displayName : 'Default Fallback Intent';
    const session = dialogflowRequest.session;
    const inputContexts = dialogflowRequest.queryResult.outputContexts; // Correctly capture outputContexts from queryResult

    console.log(`\n--- Webhook Request ---`);
    console.log(`Intent: ${intent}`);
    console.log(`Session: ${session}`);
    // console.log(`Full Request:`, JSON.stringify(dialogflowRequest, null, 2)); // Uncomment for full request debugging

    // --- Intent Handlers ---

    // ✅ Welcome Intent
    if (intent === "Welcome Intent") {
        console.log("DEBUG: Entering Welcome Intent.");
        const venues = await getAvailableVenues();
        const venueNames = venues.map(v => v.name).join(', ');
        return res.json({
            fulfillmentText: `Hello! Welcome to our booking service. We offer bookings for ${venueNames}. Are you looking to book a table or a group event with packages?`,
            outputContexts: [{
                name: `${session}/contexts/awaiting-booking-type`,
                lifespanCount: 5
            }]
        });
    }

    // ✅ Select Booking Type Intent
    if (intent === "Select Booking Type Intent") {
        console.log("DEBUG: Entering Select Booking Type Intent.");
        const bookingType = getParameter(dialogflowRequest, 'booking_type');
        let fulfillmentText = ``;
        let outputContexts = [];

        outputContexts.push({
            name: `${session}/contexts/booking-flow`,
            lifespanCount: 5,
            parameters: { type: bookingType }
        });

        if (bookingType === 'table') {
            fulfillmentText = await generateGeminiReply("Great! For a table booking, how many guests will there be?");
            outputContexts.push({
                name: `${session}/contexts/awaiting-guest-count`,
                lifespanCount: 2
            });
        } else if (bookingType === 'group') {
            // MODIFIED: For group, directly ask for guest count, skip package selection
            fulfillmentText = await generateGeminiReply(`Alright, for a group event, I'll need a few details to get started. How many guests will there be?`);
            outputContexts.push({
                name: `${session}/contexts/awaiting-guest-count`, // Direct to guest count
                lifespanCount: 2
            });
        } else {
            fulfillmentText = await generateGeminiReply("I'm sorry, I didn't understand the booking type. Please choose 'table' or 'group'.");
        }

        return res.json({ fulfillmentText, outputContexts });
    }

    // ❌ Select Packages Intent (No longer directly used for group flow, but kept for clarity)
    // This intent will not be hit if the 'Select Booking Type Intent' for 'group' directly
    // leads to 'awaiting-guest-count'.
    if (intent === "Select Packages Intent") {
        console.log(`DEBUG: Entering Select Packages Intent. (This should not be hit for new group flow)`);
        // This logic remains for historical context or if you re-introduce package selection.
        const selectedPackages = getParameter(dialogflowRequest, 'packages');
        const bookingFlowCtx = findContext("booking-flow", inputContexts);
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        const allAvailablePackages = await getAvailablePackages();

        let validPackageNames = [];
        let validPackageIds = [];
        let totalPackagePrice = 0;

        const packagesToProcess = Array.isArray(selectedPackages) ? selectedPackages : (selectedPackages ? [selectedPackages] : []);

        packagesToProcess.forEach(selectedName => {
            const foundPackage = allAvailablePackages.find(p => p.name.toLowerCase() === selectedName.toLowerCase());
            if (foundPackage) {
                validPackageNames.push(foundPackage.name);
                validPackageIds.push(foundPackage.id);
                totalPackagePrice += foundPackage.price;
            }
        });

        if (validPackageNames.length === 0) {
            return res.json({ fulfillmentText: await generateGeminiReply("I couldn't find those packages. Please select from our available packages."),
                outputContexts: [{
                    name: `${session}/contexts/awaiting-package-selection`,
                    lifespanCount: 2
                }]
            });
        }

        currentBookingDetails.packages = validPackageNames;
        currentBookingDetails.package_ids = validPackageIds;
        currentBookingDetails.grand_total = (currentBookingDetails.grand_total || 0) + totalPackagePrice;

        return res.json({
            fulfillmentText: await generateGeminiReply(`Got it! You've selected ${validPackageNames.join(' and ')}. How many guests will there be?`),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 5,
                    parameters: currentBookingDetails
                },
                {
                    name: `${session}/contexts/awaiting-guest-count`,
                    lifespanCount: 2
                }
            ]
        });
    }

    // ✅ Capture Guest Count Intent
    if (intent === "Capture Guest Count Intent") {
        console.log(`DEBUG: Entering Capture Guest Count Intent.`);
        const guestCount = getParameter(dialogflowRequest, 'number');
        const bookingFlowCtx = findContext("booking-flow", inputContexts);
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        if (!guestCount || guestCount <= 0) {
            return res.json({ fulfillmentText: await generateGeminiReply("Please provide a valid number of guests.") });
        }

        currentBookingDetails.guestCount = guestCount;

        return res.json({
            fulfillmentText: await generateGeminiReply("And on what date and time would you like to book? (e.g., 'tomorrow at 7 PM')"),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 5,
                    parameters: currentBookingDetails
                },
                {
                    name: `${session}/contexts/awaiting-datetime`,
                    lifespanCount: 2
                }
            ]
        });
    }

    // ✅ Capture DateTime Intent
    if (intent === "Capture DateTime Intent") {
        console.log(`DEBUG: Entering Capture DateTime Intent.`);
        const dateParam = getParameter(dialogflowRequest, 'date');
        const timeParam = getParameter(dialogflowRequest, 'time');
        const bookingFlowCtx = findContext("booking-flow", inputContexts);
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        if (!dateParam || !timeParam) {
            return res.json({ fulfillmentText: await generateGeminiReply("I need both a date and a time for your booking. Please tell me again.") });
        }

        const bookingDateTimeStr = `${dateParam.substring(0, 10)}T${timeParam.substring(11, 19)}`;
        const bookingMoment = moment.tz(bookingDateTimeStr, 'YYYY-MM-DDTHH:mm:ss', 'Asia/Dubai');

        if (!bookingMoment.isValid()) {
            console.error(`Invalid date or time from Dialogflow: Date=${dateParam}, Time=${timeParam}`);
            return res.json({ fulfillmentText: await generateGeminiReply("I couldn't understand that date or time. Please use a common format like 'tomorrow at 7 PM'.") });
        }

        currentBookingDetails.bookingDate = bookingMoment.format('YYYY-MM-DD');
        currentBookingDetails.bookingTime = bookingMoment.format('HH:mm');
        currentBookingDetails.bookingUTC = bookingMoment.toISOString();

        const venues = await getAvailableVenues();
        const venueNames = venues.map(v => v.name).join(', ');

        return res.json({
            fulfillmentText: await generateGeminiReply(`Got it! For ${currentBookingDetails.guestCount} guests on ${currentBookingDetails.bookingDate} at ${currentBookingDetails.bookingTime}. Which venue would you like to book? We have: ${venueNames}.`),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 5,
                    parameters: currentBookingDetails
                },
                {
                    name: `${session}/contexts/awaiting-venue-selection`,
                    lifespanCount: 2
                }
            ]
        });
    }

    // ✅ Select Venue Intent
    if (intent === "Select Venue Intent") {
        console.log(`DEBUG: Entering Select Venue Intent.`);
        const venueName = getParameter(dialogflowRequest, 'venue_name');
        const bookingFlowCtx = findContext("booking-flow", inputContexts);
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        const availableVenues = await getAvailableVenues();
        const selectedVenue = availableVenues.find(v => v.name.toLowerCase() === venueName.toLowerCase());

        if (!selectedVenue) {
            return res.json({ fulfillmentText: await generateGeminiReply("I couldn't find that venue. Please select from the available venues.") });
        }

        currentBookingDetails.venue = selectedVenue.name;
        currentBookingDetails.venue_id = selectedVenue.id;

        // MODIFIED: For both table and group, now directly ask for contact details
        return res.json({
            fulfillmentText: await generateGeminiReply(`Great! You've chosen ${selectedVenue.name}. Now, could I get your full name, email, and phone number to finalize your inquiry?`),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 5,
                    parameters: currentBookingDetails
                },
                {
                    name: `${session}/contexts/awaiting-contact-details`, // Direct to contact details
                    lifespanCount: 2
                }
            ]
        });
    }

    // ❌ Capture Add-ons Intent (No longer directly used for group flow, but kept for clarity)
    // This intent will not be hit if the 'Select Venue Intent' for 'group' directly
    // leads to 'awaiting-contact-details'.
    if (intent === "Capture Add-ons Intent" || intent === "No Add-ons Intent") {
        console.log(`DEBUG: Entering Capture Add-ons Intent. (This should not be hit for new group flow)`);
        // This logic remains for historical context or if you re-introduce add-on selection.
        const bookingFlowCtx = findContext("booking-flow", inputContexts);
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};
        let selectedAddOnNames = [];
        let totalAddOnPrice = 0;

        if (intent === "Capture Add-ons Intent") {
            const addOnsParam = getParameter(dialogflowRequest, 'add_ons');
            const addOnsToProcess = Array.isArray(addOnsParam) ? addOnsParam : (addOnsParam ? [addOnsParam] : []);

            const allAvailableAddOns = await getAvailableAddOns();

            addOnsToProcess.forEach(selectedName => {
                const foundAddOn = allAvailableAddOns.find(a => a.name.toLowerCase() === selectedName.toLowerCase());
                if (foundAddOn) {
                    selectedAddOnNames.push(foundAddOn.name);
                    totalAddOnPrice += foundAddOn.price;
                }
            });

            if (selectedAddOnNames.length === 0 && addOnsToProcess.length > 0) {
                return res.json({ fulfillmentText: await generateGeminiReply("I couldn't find those add-ons. Please select from our available add-ons, or say 'no add-ons'."),
                    outputContexts: [{
                        name: `${session}/contexts/awaiting-add-ons`,
                        lifespanCount: 2
                    }]
                });
            }
        }

        currentBookingDetails.selected_add_ons = selectedAddOnNames;
        currentBookingDetails.grand_total = (currentBookingDetails.grand_total || 0) + totalAddOnPrice;

        return res.json({
            fulfillmentText: await generateGeminiReply(`Okay, ${selectedAddOnNames.length > 0 ? `you've added ${selectedAddOnNames.join(' and ')}.` : `no add-ons.`} Now, could I get your full name, email, and phone number to finalize?`),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 5,
                    parameters: currentBookingDetails
                },
                {
                    name: `${session}/contexts/awaiting-contact-details`,
                    lifespanCount: 2
                }
            ]
        });
    }

    // ✅ Capture Contact Details Intent
    if (intent === "Capture Contact Details Intent") {
        console.log(`DEBUG: Entering Capture Contact Details Intent.`);
        const fullName = getParameter(dialogflowRequest, 'full_name');
        const emailId = getParameter(dialogflowRequest, 'email');
        const phoneNumber = getParameter(dialogflowRequest, 'phone_number');

        const bookingFlowCtx = findContext("booking-flow", inputContexts);
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        // Basic validation (can be enhanced)
        if (!fullName || !emailId || !phoneNumber) {
            let missingFields = [];
            if (!fullName) missingFields.push('full name');
            if (!emailId) missingFields.push('email');
            if (!phoneNumber) missingFields.push('phone number');
            return res.json({ fulfillmentText: await generateGeminiReply(`I'm missing your ${missingFields.join(', ')}. Could you please provide all of them?`),
                outputContexts: [{
                    name: `${session}/contexts/awaiting-contact-details`,
                    lifespanCount: 2
                }]
            });
        }

        currentBookingDetails.full_name = fullName;
        currentBookingDetails.email_id = emailId;
        currentBookingDetails.phone_number = phoneNumber;

        // MODIFIED: Generate summary based on booking type (table vs. group lead)
        let summaryText;
        if (currentBookingDetails.type === 'group') {
            summaryText = `Alright, ${fullName}, let's summarize your group inquiry:\n`;
            summaryText += `Guests: ${currentBookingDetails.guestCount}\n`;
            summaryText += `Date: ${currentBookingDetails.bookingDate} at ${currentBookingDetails.bookingTime}\n`;
            summaryText += `Venue: ${currentBookingDetails.venue}\n`;
            summaryText += `Email: ${currentBookingDetails.email_id}\n`;
            summaryText += `Mobile: ${currentBookingDetails.phone_number}\n`;
            summaryText += `Is this all correct? (Yes/No)`;
            // NO packages, add-ons, or total price for group leads here.
        } else { // It's a table booking (<10 guests)
            summaryText = `Alright, ${fullName}, let's summarize your table reservation:\n`;
            summaryText += `Guests: ${currentBookingDetails.guestCount}\n`;
            summaryText += `Date: ${currentBookingDetails.bookingDate} at ${currentBookingDetails.bookingTime}\n`;
            summaryText += `Venue: ${currentBookingDetails.venue}\n`;
            // Add other table booking specific details if any, including grand_total if calculated earlier
            if (currentBookingDetails.grand_total) {
                summaryText += `Estimated Total: AED${currentBookingDetails.grand_total.toFixed(2)}\n`;
            }
            summaryText += `Is this all correct? (Yes/No)`;
        }

        return res.json({
            fulfillmentText: await generateGeminiReply(summaryText),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 5,
                    parameters: currentBookingDetails
                },
                {
                    name: `${session}/contexts/awaiting-confirmation`, // Still await confirmation from user
                    lifespanCount: 2
                }
            ]
        });
    }

    // ✅ Confirm Booking Intent (User says Yes to summary)
    if (intent === "Confirm Booking Intent") {
        console.log(`DEBUG: Entering Confirm Booking Intent.`);
        const bookingFlowCtx = findContext("booking-flow", inputContexts);
        if (!bookingFlowCtx) {
            console.error("❌ Confirm Booking Intent - Booking flow context missing!");
            return res.json({ fulfillmentText: await generateGeminiReply("I seem to have lost your booking details. Please start over.") });
        }

        const bookingDetails = bookingFlowCtx.parameters;

        let finalConfirmationPrompt;
        let outputContextsToSet = [];

        // MODIFIED: Now both types use createBooking, but with different statuses and data.
        if (bookingDetails.type === 'table') {
            try {
                // Create full booking record with 'Confirmed' status
                const createdBookingRecord = await createBooking(bookingDetails, 'Confirmed'); 
                // No add-ons for table bookings in this simplified flow, so no createBookingAddons call here.

                // Generate confirmation message for table booking
                const { date, time } = formatDubai(bookingDetails.bookingUTC);
                const venueName = bookingDetails.venue || "the selected venue";
                let totalPrice = '';
                if (bookingDetails.grand_total && bookingDetails.grand_total > 0) {
                    totalPrice = ` Your total is AED${bookingDetails.grand_total.toFixed(2)}.`;
                }
                finalConfirmationPrompt = `Excellent, ${bookingDetails.full_name}! Your table reservation for ${bookingDetails.guestCount} guests at ${venueName} on ${date} at ${time} is now confirmed!${totalPrice} A confirmation email will be sent to ${bookingDetails.email_id}. Thank you!`;

                outputContextsToSet = [
                    { name: `${session}/contexts/booking-finalized`, lifespanCount: 1 },
                    { name: `${session}/contexts/booking-flow`, lifespanCount: 0 },
                    { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 }
                ];

            } catch (error) {
                console.error("❌ Confirm Booking Intent (Table) - Error finalizing booking:", error.message);
                finalConfirmationPrompt = "I'm sorry, there was an issue finalizing your table reservation. Please try again or contact us directly.";
                outputContextsToSet = [
                    { name: `${session}/contexts/booking-flow`, lifespanCount: 2 },
                    { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 }
                ];
            }
        } else if (bookingDetails.type === 'group') {
            try {
                // Create lead record in 'Bookings' table with 'New Lead' status
                const createdLeadRecord = await createBooking(bookingDetails, 'New Lead'); 
                const emailSent = await sendEmailWithPdf(bookingDetails.email_id, bookingDetails.full_name);

                const { date, time } = formatDubai(bookingDetails.bookingUTC);
                const venueName = bookingDetails.venue || "the selected venue";

                if (emailSent) {
                    finalConfirmationPrompt = `Thank you, ${bookingDetails.full_name}! We've received your group booking inquiry for ${bookingDetails.guestCount} guests at ${venueName} on ${date} at ${time}. We've just sent an email to ${bookingDetails.email_id} with our package details. Our manager will be in touch shortly to help you finalize your selection. Is there anything else I can help you with today?`;
                } else {
                    finalConfirmationPrompt = `Thank you, ${bookingDetails.full_name}! We've received your group booking inquiry for ${bookingDetails.guestCount} guests at ${venueName} on ${date} at ${time}. We're having trouble sending the package details via email right now, but our manager will be in touch shortly to help you finalize your selection.`;
                }

                outputContextsToSet = [
                    { name: `${session}/contexts/group-lead-submitted`, lifespanCount: 1 }, // New context for lead submitted
                    { name: `${session}/contexts/booking-flow`, lifespanCount: 0 }, // Clear main context
                    { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 } // Clear previous confirmation context
                ];

            } catch (error) {
                console.error("❌ Confirm Booking Intent (Group) - Error submitting group lead or sending email:", error.message);
                finalConfirmationPrompt = "I'm sorry, there was an issue submitting your group inquiry. Please try again or contact us directly.";
                outputContextsToSet = [
                    { name: `${session}/contexts/booking-flow`, lifespanCount: 2 },
                    { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 }
                ];
            }
        } else {
            // Fallback if booking type is somehow missing or invalid
            finalConfirmationPrompt = "I'm sorry, I couldn't determine the booking type. Please try again.";
            outputContextsToSet = [
                { name: `${session}/contexts/booking-flow`, lifespanCount: 0 },
                { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 }
            ];
        }

        return res.json({
            fulfillmentText: await generateGeminiReply(finalConfirmationPrompt),
            outputContexts: outputContextsToSet
        });
    }

    // ✅ Deny Booking Intent (User says No to summary)
    if (intent === "Deny Booking Intent") {
        console.log(`DEBUG: Entering Deny Booking Intent.`);
        return res.json({
            fulfillmentText: await generateGeminiReply("Okay, no problem. Would you like to start the booking process again or cancel entirely?"),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`, // Clear booking-flow context
                    lifespanCount: 0, 
                },
                {
                    name: `${session}/contexts/awaiting-confirmation`, // Clear this context
                    lifespanCount: 0, 
                },
                {
                    name: `${session}/contexts/awaiting-restart-or-cancel`, // New context for user choice
                    lifespanCount: 2
                }
            ]
        });
    }

    // ✅ Restart Booking Intent (from Deny flow)
    if (intent === "Restart Booking Intent") {
        console.log(`DEBUG: Entering Restart Booking Intent.`);
        const venues = await getAvailableVenues();
        const venueNames = venues.map(v => v.name).join(', ');
        return res.json({
            fulfillmentText: `Alright, let's start over! We offer bookings for ${venueNames}. Are you looking to book a table or a group event with packages?`,
            outputContexts: [{
                name: `${session}/contexts/awaiting-booking-type`,
                lifespanCount: 5
            }]
        });
    }

    // ✅ Cancel Booking Intent (from Deny flow)
    if (intent === "Cancel Booking Intent") {
        console.log(`DEBUG: Entering Cancel Booking Intent.`);
        return res.json({
            fulfillmentText: await generateGeminiReply("Okay, I've cancelled your booking process. Feel free to reach out if you change your mind!"),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`, // Ensure contexts are cleared
                    lifespanCount: 0, 
                },
                {
                    name: `${session}/contexts/awaiting-restart-or-cancel`,
                    lifespanCount: 0
                }
            ]
        });
    }


    // Default Fallback Intent handler
    if (intent === "Default Fallback Intent") {
        console.log("DEBUG: Entering Default Fallback Intent.");
        // Check if there's an active booking context to provide more relevant fallback
        const bookingFlowCtx = findContext("booking-flow", inputContexts);
        if (bookingFlowCtx) {
            return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, I didn't understand that. Please tell me more about your booking preference or try rephrasing.") });
        } else {
            return res.json({ fulfillmentText: await generateGeminiReply("I didn't quite catch that. Could you please rephrase or tell me what you'd like to do?") });
        }
    }


    // Function to format UTC date/time to Dubai timezone
    function formatDubai(utcString) {
        const dubaiTime = moment.tz(utcString, 'Asia/Dubai');
        return {
            date: dubaiTime.format('MMMM Do, YYYY'),
            time: dubaiTime.format('h:mm A')
        };
    }

    // If intent is not handled
    return res.json({
        fulfillmentText: await generateGeminiReply("I'm not sure how to handle that request yet.")
    });
});

// --- Start the Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

