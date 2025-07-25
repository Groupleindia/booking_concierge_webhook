// index.js - Replit Webhook for AI Booking Concierge

const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const moment = require("moment-timezone");
const nodemailer = require("nodemailer"); // For sending emails
let fetch; // Declare fetch here, it will be assigned dynamically

// Use an immediately invoked async function to import node-fetch
// This is a workaround for ERR_REQUIRE_ESM when using require() in a CommonJS context
// with a module that is ESM-only.
(async () => {
    fetch = (await import('node-fetch')).default;
})();


dotenv.config(); // Load environment variables from .env file
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse JSON request bodies

// --- Environment Variables ---
// IMPORTANT: Ensure these are set in your .env file on Glitch based on your Airtable setup:
// BASE_ID=YOUR_AIRTABLE_BASE_ID (e.g., appXXXXXXXXXXXXXX)
// AIRTABLE_TOKEN=YOUR_AIRTABLE_API_KEY (e.g., patXXXXXXXXXXXXXX)
// AIRTABLE_VENUES_TABLE_ID=YOUR_VENTABLE_ID (e.g., tblXXXXXXXXXXXXXX - from your "Venues" table)
// AIRTABLE_PACKAGES_TABLE_ID=YOUR_PACKAGES_TABLE_ID (e.g., tblYYYYYYYYYYYYYY - from your "Packages" table)
// AIRTABLE_ADDONS_TABLE_ID=YOUR_ADDONS_TABLE_ID (e.g., tblZZZZZZZZZZZZZZ - from your "Add-Ons" table)
// AIRTABLE_BOOKINGS_TABLE_ID=YOUR_BOOKINGS_TABLE_ID (e.g., tblAAAAAAAAAAAAAA - from your "Bookings" table)
// AIRTABLE_BOOKING_ADDONS_TABLE_ID=YOUR_BOOKING_ADDONS_TABLE_ID (e.g., tblBBBBBBBBBBBBBB - from your "Booking_Addons" table)
// GEMINI_API_KEY=YOUR_GEMINI_API_KEY
// EMAIL_SERVICE_HOST=smtp.zoho.com
// EMAIL_SERVICE_PORT=587
// EMAIL_SERVICE_USER=your_zoho_email@yourdomain.com
// EMAIL_SERVICE_PASS=your_zoho_app_password_or_regular_password
// PDF_URL=https://your-domain.com/your-packages.pdf

// --- Airtable Configuration ---
const Airtable = require('airtable'); // Re-declare Airtable here to ensure it's configured
Airtable.configure({
    apiKey: process.env.AIRTABLE_TOKEN, // Using AIRTABLE_TOKEN as per your old code
});
const base = Airtable.base(process.env.BASE_ID); // Using BASE_ID as per your old code


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

// 🔹 Fetch venues from Airtable
/**
 * Fetches available venues from Airtable based on guest count.
 * @param {number} guestCount - The number of guests for the booking.
 * @returns {Promise<Array<object>>} - An array of available venue objects.
 */
