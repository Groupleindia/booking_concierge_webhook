const express = require('express');
const axios = require('axios');
const { google } = require('googleapis'); // For future OAuth if needed
const Airtable = require('airtable');
const moment = require('moment-timezone'); // For date/time handling
const nodemailer = require('nodemailer'); // For sending emails
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
 * Fetches all available venues from Airtable based on guest count. (MODIFIED: Restored guestCount filter)
 * @param {number} guestCount - The number of guests for the booking.
 * @returns {Array} An array of venue objects.
 */
async function getAvailableVenues(guestCount) {
    console.log("Fetching available venues...");
    const venues = [];
    try {
        const resp = await axios.get(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Venues`, {
            headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        return resp.data.records
            .filter((r) => guestCount ? r.fields.standing_capacity >= guestCount : true) // Filter only if guestCount is provided
            .map((r) => ({
                id: r.id, // Include venue ID
                name: r.fields.space_name,
                description: r.fields.description || "",
                standing_capacity: r.fields.standing_capacity || 0,
                seated_capacity: r.fields.seated_capacity || 0,
            }))
            .filter((v) => v.name); // Ensure venue name exists
    } catch (error) {
        console.error("❌ Error fetching venues from Airtable:", error.message);
        return []; // Return empty array on error
    }
}

/**
 * Fetches all available packages from Airtable. (Still present but not used in group flow)
 * @returns {Array} An array of package objects.
 */
async function getAvailablePackages() {
    console.log("Fetching available packages...");
    const packages = [];
    try {
        const resp = await axios.get(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Packages`, {
            headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        return resp.data.records
            .map((r) => ({
                id: r.id, // Store Airtable record ID for linking
                name: r.fields.package_name,
                price: r.fields.price || 0,
                price_type: r.fields.price_type,
                min_guests: r.fields.min_guests || 0,
                inclusions: r.fields.inclusions || "",
                category: r.fields.category || "General"
            }))
            .filter((p) => p.name); // Ensure package name exists
    } catch (error) {
        console.error("❌ Error fetching packages from Airtable:", error.message);
        return []; // Return empty array on error
    }
}

/**
 * Fetches all available add-ons from Airtable. (Still present but not used in group flow)
 * @returns {Array} An array of add-on objects.
 */
async function getAvailableAddOns() {
    console.log("Fetching available add-ons...");
    const addOns = [];
    try {
        const resp = await axios.get(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Add-Ons`, {
            headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        return resp.data.records
            .map((r) => ({
                id: r.id, // Store Airtable record ID for linking
                name: r.fields.add_on_name,
                price: r.fields.price || 0,
                price_type: r.fields.price_type,
                category: r.fields.category
            }))
            .filter((a) => a.name); // Ensure add-on name exists
    } catch (error) {
        console.error("❌ Error fetching add-ons from Airtable:", error.message);
        return []; // Return empty array on error
    }
}

/**
 * Formats a UTC ISO string into Dubai date and time.
 * @param {string} utcIso - The UTC ISO date string.
 * @returns {object} - An object with formatted date and time for Dubai.
 */
function formatDubai(utcIso) {
    const m = moment.utc(utcIso).tz("Asia/Dubai");
    return {
        date: m.format("dddd, D MMMM"), // e.g., "Wednesday, 2 July"
        time: m.format("h:mm A"), // e.g., "9:30 PM"
        local_datetime: m.format("YYYY-MM-DD HH:mm:ss") // e.g., "2025-07-05 19:00:00"
    };
}

/**
 * Builds a UTC ISO string from a Dubai date and time.
 * @param {string} date - The date string (YYYY-MM-DD).
 * @param {string} time - The time string (e.g., "7:00 PM", "19:00").
 * @returns {string} - The UTC ISO date string.
 */
function buildDubaiUTC(date, time) {
    // Handles both 12-hour (h:mm A) and 24-hour (HH:mm) formats
    return moment.tz(`${date} ${time}`, ["YYYY-MM-DD h:mm A", "YYYY-MM-DD HH:mm"], "Asia/Dubai").toISOString();
}

/**
 * Sends an email with a link to the PDF packages.
 * @param {string} toEmail The recipient's email address.
 * @param {string} customerName The customer's full name.
 * @returns {Promise<boolean>} True if email sent successfully, false otherwise.
 */
async function sendEmailWithPdf(toEmail, customerName) {
    let transporter = nodemailer.createTransport({
        host: process.env.EMAIL_SERVICE_HOST,
        port: parseInt(process.env.EMAIL_SERVICE_PORT),
        secure: false,
        auth: {
            user: process.env.EMAIL_SERVICE_USER,
            pass: process.env.EMAIL_SERVICE_PASS
        },
        tls: {
            rejectUnauthorized: false
        }
    });

    const pdfUrl = process.env.PDF_URL;

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
 * Calls the Gemini API to generate natural language responses.
 * Adds a specific tone instruction to the prompt.
 * @param {string} prompt - The prompt to send to the Gemini API.
 * @returns {Promise<string>} - The generated text response.
 */
async function generateGeminiReply(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const payload = {
        contents: [
            {
                parts: [
                    {
                        text: prompt +
                            '\n\nTone: Use a warm, conversational voice as if this was spoken on a call. Be helpful and clear. Avoid emojis and technical terms. Be concise.',
                    },
                ],
            },
        ],
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { "Content-Type": "application/json" }
        });

        const data = response.data;

        console.log("🟡 Gemini Request Prompt:", prompt);
        console.log("🟢 Gemini Raw Response:", JSON.stringify(data, null, 2));

        const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!reply) {
            console.error("🔴 Gemini response missing expected structure.");
            return "Sorry, I didn’t get a proper response. Can I help you another way?";
        }

        return reply;
    } catch (error) {
        console.error("❌ Gemini API Error:", error.response ? error.response.data : error.message);
        return "There was a technical issue getting the information. Please try again shortly.";
    }
}


/**
 * Creates a new booking record in the main "Bookings" Airtable table.
 * @param {object} bookingDetails - Object containing all booking and customer details.
 * @param {string} status - The status to set for the booking (e.g., 'Confirmed', 'New Lead').
 * @returns {Promise<object>} - The created record from Airtable.
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


// --- Webhook Endpoint ---
app.post('/webhook', async (req, res) => {
    const dialogflowRequest = req.body;
    const intent = dialogflowRequest.queryResult.intent ? dialogflowRequest.queryResult.intent.displayName : 'Default Fallback Intent';
    const session = dialogflowRequest.session;
    const inputContexts = dialogflowRequest.queryResult.outputContexts; // Correctly capture outputContexts from queryResult
    const params = dialogflowRequest.queryResult.parameters; // Get parameters from current queryResult

    console.log(`\n--- Webhook Request ---`);
    console.log(`Intent: ${intent}`);
    console.log(`Session: ${session}`);
    // console.log(`Full Request:`, JSON.stringify(dialogflowRequest, null, 2)); // Uncomment for full request debugging

    // --- Intent Handlers ---

    // ✅ Welcome Intent / Start Booking Intent (MODIFIED to directly handle initial booking parameters)
    // This intent should be triggered by initial booking queries like "Can you help book a party for 25 guests"
    if (intent === "Welcome Intent" || intent === "Booking Intent") { // Using "Booking Intent" as per your old code
        console.log("DEBUG: Entering Welcome/Booking Intent.");

        let guestCount = Array.isArray(params.guestCount) ? params.guestCount[0] : params.guestCount;
        const rawBookingDate = Array.isArray(params.bookingdate) ? params.bookingdate[0] : params.bookingdate;
        let rawBookingTime;
        if (Array.isArray(params.bookingtime)) {
            rawBookingTime = params.bookingtime[params.bookingtime.length - 1];
        } else {
            rawBookingTime = params.bookingtime;
        }

        let fulfillmentText;
        let outputContexts = [];
        let bookingType;
        let currentBookingDetails = {};

        if (guestCount && rawBookingDate && rawBookingTime) {
            // All initial parameters provided, proceed to infer type and ask for venue
            const bookingDateOnly = moment(rawBookingDate).format("YYYY-MM-DD");
            let bookingTimeStr;
            const timeStartIndex = rawBookingTime.indexOf('T') + 1;
            const timeEndIndex = rawBookingTime.indexOf('+');
            if (timeStartIndex !== -1 && timeEndIndex !== -1 && timeEndIndex > timeStartIndex) {
                bookingTimeStr = rawBookingTime.substring(timeStartIndex, timeEndIndex).substring(0, 5);
            } else {
                bookingTimeStr = moment(rawBookingTime).format("HH:mm");
                console.warn(`WARN: Fallback time parsing used for rawBookingTime: ${rawBookingTime}`);
            }
            const bookingUTC = buildDubaiUTC(bookingDateOnly, bookingTimeStr);

            bookingType = (guestCount >= 10) ? 'group' : 'table';
            currentBookingDetails.type = bookingType;
            currentBookingDetails.guestCount = guestCount;
            currentBookingDetails.bookingDate = bookingDateOnly; // Store formatted date
            currentBookingDetails.bookingTime = bookingTimeStr; // Store formatted time
            currentBookingDetails.bookingUTC = bookingUTC;

            const venues = await getAvailableVenues(guestCount);
            const venueNames = venues.map(v => v.name).join(', ');

            fulfillmentText = await generateGeminiReply(`Got it! For ${guestCount} guests, which implies a ${bookingType} booking, on ${formatDubai(bookingUTC).date} at ${formatDubai(bookingUTC).time}. Which venue would you like to book? We have: ${venueNames}.`);

            outputContexts.push({
                name: `${session}/contexts/booking-flow`,
                lifespanCount: 5,
                parameters: currentBookingDetails // Store all initial details
            });
            outputContexts.push({
                name: `${session}/contexts/awaiting-venue-selection`, // Direct to venue selection
                lifespanCount: 2
            });

        } else {
            // If not all initial parameters provided, ask for booking type (original Welcome flow)
            const venues = await getAvailableVenues(); // Get all venues, no guest count filter yet
            const venueNames = venues.map(v => v.name).join(', ');
            fulfillmentText = await generateGeminiReply(`Hello! Welcome to our booking service. We offer bookings for ${venueNames}. Are you looking to book a table or a group event with packages?`);
            outputContexts.push({
                name: `${session}/contexts/awaiting-booking-type`,
                lifespanCount: 5
            });
        }
        return res.json({ fulfillmentText, outputContexts });
    }

    // ✅ Select Booking Type Intent (Now handles explicit type selection if guest count wasn't provided initially)
    if (intent === "Select Booking Type Intent") {
        console.log("DEBUG: Entering Select Booking Type Intent.");
        const bookingType = getParameter(dialogflowRequest, 'booking_type');
        let fulfillmentText = ``;
        let outputContexts = [];
        const bookingFlowCtx = findContext("booking-flow", inputContexts);
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        currentBookingDetails.type = bookingType;

        outputContexts.push({
            name: `${session}/contexts/booking-flow`,
            lifespanCount: 5,
            parameters: currentBookingDetails
        });

        if (bookingType === 'table') {
            if (currentBookingDetails.guestCount) { // If guest count already known from initial query
                fulfillmentText = await generateGeminiReply(`Great! For ${currentBookingDetails.guestCount} guests, on what date and time would you like to book? (e.g., 'tomorrow at 7 PM')`);
                outputContexts.push({
                    name: `${session}/contexts/awaiting-datetime`,
                    lifespanCount: 2
                });
            } else {
                fulfillmentText = await generateGeminiReply("Great! For a table booking, how many guests will there be?");
                outputContexts.push({
                    name: `${session}/contexts/awaiting-guest-count`,
                    lifespanCount: 2
                });
            }
        } else if (bookingType === 'group') {
            if (currentBookingDetails.guestCount) { // If guest count already known from initial query
                fulfillmentText = await generateGeminiReply(`Alright, for a group event with ${currentBookingDetails.guestCount} guests, on what date and time would you like to book? (e.g., 'tomorrow at 7 PM')`);
                outputContexts.push({
                    name: `${session}/contexts/awaiting-datetime`,
                    lifespanCount: 2
                });
            } else {
                fulfillmentText = await generateGeminiReply(`Alright, for a group event, I'll need a few details to get started. How many guests will there be?`);
                outputContexts.push({
                    name: `${session}/contexts/awaiting-guest-count`,
                    lifespanCount: 2
                });
            }
        } else {
            fulfillmentText = await generateGeminiReply("I'm sorry, I didn't understand the booking type. Please choose 'table' or 'group'.");
        }

        return res.json({ fulfillmentText, outputContexts });
    }

    // ❌ Select Packages Intent (No longer directly used for group flow, but kept for clarity)
    if (intent === "Select Packages Intent") {
        console.log(`DEBUG: Entering Select Packages Intent. (This should not be hit for new group flow)`);
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
        // If booking type wasn't set earlier, set it now based on guest count
        if (!currentBookingDetails.type) {
            currentBookingDetails.type = (guestCount >= 10) ? 'group' : 'table';
        }

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

        const venues = await getAvailableVenues(currentBookingDetails.guestCount); // Pass guestCount for filtering
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

        const availableVenues = await getAvailableVenues(currentBookingDetails.guestCount); // Filter by guest count
        const selectedVenue = availableVenues.find(v => v.name.toLowerCase() === venueName.toLowerCase());

        if (!selectedVenue) {
            return res.json({ fulfillmentText: await generateGeminiReply("I couldn't find that venue for your group size. Please select from the available venues.") });
        }

        currentBookingDetails.venue = selectedVenue.name;
        currentBookingDetails.venue_id = selectedVenue.id;

        return res.json({
            fulfillmentText: await generateGeminiReply(`Great! You've chosen ${selectedVenue.name}. Now, could I get your full name, email, and phone number to finalize your inquiry?`),
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

    // ❌ Capture Add-ons Intent (No longer directly used for group flow, but kept for clarity)
    if (intent === "Capture Add-ons Intent" || intent === "No Add-ons Intent") {
        console.log(`DEBUG: Entering Capture Add-ons Intent. (This should not be hit for new group flow)`);
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

        let summaryText;
        if (currentBookingDetails.type === 'group') {
            summaryText = `Alright, ${fullName}, let's summarize your group inquiry:\n`;
            summaryText += `Guests: ${currentBookingDetails.guestCount}\n`;
            summaryText += `Date: ${formatDubai(currentBookingDetails.bookingUTC).date} at ${formatDubai(currentBookingDetails.bookingUTC).time}\n`;
            summaryText += `Venue: ${currentBookingDetails.venue}\n`;
            summaryText += `Email: ${currentBookingDetails.email_id}\n`;
            summaryText += `Mobile: ${currentBookingDetails.phone_number}\n`;
            summaryText += `Is this all correct? (Yes/No)`;
        } else { // It's a table booking (<10 guests)
            summaryText = `Alright, ${fullName}, let's summarize your table reservation:\n`;
            summaryText += `Guests: ${currentBookingDetails.guestCount}\n`;
            summaryText += `Date: ${formatDubai(currentBookingDetails.bookingUTC).date} at ${formatDubai(currentBookingDetails.bookingUTC).time}\n`;
            summaryText += `Venue: ${currentBookingDetails.venue}\n`;
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
                    name: `${session}/contexts/awaiting-confirmation`,
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

        if (bookingDetails.type === 'table') {
            try {
                const createdBookingRecord = await createBooking(bookingDetails, 'Confirmed'); 
                // No add-ons for table bookings in this simplified flow, so no createBookingAddons call here.

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
                    { name: `${session}/contexts/group-lead-submitted`, lifespanCount: 1 },
                    { name: `${session}/contexts/booking-flow`, lifespanCount: 0 },
                    { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 }
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
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 0, 
                },
                {
                    name: `${session}/contexts/awaiting-confirmation`,
                    lifespanCount: 0, 
                },
                {
                    name: `${session}/contexts/awaiting-restart-or-cancel`,
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
                    name: `${session}/contexts/booking-flow`,
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