async function getAvailableVenues(guestCount) {
    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_VENUES_TABLE_ID}`;
    const cfg = {
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
    };
    try {
        const resp = await axios.get(url, cfg);
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

// 🔹 Fetch available packages from Airtable (Kept for reference, but not used in group flow)
/**
 * Fetches available packages and their details from Airtable.
 * @returns {Promise<Array<object>>} - An array of package objects with name, price, etc.
 */
async function getAvailablePackages() {
    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_PACKAGES_TABLE_ID}`;
    const cfg = {
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
    };
    try {
        const resp = await axios.get(url, cfg);
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

// 🔹 Fetch available add-ons from Airtable (Kept for reference, but not used in group flow)
/**
 * Fetches available add-ons and their prices from Airtable.
 * @returns {Promise<Array<object>>} - An array of add-on objects with name and price.
 */
async function getAvailableAddOns() {
    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_ADDONS_TABLE_ID}`;
    const cfg = {
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
    };
    try {
        const resp = await axios.get(url, cfg);
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

// 🔹 Format UTC time into Dubai time
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

// 🔹 Convert booking date/time to UTC from Dubai
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

// 🔹 Gemini-powered AI response generator
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
        // Ensure fetch is available before calling
        if (!fetch) {
            console.error("❌ fetch is not initialized. Waiting for dynamic import.");
            return "There was a technical issue. Please try again shortly.";
        }

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const data = await response.json();

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

// 🔹 Create a new booking record in the "Bookings" table (MODIFIED for unified table and group lead)
/**
 * Creates a new booking record in the main "Bookings" Airtable table.
 * @param {object} bookingDetails - Object containing all booking and customer details.
 * @param {string} status - The status to set for the booking (e.g., 'Confirmed', 'New Lead').
 * @returns {Promise<object>} - The created record from Airtable.
 */
async function createBooking(bookingDetails, status) {
    console.log("Attempting to create booking with details:", JSON.stringify(bookingDetails, null, 2));

    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_BOOKINGS_TABLE_ID}`;
    const cfg = {
        headers: {
            Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };

    const now = moment();
    const formattedCreatedDate = now.format("M/D/YYYY h:mma"); // e.g., "6/25/2025 3:45pm"
    const storageTimeUtc = now.toISOString(); // ISO string for UTC storage time

    const { date: formattedBookingDate, time: formattedBookingTime, local_datetime: eventTimeLocal } = formatDubai(bookingDetails.bookingUTC);
    const eventDateTime = `${formattedBookingDate} ${formattedBookingTime}`; // e.g., "5 July 2025 8:30pm"

    const fields = {
        created_date: formattedCreatedDate,
        guest_name: bookingDetails.full_name,
        phone_no: bookingDetails.phone_number, // Corrected to phone_number as per Dialogflow
        email: bookingDetails.email_id,
        booking_type: bookingDetails.type === 'table' ? 'Table Booking' : 'Group Booking', // Map 'type' to 'booking_type'
        event_date_time: eventDateTime, // Combined date and time string
        guest_count: bookingDetails.guestCount, // Corrected to guestCount
        status: status, // Status passed dynamically
        event_time_local: eventTimeLocal, // Local Dubai time
        storage_time_utc: storageTimeUtc, // UTC time of storage
    };

    // Add venue details
    if (bookingDetails.venue) {
        fields.space_name = bookingDetails.venue; // Matches CSV 'space_name'
        if (bookingDetails.venue_id) { // Corrected to venue_id
            fields.space_id = [bookingDetails.venue_id]; // Ensure this is an array for linked records
        }
    }

    // Handle package, add-on, and grand total based on booking type
    if (bookingDetails.type === 'table') {
        // These fields are populated for table bookings if they were collected
        if (bookingDetails.packages && bookingDetails.packages.length > 0) {
            fields.package_name = Array.isArray(bookingDetails.packages) ? bookingDetails.packages.join(', ') : bookingDetails.packages;
        }
        if (bookingDetails.package_ids && bookingDetails.package_ids.length > 0) {
            fields.package_id = bookingDetails.package_ids;
        }
        if (bookingDetails.selected_add_ons && bookingDetails.selected_add_ons.length > 0) {
            fields.selected_add_ons = Array.isArray(bookingDetails.selected_add_ons) ? bookingDetails.selected_add_ons.join(', ') : bookingDetails.selected_add_ons;
        }
        fields.grand_total = bookingDetails.grand_total || 0; // Ensure this is a number
    } else if (bookingDetails.type === 'group') {
        // For group leads, explicitly set these to null/empty to ensure they are blank in Airtable
        fields.package_name = null;
        fields.package_id = null;
        fields.selected_add_ons = null;
        fields.grand_total = null;
    }

    const data = { records: [{ fields }] };
    try {
        const response = await axios.post(url, data, cfg);
        console.log('Booking successful:', response.data.records[0].id);
        return response.data.records[0]; // Return the created record
    } catch (error) {
        console.error('Error creating booking:', error.response ? error.response.data : error.message);
        throw new Error('Failed to create booking.');
    }
}

// 🔹 Create records in the "Booking_Addons" table for selected add-ons (Kept for table bookings if needed)
/**
 * Creates records in the "Booking_Addons" table for each selected add-on,
 * linking them to the main booking record.
 * @param {string} bookingRecordId - The Airtable record ID of the main booking.
 * @param {Array<string>} selectedAddOnNames - An array of names of selected add-ons.
 * @param {Array<object>} availableAddOns - The list of all available add-ons with their details.
 * @returns {Promise<void>}
 */
async function createBookingAddons(bookingRecordId, selectedAddOnNames, availableAddOns) {
    if (!selectedAddOnNames || selectedAddOnNames.length === 0) {
        return; // No add-ons to record
    }

    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_BOOKING_ADDONS_TABLE_ID}`;
    const cfg = {
        headers: {
            Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };

    const recordsToCreate = [];
    selectedAddOnNames.forEach(addOnName => {
        const addOnDetail = availableAddOns.find(ao => ao.name.toLowerCase() === addOnName.toLowerCase());
        if (addOnDetail) {
            recordsToCreate.push({
                fields: {
                    booking_id: [bookingRecordId], // Link to the main booking record
                    add_on_id: [addOnDetail.id], // Link to the Add-Ons record
                    quantity: 1, // Assuming quantity is 1 for now, adjust if user can specify
                    price: addOnDetail.price,
                    total_price: addOnDetail.price, // For single quantity, total price is item price
                    active: true // Or whatever default status you need
                }
            });
        } else {
            console.warn(`Selected add-on "${addOnName}" not found in available add-ons. Skipping.`);
        }
    });

    if (recordsToCreate.length > 0) {
        try {
            await axios.post(url, { records: recordsToCreate }, cfg);
            console.log(`Successfully recorded ${recordsToCreate.length} add-on(s) for booking ${bookingRecordId}.`);
        } catch (error) {
            console.error('Error creating booking add-ons:', error.response ? error.response.data : error.message);
            throw new Error('Failed to create booking add-ons.');
        }
    }
}


// 🔹 Dialogflow Webhook Endpoint
app.post("/webhook", async (req, res) => {
    const dialogflowRequest = req.body;
    const intent = dialogflowRequest.queryResult.intent.displayName;
    const session = dialogflowRequest.session;
    const params = dialogflowRequest.queryResult.parameters;
    const contexts = dialogflowRequest.queryResult.outputContexts || [];

    // Helper to find a context by its display name
    const findContext = (contextName) => {
        return contexts.find((c) => c.name.endsWith(`/contexts/${contextName}`));
    };

    // Log the exact intent string and its length for debugging
    console.log(`DEBUG: Webhook received intent (exact): "${intent}" (length: ${intent.length})`);

    try { // START OF MAIN TRY BLOCK FOR WEBHOOK
        // ✅ Welcome Intent (Reverted to simple greeting)
        if (intent === "Welcome Intent") {
            console.log("DEBUG: Entering Welcome Intent.");
            const venues = await getAvailableVenues(); // Get all venues, no guest count filter yet
            const venueNames = venues.map(v => v.name).join(', ');
            return res.json({
                fulfillmentText: `Hello! Welcome to our booking service. We offer bookings for ${venueNames}. Are you looking to book a table or a group event with packages?`,
                outputContexts: [{
                    name: `${session}/contexts/awaiting-booking-type`,
                    lifespanCount: 5
                }]
            });
        }

        // ✅ Booking Intent - Initial booking request (Restored original logic with group lead modifications)
        if (intent === "Booking Intent") {
            console.log("DEBUG: Entering Booking Intent.");

            let guestCount = Array.isArray(params.guestCount) ? params.guestCount[0] : params.guestCount;
            const rawBookingDate = Array.isArray(params.bookingdate) ? params.bookingdate[0] : params.bookingdate;
            let rawBookingTime;
            if (Array.isArray(params.bookingtime)) {
                rawBookingTime = params.bookingtime[params.bookingtime.length - 1];
            } else {
                rawBookingTime = params.bookingtime;
            }

            console.log(`DEBUG: rawBookingDate (from Dialogflow): ${rawBookingDate}`);
            console.log(`DEBUG: bookingDateOnly (formatted): ${moment(rawBookingDate).format("YYYY-MM-DD")}`);
            console.log(`DEBUG: rawBookingTime (from Dialogflow parameter): ${rawBookingTime}`);
            console.log(`DEBUG: params.bookingtime.original: ${JSON.stringify(params.bookingtime?.original)}`);

            let bookingTimeStr;
            const timeStartIndex = rawBookingTime.indexOf('T') + 1;
            const timeEndIndex = rawBookingTime.indexOf('+');
            if (timeStartIndex !== -1 && timeEndIndex !== -1 && timeEndIndex > timeStartIndex) {
                bookingTimeStr = rawBookingTime.substring(timeStartIndex, timeEndIndex).substring(0, 5); // Get "HH:mm"
            } else {
                bookingTimeStr = moment(rawBookingTime).format("HH:mm");
                console.warn(`WARN: Fallback time parsing used for rawBookingTime: ${rawBookingTime}`);
            }

            console.log(`DEBUG: bookingTimeStr (extracted for buildDubaiUTC): ${bookingTimeStr}`);

            const bookingUTC = buildDubaiUTC(moment(rawBookingDate).format("YYYY-MM-DD"), bookingTimeStr);
            const { date, time } = formatDubai(bookingUTC);

            const category = guestCount <= 10 ? "a general reservation" : "a group booking";
            const venues = await getAvailableVenues(guestCount);

            const prompt = venues.length
                ? `A user requested ${category} for ${guestCount} guests on ${date} at ${time}. Available venues: ${venues
                    .map((v) => v.name)
                    .join(", ")}. Write a short, helpful spoken-style response suitable for a phone booking. Mention the venue options clearly and ask the user if any of those work for them.`
                : `No venues available for ${guestCount} guests on ${date} at ${time}. Kindly offer an apology in a friendly, spoken tone.`;

            const reply = await generateGeminiReply(prompt);

            console.log("DEBUG: About to send response for Booking Intent.");

            return res.json({
                fulfillmentText: reply,
                outputContexts: [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: { guestCount, bookingUTC, type: category === "a general reservation" ? "table" : "group" }, // Store booking type
                    },
                    {
                        name: `${session}/contexts/awaiting-venue-selection`, // Direct to venue selection
                        lifespanCount: 2
                    }
                ],
            });
        }

        // ✅ Modify Booking Intent (No changes)
        if (intent === "ModifyBookingIntent") {
            const bookingFlowCtx = findContext("booking-flow");
            let { guestCount, bookingUTC, type } = bookingFlowCtx?.parameters || {};

            let currentDubaiMoment = moment.utc(bookingUTC).tz("Asia/Dubai");
            let currentDubaiDate = currentDubaiMoment.format("YYYY-MM-DD");
            let currentDubaiTime = currentDubaiMoment.format("HH:mm");

            let { newGuestCount, newDate, newTime } = params;

            console.log(`DEBUG (Modify): Initial guestCount: ${guestCount}, bookingUTC: ${bookingUTC}`);
            console.log(`DEBUG (Modify): newGuestCount: ${newGuestCount}, newDate: ${newDate}, newTime: ${newTime}`);
            console.log(`DEBUG (Modify): params.newTime.original: ${JSON.stringify(params.newTime?.original)}`);

            if (!newGuestCount && !newDate && !newTime) {
                return res.json({
                    fulfillmentText:
                        "What would you like to change — guest count, date, or time?",
                    outputContexts: [
                        {
                            name: `${session}/contexts/awaiting-modify-slot`,
                            lifespanCount: 1,
                        },
                        {
                            name: `${session}/contexts/booking-flow`,
                            lifespanCount: 5,
                            parameters: { guestCount, bookingUTC, type },
                        },
                    ],
                });
            }

            if (newGuestCount) guestCount = newGuestCount;
            if (newDate) {
                currentDubaiDate = moment(newDate).format("YYYY-MM-DD");
            }
            if (newTime) {
                const timeStartIndex = newTime.indexOf('T') + 1;
                const timeEndIndex = newTime.indexOf('+');
                if (timeStartIndex !== -1 && timeEndIndex !== -1 && timeEndIndex > timeStartIndex) {
                    currentDubaiTime = newTime.substring(timeStartIndex, timeEndIndex).substring(0, 5);
                } else {
                    currentDubaiTime = moment(newTime).format("HH:mm");
                    console.warn(`WARN: Fallback time parsing used for newTime: ${newTime}`);
                }
                console.log(`DEBUG (Modify): currentDubaiTime (extracted for buildDubaiUTC): ${currentDubaiTime}`);
            }

            bookingUTC = buildDubaiUTC(currentDubaiDate, currentDubaiTime);

            const { date, time } = formatDubai(bookingUTC);
            const venues = await getAvailableVenues(guestCount);

            const prompt = venues.length
                ? `The user updated the booking to ${guestCount} guests on ${date} at ${time}. Available venues: ${venues
                    .map((v) => v.name)
                    .join(", ")}. Respond in a clear, conversational tone.`
                : `After the change, no suitable venues found. Kindly inform the user in a warm, helpful voice.`;

            const reply = await generateGeminiReply(prompt);

            return res.json({
                fulfillmentText: reply,
                outputContexts: [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: { guestCount, bookingUTC, type },
                    },
                ],
            });
        }

        // ✅ Ask Venue Details Intent (No changes)
        if (intent === "Ask Venue Details Intent") {
            console.log(`DEBUG: Entering AskVenueDetailsIntent`);
            let venueRaw;
            if (Array.isArray(params.venue_name)) {
                venueRaw = params.venue_name[params.venue_name.length - 1];
            } else {
                venueRaw = params.venue_name;
            }
            venueRaw = venueRaw || params.venueName;

            console.log(`DEBUG: AskVenueDetailsIntent - venueRaw (after array check): ${venueRaw}`);

            if (!venueRaw) {
                console.log(`DEBUG: AskVenueDetailsIntent - No venueRaw found.`);
                return res.json({
                    fulfillmentText: `I couldn't catch the venue name. Could you say it again?`,
                });
            }

            const venueName = venueRaw.toLowerCase();
            const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_VENUES_TABLE_ID}`;
            const cfg = {
                headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
            };
            let resp;
            try {
                resp = await axios.get(url, cfg);
                console.log(`DEBUG: AskVenueDetailsIntent - Fetched venues from Airtable.`);
            } catch (error) {
                console.error("❌ AskVenueDetailsIntent - Error fetching venues from Airtable:", error.message);
                return res.json({
                    fulfillmentText: "There was a problem fetching venue details. Please try again."
                });
            }

            const match = resp.data.records.find(
                (r) =>
                    r.fields.space_name &&
                    r.fields.space_name.toLowerCase() === venueName
            );

            if (!match) {
                console.log(`DEBUG: AskVenueDetailsIntent - No match found for venue: ${venueName}`);
                return res.json({
                    fulfillmentText: `Sorry, I couldn't find details for "${venueRaw}".`,
                });
            }

            const venue = match.fields;
            const prompt = `The user asked for details about the venue "${venue.space_name}". The standing capacity is ${venue.standing_capacity}. Here is the description: ${venue.description || "No description provided."} As a helpful booking concierge, explain this information clearly to the user. Do NOT ask any follow up questions.`;

            console.log(`DEBUG: AskVenueDetailsIntent - Gemini prompt: ${prompt}`);
            const reply = await generateGeminiReply(prompt);
            console.log(`DEBUG: AskVenueDetailsIntent - Gemini reply: ${reply}`);

            return res.json({
                fulfillmentText: reply,
                outputContexts: [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: {
                            venue: venue.space_name,
                            venue_id: match.id, // Changed from space_id to venue_id for consistency
                        },
                    },
                ],
            });
        }

        // ✅ Select Venue Intent (MODIFIED: Streamlined for group bookings)
        if (intent.trim() === "Select Venue Intent") {
            console.log("DEBUG: Entered SelectVenueIntent block (after trim check).");
            console.log("📥 Raw Params (SelectVenueIntent):", JSON.stringify(params, null, 2));
            console.log("📥 Contexts (SelectVenueIntent):", JSON.stringify(contexts, null, 2));

            try {
                let venueRaw;
                if (Array.isArray(params.venue_name)) {
                    venueRaw = params.venue_name[params.venue_name.length - 1];
                } else {
                    venueRaw = params.venue_name;
                }

                console.log(`DEBUG: SelectVenueIntent - venueRaw (from Dialogflow parameter): ${venueRaw}`);

                const bookingFlowCtx = findContext("booking-flow");
                console.log(`DEBUG: SelectVenueIntent - bookingFlowCtx: ${JSON.stringify(bookingFlowCtx, null, 2)}`);
                let { guestCount, bookingUTC, type, venue: contextVenueName, venue_id: contextVenueId } = bookingFlowCtx?.parameters || {}; // Corrected to venue_id

                if ((!venueRaw || venueRaw === '.') && contextVenueName) {
                    venueRaw = contextVenueName;
                    if (!params.venue_id && contextVenueId) { // Corrected to venue_id
                        params.venue_id = contextVenueId; // Corrected to venue_id
                    }
                    console.log(`DEBUG: SelectVenueIntent - venueRaw pulled from context: ${venueRaw}`);
                }

                console.log(`DEBUG: SelectVenueIntent - guestCount: ${guestCount}, bookingUTC: ${bookingUTC}, type: ${type}`);

                if (!guestCount || !bookingUTC) {
                    console.warn("⚠️ Missing booking details in SelectVenueIntent:", { guestCount, bookingUTC });
                    return res.json({
                        fulfillmentText: `To book ${venueRaw}, I'll also need to know the number of guests, the date, and the time. Could you please provide those details?`,
                        outputContexts: [
                            {
                                name: `${session}/contexts/booking-flow`,
                                lifespanCount: 5,
                                parameters: { venue: venueRaw },
                            },
                        ],
                    });
                }

                const venueName = venueRaw.toLowerCase();
                console.log("🔍 Searching for venue (SelectVenueIntent):", venueName);

                const availableVenues = await getAvailableVenues(guestCount); // Use helper with guestCount
                const match = availableVenues.find(
                    (v) =>
                        v.name &&
                        v.name.toLowerCase() === venueName &&
                        v.standing_capacity >= guestCount
                );

                if (!match) {
                    console.warn(`❌ Venue not matched (SelectVenueIntent): ${venueName} for ${guestCount} guests`);
                    return res.json({
                        fulfillmentText: `Hmm, I couldn’t find that venue for your group size. Could you try another?`,
                    });
                }

                const { date, time } = formatDubai(bookingUTC);

                let prompt;
                let outputContexts = [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: {
                            guestCount,
                            bookingUTC,
                            venue: match.name, // Use match.name
                            venue_id: match.id, // Use match.id
                            type
                        },
                    },
                ];

                if (type === 'group') {
                    // MODIFIED: For group bookings, directly ask for contact details after venue selection
                    prompt = `Great! You've chosen ${match.name} for your group booking of ${guestCount} guests on ${date} at ${time}. Our manager will share pre-curated package options with you. To proceed, could I please get your full name, mobile number, and email address?`;
                    outputContexts.push({
                        name: `${session}/contexts/awaiting-contact-details`, // Direct to contact details
                        lifespanCount: 2,
                    });
                } else {
                    // Original flow for table bookings: Ask for contact details
                    prompt = `The user chose "${match.name}" for their booking of ${guestCount} guests on ${date} at ${time}. Please generate a concise and warm confirmation. Then, immediately ask for their full name, mobile number, and email address to finalize the booking, all in one smooth utterance.`;
                    outputContexts.push({
                        name: `${session}/contexts/awaiting-contact-details`, // Assuming this is the next step for finalization
                        lifespanCount: 2,
                    });
                }
                console.log(`DEBUG: SelectVenueIntent - Gemini prompt: ${prompt}`);
                const reply = await generateGeminiReply(prompt);
                console.log(`DEBUG: SelectVenueIntent - Gemini reply: ${reply}`);

                console.log("DEBUG: About to send response for SelectVenueIntent.");

                return res.json({
                    fulfillmentText: reply,
                    outputContexts: outputContexts,
                });
            } catch (error) {
                console.error("❌ SelectVenueIntent - Unhandled error:", error);
                return res.json({
                    fulfillmentText: "There was a technical issue processing your venue selection. Please try again."
                });
            }
        }

        // ❌ Get Package Details Intent (Removed from active flow for group bookings)
        // This intent block is effectively bypassed now for group bookings.
        if (intent === "Get Package Details") {
            console.log(`DEBUG: Entering Get Package Details Intent. (This should be bypassed for group bookings)`);
            // This logic remains for historical context or if you re-introduce package selection for table bookings.
            return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, we are no longer offering direct package selection through the bot for group bookings. Our manager will assist you with that.") });
        }

        // ❌ Select Packages Intent (Removed from active flow for group bookings)
        // This intent block is effectively bypassed now for group bookings.
        if (intent === "Select Packages Intent") {
            console.log(`DEBUG: Entering Select Packages Intent. (This should be bypassed for group bookings)`);
            return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, we are no longer offering direct package selection through the bot for group bookings. Our manager will assist you with that.") });
        }

        // ❌ Capture Add-ons Intent (Removed from active flow for group bookings)
        // This intent block is effectively bypassed now for group bookings.
        if (intent === "Capture Add-ons Intent" || intent === "No Add-ons Intent") {
            console.log(`DEBUG: Entering Capture Add-ons Intent. (This should be bypassed for group bookings)`);
            return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, we are no longer offering direct add-on selection through the bot for group bookings. Our manager will assist you with that.") });
        }

        // ✅ Capture Contact Details Intent (MODIFIED: Summary for group leads)
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
                return res.json({
                    fulfillmentText: await generateGeminiReply(`I'm missing your ${missingFields.join(', ')}. Could you please provide all of them?`),
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
                // NO packages, add-ons, or total price for group leads here.
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

        // ✅ Confirm Booking Intent (MODIFIED: Handles unified table and group lead creation)
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

        // ✅ Deny Booking Intent (No changes)
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

        // ✅ Restart Booking Intent (No changes)
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

        // ✅ Cancel Booking Intent (No changes)
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

        // Default Fallback Intent handler (No changes)
        if (intent === "Default Fallback Intent") {
            console.log("DEBUG: Entering Default Fallback Intent.");
            const bookingFlowCtx = findContext("booking-flow", inputContexts);
            if (bookingFlowCtx) {
                return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, I didn't understand that. Please tell me more about your booking preference or try rephrasing.") });
            } else {
                return res.json({ fulfillmentText: await generateGeminiReply("I didn't quite catch that. Could you please rephrase or tell me what you'd like to do?") });
            }
        }

        // If intent is not handled
        return res.json({
            fulfillmentText: await generateGeminiReply("I'm not sure how to handle that request yet.")
        });
    } catch (error) {
        console.error("🚨 Unhandled error in webhook:", error);
        return res.status(500).json({
            fulfillmentText: "I'm very sorry, but there was an unexpected error with our booking system. Please try again or contact us directly."
        });
    }
});

// --- Start the Server ---
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
// index.js - Replit Webhook for AI Booking Concierge

const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const moment = require("moment-timezone");
const nodemailer = require("nodemailer"); // For sending emails
let fetch; // Declare fetch here, it will be assigned dynamically

// Use an immediately invoked async function to import node-fetch
// This is a workaround for ERR_REQUIRE_ESM when using require() in a CommonJS context
// with a module that is ESM-only.
(async () => {
    fetch = (await import('node-fetch')).default;
})();


dotenv.config(); // Load environment variables from .env file
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse JSON request bodies

// --- Environment Variables ---
// IMPORTANT: Ensure these are set in your .env file on Glitch based on your Airtable setup:
// BASE_ID=YOUR_AIRTABLE_BASE_ID (e.g., appXXXXXXXXXXXXXX)
// AIRTABLE_TOKEN=YOUR_AIRTABLE_API_KEY (e.g., patXXXXXXXXXXXXXX)
// AIRTABLE_VENUES_TABLE_ID=YOUR_VENTABLE_ID (e.g., tblXXXXXXXXXXXXXX - from your "Venues" table)
// AIRTABLE_PACKAGES_TABLE_ID=YOUR_PACKAGES_TABLE_ID (e.g., tblYYYYYYYYYYYYYY - from your "Packages" table)
// AIRTABLE_ADDONS_TABLE_ID=YOUR_ADDONS_TABLE_ID (e.g., tblZZZZZZZZZZZZZZ - from your "Add-Ons" table)
// AIRTABLE_BOOKINGS_TABLE_ID=YOUR_BOOKINGS_TABLE_ID (e.g., tblAAAAAAAAAAAAAA - from your "Bookings" table)
// AIRTABLE_BOOKING_ADDONS_TABLE_ID=YOUR_BOOKING_ADDONS_TABLE_ID (e.g., tblBBBBBBBBBBBBBB - from your "Booking_Addons" table)
// GEMINI_API_KEY=YOUR_GEMINI_API_KEY
// EMAIL_SERVICE_HOST=smtp.zoho.com
// EMAIL_SERVICE_PORT=587
// EMAIL_SERVICE_USER=your_zoho_email@yourdomain.com
// EMAIL_SERVICE_PASS=your_zoho_app_password_or_regular_password
// PDF_URL=https://your-domain.com/your-packages.pdf

// --- Airtable Configuration ---
const Airtable = require('airtable'); // Re-declare Airtable here to ensure it's configured
Airtable.configure({
    apiKey: process.env.AIRTABLE_TOKEN, // Using AIRTABLE_TOKEN as per your old code
});
const base = Airtable.base(process.env.BASE_ID); // Using BASE_ID as per your old code


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

// 🔹 Fetch venues from Airtable
/**
 * Fetches available venues from Airtable based on guest count.
 * @param {number} guestCount - The number of guests for the booking.
 * @returns {Promise<Array<object>>} - An array of available venue objects.
 */
async function getAvailableVenues(guestCount) {
    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_VENUES_TABLE_ID}`;
    const cfg = {
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
    };
    try {
        const resp = await axios.get(url, cfg);
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

// 🔹 Fetch available packages from Airtable (Kept for reference, but not used in group flow)
/**
 * Fetches available packages and their details from Airtable.
 * @returns {Promise<Array<object>>} - An array of package objects with name, price, etc.
 */
async function getAvailablePackages() {
    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_PACKAGES_TABLE_ID}`;
    const cfg = {
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
    };
    try {
        const resp = await axios.get(url, cfg);
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

// 🔹 Fetch available add-ons from Airtable (Kept for reference, but not used in group flow)
/**
 * Fetches available add-ons and their prices from Airtable.
 * @returns {Promise<Array<object>>} - An array of add-on objects with name and price.
 */
async function getAvailableAddOns() {
    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_ADDONS_TABLE_ID}`;
    const cfg = {
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
    };
    try {
        const resp = await axios.get(url, cfg);
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

// 🔹 Format UTC time into Dubai time
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

// 🔹 Convert booking date/time to UTC from Dubai
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

// 🔹 Gemini-powered AI response generator
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
        // Ensure fetch is available before calling
        if (!fetch) {
            console.error("❌ fetch is not initialized. Waiting for dynamic import.");
            return "There was a technical issue. Please try again shortly.";
        }

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const data = await response.json();

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

// 🔹 Create a new booking record in the "Bookings" table (MODIFIED for unified table and group lead)
/**
 * Creates a new booking record in the main "Bookings" Airtable table.
 * @param {object} bookingDetails - Object containing all booking and customer details.
 * @param {string} status - The status to set for the booking (e.g., 'Confirmed', 'New Lead').
 * @returns {Promise<object>} - The created record from Airtable.
 */
async function createBooking(bookingDetails, status) {
    console.log("Attempting to create booking with details:", JSON.stringify(bookingDetails, null, 2));

    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_BOOKINGS_TABLE_ID}`;
    const cfg = {
        headers: {
            Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };

    const now = moment();
    const formattedCreatedDate = now.format("M/D/YYYY h:mma"); // e.g., "6/25/2025 3:45pm"
    const storageTimeUtc = now.toISOString(); // ISO string for UTC storage time

    const { date: formattedBookingDate, time: formattedBookingTime, local_datetime: eventTimeLocal } = formatDubai(bookingDetails.bookingUTC);
    const eventDateTime = `${formattedBookingDate} ${formattedBookingTime}`; // e.g., "5 July 2025 8:30pm"

    const fields = {
        created_date: formattedCreatedDate,
        guest_name: bookingDetails.full_name,
        phone_no: bookingDetails.phone_number, // Corrected to phone_number as per Dialogflow
        email: bookingDetails.email_id,
        booking_type: bookingDetails.type === 'table' ? 'Table Booking' : 'Group Booking', // Map 'type' to 'booking_type'
        event_date_time: eventDateTime, // Combined date and time string
        guest_count: bookingDetails.guestCount, // Corrected to guestCount
        status: status, // Status passed dynamically
        event_time_local: eventTimeLocal, // Local Dubai time
        storage_time_utc: storageTimeUtc, // UTC time of storage
    };

    // Add venue details
    if (bookingDetails.venue) {
        fields.space_name = bookingDetails.venue; // Matches CSV 'space_name'
        if (bookingDetails.venue_id) { // Corrected to venue_id
            fields.space_id = [bookingDetails.venue_id]; // Ensure this is an array for linked records
        }
    }

    // Handle package, add-on, and grand total based on booking type
    if (bookingDetails.type === 'table') {
        // These fields are populated for table bookings if they were collected
        if (bookingDetails.packages && bookingDetails.packages.length > 0) {
            fields.package_name = Array.isArray(bookingDetails.packages) ? bookingDetails.packages.join(', ') : bookingDetails.packages;
        }
        if (bookingDetails.package_ids && bookingDetails.package_ids.length > 0) {
            fields.package_id = bookingDetails.package_ids;
        }
        if (bookingDetails.selected_add_ons && bookingDetails.selected_add_ons.length > 0) {
            fields.selected_add_ons = Array.isArray(bookingDetails.selected_add_ons) ? bookingDetails.selected_add_ons.join(', ') : bookingDetails.selected_add_ons;
        }
        fields.grand_total = bookingDetails.grand_total || 0; // Ensure this is a number
    } else if (bookingDetails.type === 'group') {
        // For group leads, explicitly set these to null/empty to ensure they are blank in Airtable
        fields.package_name = null;
        fields.package_id = null;
        fields.selected_add_ons = null;
        fields.grand_total = null;
    }

    const data = { records: [{ fields }] };
    try {
        const response = await axios.post(url, data, cfg);
        console.log('Booking successful:', response.data.records[0].id);
        return response.data.records[0]; // Return the created record
    } catch (error) {
        console.error('Error creating booking:', error.response ? error.response.data : error.message);
        throw new Error('Failed to create booking.');
    }
}

// 🔹 Create records in the "Booking_Addons" table for selected add-ons (Kept for table bookings if needed)
/**
 * Creates records in the "Booking_Addons" table for each selected add-on,
 * linking them to the main booking record.
 * @param {string} bookingRecordId - The Airtable record ID of the main booking.
 * @param {Array<string>} selectedAddOnNames - An array of names of selected add-ons.
 * @param {Array<object>} availableAddOns - The list of all available add-ons with their details.
 * @returns {Promise<void>}
 */
async function createBookingAddons(bookingRecordId, selectedAddOnNames, availableAddOns) {
    if (!selectedAddOnNames || selectedAddOnNames.length === 0) {
        return; // No add-ons to record
    }

    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_BOOKING_ADDONS_TABLE_ID}`;
    const cfg = {
        headers: {
            Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };

    const recordsToCreate = [];
    selectedAddOnNames.forEach(addOnName => {
        const addOnDetail = availableAddOns.find(ao => ao.name.toLowerCase() === addOnName.toLowerCase());
        if (addOnDetail) {
            recordsToCreate.push({
                fields: {
                    booking_id: [bookingRecordId], // Link to the main booking record
                    add_on_id: [addOnDetail.id], // Link to the Add-Ons record
                    quantity: 1, // Assuming quantity is 1 for now, adjust if user can specify
                    price: addOnDetail.price,
                    total_price: addOnDetail.price, // For single quantity, total price is item price
                    active: true // Or whatever default status you need
                }
            });
        } else {
            console.warn(`Selected add-on "${addOnName}" not found in available add-ons. Skipping.`);
        }
    });

    if (recordsToCreate.length > 0) {
        try {
            await axios.post(url, { records: recordsToCreate }, cfg);
            console.log(`Successfully recorded ${recordsToCreate.length} add-on(s) for booking ${bookingRecordId}.`);
        } catch (error) {
            console.error('Error creating booking add-ons:', error.response ? error.response.data : error.message);
            throw new Error('Failed to create booking add-ons.');
        }
    }
}


// 🔹 Dialogflow Webhook Endpoint
app.post("/webhook", async (req, res) => {
    const dialogflowRequest = req.body;
    const intent = dialogflowRequest.queryResult.intent.displayName;
    const session = dialogflowRequest.session;
    const params = dialogflowRequest.queryResult.parameters;
    const contexts = dialogflowRequest.queryResult.outputContexts || [];

    // Helper to find a context by its display name
    const findContext = (contextName) => {
        return contexts.find((c) => c.name.endsWith(`/contexts/${contextName}`));
    };

    // Log the exact intent string and its length for debugging
    console.log(`DEBUG: Webhook received intent (exact): "${intent}" (length: ${intent.length})`);

    try { // START OF MAIN TRY BLOCK FOR WEBHOOK
        // ✅ Welcome Intent (Reverted to simple greeting)
        if (intent === "Welcome Intent") {
            console.log("DEBUG: Entering Welcome Intent.");
            const venues = await getAvailableVenues(); // Get all venues, no guest count filter yet
            const venueNames = venues.map(v => v.name).join(', ');
            return res.json({
                fulfillmentText: `Hello! Welcome to our booking service. We offer bookings for ${venueNames}. Are you looking to book a table or a group event with packages?`,
                outputContexts: [{
                    name: `${session}/contexts/awaiting-booking-type`,
                    lifespanCount: 5
                }]
            });
        }

        // ✅ Booking Intent - Initial booking request (Restored original logic with group lead modifications)
        if (intent === "Booking Intent") {
            console.log("DEBUG: Entering Booking Intent.");

            let guestCount = Array.isArray(params.guestCount) ? params.guestCount[0] : params.guestCount;
            const rawBookingDate = Array.isArray(params.bookingdate) ? params.bookingdate[0] : params.bookingdate;
            let rawBookingTime;
            if (Array.isArray(params.bookingtime)) {
                rawBookingTime = params.bookingtime[params.bookingtime.length - 1];
            } else {
                rawBookingTime = params.bookingtime;
            }

            console.log(`DEBUG: rawBookingDate (from Dialogflow): ${rawBookingDate}`);
            console.log(`DEBUG: bookingDateOnly (formatted): ${moment(rawBookingDate).format("YYYY-MM-DD")}`);
            console.log(`DEBUG: rawBookingTime (from Dialogflow parameter): ${rawBookingTime}`);
            console.log(`DEBUG: params.bookingtime.original: ${JSON.stringify(params.bookingtime?.original)}`);

            let bookingTimeStr;
            const timeStartIndex = rawBookingTime.indexOf('T') + 1;
            const timeEndIndex = rawBookingTime.indexOf('+');
            if (timeStartIndex !== -1 && timeEndIndex !== -1 && timeEndIndex > timeStartIndex) {
                bookingTimeStr = rawBookingTime.substring(timeStartIndex, timeEndIndex).substring(0, 5); // Get "HH:mm"
            } else {
                bookingTimeStr = moment(rawBookingTime).format("HH:mm");
                console.warn(`WARN: Fallback time parsing used for rawBookingTime: ${rawBookingTime}`);
            }

            console.log(`DEBUG: bookingTimeStr (extracted for buildDubaiUTC): ${bookingTimeStr}`);

            const bookingUTC = buildDubaiUTC(moment(rawBookingDate).format("YYYY-MM-DD"), bookingTimeStr);
            const { date, time } = formatDubai(bookingUTC);

            const category = guestCount <= 10 ? "a general reservation" : "a group booking";
            const venues = await getAvailableVenues(guestCount);

            const prompt = venues.length
                ? `A user requested ${category} for ${guestCount} guests on ${date} at ${time}. Available venues: ${venues
                    .map((v) => v.name)
                    .join(", ")}. Write a short, helpful spoken-style response suitable for a phone booking. Mention the venue options clearly and ask the user if any of those work for them.`
                : `No venues available for ${guestCount} guests on ${date} at ${time}. Kindly offer an apology in a friendly, spoken tone.`;

            const reply = await generateGeminiReply(prompt);

            console.log("DEBUG: About to send response for Booking Intent.");

            return res.json({
                fulfillmentText: reply,
                outputContexts: [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: { guestCount, bookingUTC, type: category === "a general reservation" ? "table" : "group" }, // Store booking type
                    },
                    {
                        name: `${session}/contexts/awaiting-venue-selection`, // Direct to venue selection
                        lifespanCount: 2
                    }
                ],
            });
        }

        // ✅ Modify Booking Intent (No changes)
        if (intent === "ModifyBookingIntent") {
            const bookingFlowCtx = findContext("booking-flow");
            let { guestCount, bookingUTC, type } = bookingFlowCtx?.parameters || {};

            let currentDubaiMoment = moment.utc(bookingUTC).tz("Asia/Dubai");
            let currentDubaiDate = currentDubaiMoment.format("YYYY-MM-DD");
            let currentDubaiTime = currentDubaiMoment.format("HH:mm");

            let { newGuestCount, newDate, newTime } = params;

            console.log(`DEBUG (Modify): Initial guestCount: ${guestCount}, bookingUTC: ${bookingUTC}`);
            console.log(`DEBUG (Modify): newGuestCount: ${newGuestCount}, newDate: ${newDate}, newTime: ${newTime}`);
            console.log(`DEBUG (Modify): params.newTime.original: ${JSON.stringify(params.newTime?.original)}`);

            if (!newGuestCount && !newDate && !newTime) {
                return res.json({
                    fulfillmentText:
                        "What would you like to change — guest count, date, or time?",
                    outputContexts: [
                        {
                            name: `${session}/contexts/awaiting-modify-slot`,
                            lifespanCount: 1,
                        },
                        {
                            name: `${session}/contexts/booking-flow`,
                            lifespanCount: 5,
                            parameters: { guestCount, bookingUTC, type },
                        },
                    ],
                });
            }

            if (newGuestCount) guestCount = newGuestCount;
            if (newDate) {
                currentDubaiDate = moment(newDate).format("YYYY-MM-DD");
            }
            if (newTime) {
                const timeStartIndex = newTime.indexOf('T') + 1;
                const timeEndIndex = newTime.indexOf('+');
                if (timeStartIndex !== -1 && timeEndIndex !== -1 && timeEndIndex > timeStartIndex) {
                    currentDubaiTime = newTime.substring(timeStartIndex, timeEndIndex).substring(0, 5);
                } else {
                    currentDubaiTime = moment(newTime).format("HH:mm");
                    console.warn(`WARN: Fallback time parsing used for newTime: ${newTime}`);
                }
                console.log(`DEBUG (Modify): currentDubaiTime (extracted for buildDubaiUTC): ${currentDubaiTime}`);
            }

            bookingUTC = buildDubaiUTC(currentDubaiDate, currentDubaiTime);

            const { date, time } = formatDubai(bookingUTC);
            const venues = await getAvailableVenues(guestCount);

            const prompt = venues.length
                ? `The user updated the booking to ${guestCount} guests on ${date} at ${time}. Available venues: ${venues
                    .map((v) => v.name)
                    .join(", ")}. Respond in a clear, conversational tone.`
                : `After the change, no suitable venues found. Kindly inform the user in a warm, helpful voice.`;

            const reply = await generateGeminiReply(prompt);

            return res.json({
                fulfillmentText: reply,
                outputContexts: [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: { guestCount, bookingUTC, type },
                    },
                ],
            });
        }

        // ✅ Ask Venue Details Intent (No changes)
        if (intent === "Ask Venue Details Intent") {
            console.log(`DEBUG: Entering AskVenueDetailsIntent`);
            let venueRaw;
            if (Array.isArray(params.venue_name)) {
                venueRaw = params.venue_name[params.venue_name.length - 1];
            } else {
                venueRaw = params.venue_name;
            }
            venueRaw = venueRaw || params.venueName;

            console.log(`DEBUG: AskVenueDetailsIntent - venueRaw (after array check): ${venueRaw}`);

            if (!venueRaw) {
                console.log(`DEBUG: AskVenueDetailsIntent - No venueRaw found.`);
                return res.json({
                    fulfillmentText: `I couldn't catch the venue name. Could you say it again?`,
                });
            }

            const venueName = venueRaw.toLowerCase();
            const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_VENUES_TABLE_ID}`;
            const cfg = {
                headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
            };
            let resp;
            try {
                resp = await axios.get(url, cfg);
                console.log(`DEBUG: AskVenueDetailsIntent - Fetched venues from Airtable.`);
            } catch (error) {
                console.error("❌ AskVenueDetailsIntent - Error fetching venues from Airtable:", error.message);
                return res.json({
                    fulfillmentText: "There was a problem fetching venue details. Please try again."
                });
            }

            const match = resp.data.records.find(
                (r) =>
                    r.fields.space_name &&
                    r.fields.space_name.toLowerCase() === venueName
            );

            if (!match) {
                console.log(`DEBUG: AskVenueDetailsIntent - No match found for venue: ${venueName}`);
                return res.json({
                    fulfillmentText: `Sorry, I couldn't find details for "${venueRaw}".`,
                });
            }

            const venue = match.fields;
            const prompt = `The user asked for details about the venue "${venue.space_name}". The standing capacity is ${venue.standing_capacity}. Here is the description: ${venue.description || "No description provided."} As a helpful booking concierge, explain this information clearly to the user. Do NOT ask any follow up questions.`;

            console.log(`DEBUG: AskVenueDetailsIntent - Gemini prompt: ${prompt}`);
            const reply = await generateGeminiReply(prompt);
            console.log(`DEBUG: AskVenueDetailsIntent - Gemini reply: ${reply}`);

            return res.json({
                fulfillmentText: reply,
                outputContexts: [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: {
                            venue: venue.space_name,
                            venue_id: match.id, // Changed from space_id to venue_id for consistency
                        },
                    },
                ],
            });
        }

        // ✅ Select Venue Intent (MODIFIED: Streamlined for group bookings)
        if (intent.trim() === "Select Venue Intent") {
            console.log("DEBUG: Entered SelectVenueIntent block (after trim check).");
            console.log("📥 Raw Params (SelectVenueIntent):", JSON.stringify(params, null, 2));
            console.log("📥 Contexts (SelectVenueIntent):", JSON.stringify(contexts, null, 2));

            try {
                let venueRaw;
                if (Array.isArray(params.venue_name)) {
                    venueRaw = params.venue_name[params.venue_name.length - 1];
                } else {
                    venueRaw = params.venue_name;
                }

                console.log(`DEBUG: SelectVenueIntent - venueRaw (from Dialogflow parameter): ${venueRaw}`);

                const bookingFlowCtx = findContext("booking-flow");
                console.log(`DEBUG: SelectVenueIntent - bookingFlowCtx: ${JSON.stringify(bookingFlowCtx, null, 2)}`);
                let { guestCount, bookingUTC, type, venue: contextVenueName, venue_id: contextVenueId } = bookingFlowCtx?.parameters || {}; // Corrected to venue_id

                if ((!venueRaw || venueRaw === '.') && contextVenueName) {
                    venueRaw = contextVenueName;
                    if (!params.venue_id && contextVenueId) { // Corrected to venue_id
                        params.venue_id = contextVenueId; // Corrected to venue_id
                    }
                    console.log(`DEBUG: SelectVenueIntent - venueRaw pulled from context: ${venueRaw}`);
                }

                console.log(`DEBUG: SelectVenueIntent - guestCount: ${guestCount}, bookingUTC: ${bookingUTC}, type: ${type}`);

                if (!guestCount || !bookingUTC) {
                    console.warn("⚠️ Missing booking details in SelectVenueIntent:", { guestCount, bookingUTC });
                    return res.json({
                        fulfillmentText: `To book ${venueRaw}, I'll also need to know the number of guests, the date, and the time. Could you please provide those details?`,
                        outputContexts: [
                            {
                                name: `${session}/contexts/booking-flow`,
                                lifespanCount: 5,
                                parameters: { venue: venueRaw },
                            },
                        ],
                    });
                }

                const venueName = venueRaw.toLowerCase();
                console.log("🔍 Searching for venue (SelectVenueIntent):", venueName);

                const availableVenues = await getAvailableVenues(guestCount); // Use helper with guestCount
                const match = availableVenues.find(
                    (v) =>
                        v.name &&
                        v.name.toLowerCase() === venueName &&
                        v.standing_capacity >= guestCount
                );

                if (!match) {
                    console.warn(`❌ Venue not matched (SelectVenueIntent): ${venueName} for ${guestCount} guests`);
                    return res.json({
                        fulfillmentText: `Hmm, I couldn’t find that venue for your group size. Could you try another?`,
                    });
                }

                const { date, time } = formatDubai(bookingUTC);

                let prompt;
                let outputContexts = [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: {
                            guestCount,
                            bookingUTC,
                            venue: match.name, // Use match.name
                            venue_id: match.id, // Use match.id
                            type
                        },
                    },
                ];

                if (type === 'group') {
                    // MODIFIED: For group bookings, directly ask for contact details after venue selection
                    prompt = `Great! You've chosen ${match.name} for your group booking of ${guestCount} guests on ${date} at ${time}. Our manager will share pre-curated package options with you. To proceed, could I please get your full name, mobile number, and email address?`;
                    outputContexts.push({
                        name: `${session}/contexts/awaiting-contact-details`, // Direct to contact details
                        lifespanCount: 2,
                    });
                } else {
                    // Original flow for table bookings: Ask for contact details
                    prompt = `The user chose "${match.name}" for their booking of ${guestCount} guests on ${date} at ${time}. Please generate a concise and warm confirmation. Then, immediately ask for their full name, mobile number, and email address to finalize the booking, all in one smooth utterance.`;
                    outputContexts.push({
                        name: `${session}/contexts/awaiting-contact-details`, // Assuming this is the next step for finalization
                        lifespanCount: 2,
                    });
                }
                console.log(`DEBUG: SelectVenueIntent - Gemini prompt: ${prompt}`);
                const reply = await generateGeminiReply(prompt);
                console.log(`DEBUG: SelectVenueIntent - Gemini reply: ${reply}`);

                console.log("DEBUG: About to send response for SelectVenueIntent.");

                return res.json({
                    fulfillmentText: reply,
                    outputContexts: outputContexts,
                });
            } catch (error) {
                console.error("❌ SelectVenueIntent - Unhandled error:", error);
                return res.json({
                    fulfillmentText: "There was a technical issue processing your venue selection. Please try again."
                });
            }
        }

        // ❌ Get Package Details Intent (Removed from active flow for group bookings)
        // This intent block is effectively bypassed now for group bookings.
        if (intent === "Get Package Details") {
            console.log(`DEBUG: Entering Get Package Details Intent. (This should be bypassed for group bookings)`);
            // This logic remains for historical context or if you re-introduce package selection for table bookings.
            return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, we are no longer offering direct package selection through the bot for group bookings. Our manager will assist you with that.") });
        }

        // ❌ Select Packages Intent (Removed from active flow for group bookings)
        // This intent block is effectively bypassed now for group bookings.
        if (intent === "Select Packages Intent") {
            console.log(`DEBUG: Entering Select Packages Intent. (This should be bypassed for group bookings)`);
            return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, we are no longer offering direct package selection through the bot for group bookings. Our manager will assist you with that.") });
        }

        // ❌ Capture Add-ons Intent (Removed from active flow for group bookings)
        // This intent block is effectively bypassed now for group bookings.
        if (intent === "Capture Add-ons Intent" || intent === "No Add-ons Intent") {
            console.log(`DEBUG: Entering Capture Add-ons Intent. (This should be bypassed for group bookings)`);
            return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, we are no longer offering direct add-on selection through the bot for group bookings. Our manager will assist you with that.") });
        }

        // ✅ Capture Contact Details Intent (MODIFIED: Summary for group leads)
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
                return res.json({
                    fulfillmentText: await generateGeminiReply(`I'm missing your ${missingFields.join(', ')}. Could you please provide all of them?`),
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
                // NO packages, add-ons, or total price for group leads here.
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

        // ✅ Confirm Booking Intent (MODIFIED: Handles unified table and group lead creation)
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

        // ✅ Deny Booking Intent (No changes)
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

        // ✅ Restart Booking Intent (No changes)
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

        // ✅ Cancel Booking Intent (No changes)
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

        // Default Fallback Intent handler (No changes)
        if (intent === "Default Fallback Intent") {
            console.log("DEBUG: Entering Default Fallback Intent.");
            const bookingFlowCtx = findContext("booking-flow", inputContexts);
            if (bookingFlowCtx) {
                return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, I didn't understand that. Please tell me more about your booking preference or try rephrasing.") });
            } else {
                return res.json({ fulfillmentText: await generateGeminiReply("I didn't quite catch that. Could you please rephrase or tell me what you'd like to do?") });
            }
        }

        // If intent is not handled
        return res.json({
            fulfillmentText: await generateGeminiReply("I'm not sure how to handle that request yet.")
        });
    } catch (error) {
        console.error("🚨 Unhandled error in webhook:", error);
        return res.status(500).json({
            fulfillmentText: "I'm very sorry, but there was an unexpected error with our booking system. Please try again or contact us directly."
        });
    }
});

// --- Start the Server ---
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
