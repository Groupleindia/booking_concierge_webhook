// index.js - Replit Webhook for AI Booking Concierge

const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const moment = require("moment-timezone");
const nodemailer = require('nodemailer'); // NEW: For sending emails

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
// AIRTABLE_BOOKINGS_TABLE_ID=YOUR_BOOKTABLE_ID (e.g., tblAAAAAAAAAAAAAA - from your "Bookings" table)
// GEMINI_API_KEY=YOUR_GEMINI_API_KEY
// EMAIL_SERVICE_HOST=smtp.zoho.com
// EMAIL_SERVICE_PORT=587
// EMAIL_SERVICE_USER=your_zoho_email@yourdomain.com
// EMAIL_SERVICE_PASS=your_zoho_app_password_or_regular_password
// PDF_URL=https://your-domain.com/your-packages.pdf (This PDF URL will still be used in the email for group leads if you want to send it)

// 🔹 Fetch venues from Airtable
/**
 * Fetches available venues from Airtable based on guest count.
 * MODIFIED: Now filters by seated_capacity instead of standing_capacity.
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
      .filter((r) => guestCount ? r.fields.seated_capacity >= guestCount : true) // Filter by seated_capacity
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

// REMOVED: 🔹 Fetch available packages from Airtable (getAvailablePackages)
// REMOVED: 🔹 Fetch available add-ons from Airtable (getAvailableAddOns)


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
        console.log(`DEBUG: Parameter '${paramName}' found in current intent parameters. Value: ${JSON.stringify(queryResult.parameters[paramName])}`); // Added value logging
        return queryResult.parameters[paramName];
    }
    // Check parameters from input contexts
    if (queryResult.outputContexts) {
        for (const context of queryResult.outputContexts) {
            if (context.parameters && context.parameters[paramName]) {
                console.log(`DEBUG: Parameter '${paramName}' found in output context: ${context.name}. Value: ${JSON.stringify(context.parameters[paramName])}`); // Added value logging
                return context.parameters[paramName];
            }
        }
    }
    console.log(`DEBUG: Parameter '${paramName}' not found.`);
    return undefined;
}

// 🔹 Gemini-powered AI response generator
/**
 * Calls the Gemini API to generate natural language responses.
 * Adds a specific tone instruction to the prompt.
 * @param {string} prompt - The prompt to send to the Gemini API.
 * @param {boolean} [isSummaryConfirmation=false] - If true, adjusts tone for summary confirmation.
 * @returns {Promise<string>} - The generated text response.
 */
async function generateGeminiReply(prompt, isSummaryConfirmation = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  let toneInstruction;
  if (isSummaryConfirmation) {
      // For summary, explicitly tell Gemini to reiterate and then ask for confirmation
      // CHANGED TO BACKTICKS
      toneInstruction = `\n\nTone: Use a warm, conversational voice. Be helpful and clear. Avoid emojis and technical terms. **IMPORTANT: Reiterate the provided summary exactly as given, and then ask "Is this all correct? (Yes/No)". Do NOT just respond with "Yes" or "No".**`;
  } else {
      // General tone instruction
      // CHANGED TO BACKTICKS
      toneInstruction = `\n\nTone: You are the official booking concierge for the venue. Use a warm, professional, and helpful voice. Speak directly to the user. Do NOT use phrases like "Here's what I know," "It sounds like," or "I understand." Avoid emojis, technical terms, and overly conversational fillers. Be concise. **IMPORTANT: Stick ONLY to the information and questions explicitly contained in the prompt. Do NOT add any extra information, suggestions, or unrequested follow-up questions (e.g., about preferences like "vibe" or "cuisine"). When provided with a list of options, you MUST list ALL of them clearly and explicitly, without filtering or summarizing. Just present the list and ask if any work.**`;
  }

  const payload = {
    contents: [
      {
        parts: [
          {
            text: prompt + toneInstruction,
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

// 🔹 Send Email with PDF (for group leads)
async function sendEmailWithPdf(recipientEmail, recipientName) {
    if (!process.env.EMAIL_SERVICE_USER || !process.env.EMAIL_SERVICE_PASS || !process.env.EMAIL_SERVICE_HOST || !process.env.EMAIL_SERVICE_PORT) {
        console.warn("⚠️ Email service credentials missing. Skipping email send.");
        return false;
    }
    if (!process.env.PDF_URL) {
        console.warn("⚠️ PDF_URL is not set. Cannot attach PDF. Skipping email send.");
        return false;
    }

    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_SERVICE_HOST,
        port: parseInt(process.env.EMAIL_SERVICE_PORT),
        secure: process.env.EMAIL_SERVICE_PORT === '465', // Use 'true' if port is 465, 'false' for 587 or 25
        auth: {
            user: process.env.EMAIL_SERVICE_USER,
            pass: process.env.EMAIL_SERVICE_PASS,
        },
    });

    const mailOptions = {
        from: process.env.EMAIL_SERVICE_USER,
        to: recipientEmail,
        subject: 'Your Group Booking Inquiry Details',
        html: `
            <p>Dear ${recipientName},</p>
            <p>Thank you for your group booking inquiry. Our manager will be in touch with you shortly to discuss your event details and help you finalize your selection.</p>
            <p>In the meantime, you can review our event packages here:</p>
            <p><a href="${process.env.PDF_URL}">Download Our Event Packages PDF</a></p>
            <p>We look forward to hosting your event!</p>
            <p>Best regards,<br>The Booking Team</p>
        `,
        attachments: [
            {
                filename: 'EventPackages.pdf',
                path: process.env.PDF_URL // Nodemailer will fetch this URL
            }
        ]
    };

    try {
        let info = await transporter.sendMail(mailOptions);
        console.log(`📧 Email sent successfully to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error(`❌ Error sending email to ${recipientEmail}:`, error);
        return false;
    }
}


// 🔹 Create a new booking record in the "Bookings" table (MODIFIED: No package/add-on fields)
/**
 * Creates a new booking record in the main "Bookings" Airtable table.
 * @param {object} bookingDetails - Object containing all booking and customer details.
 * @param {string} status - The status to set for the booking (e.g., 'Confirmed', 'New Lead').
 * @returns {Promise<object>} - The created record from Airtable.
*/
async function createBooking(bookingDetails, status) {
  try {
    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_BOOKINGS_TABLE_ID}`;
    const cfg = {
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    const now = moment();
    // const storageTimeUtc = now.toISOString(); // Removed: This field is computed in Airtable

    const { date: formattedBookingDate, time: formattedBookingTime, local_datetime: eventTimeLocal } = formatDubai(bookingDetails.bookingUTC);
    const eventDateTime = `${formattedBookingDate} ${formattedBookingTime}`; // e.g., "Wednesday, 2 July 9:00 PM"

    // Prepare fields for Airtable
    const fields = {
      guest_name: bookingDetails.full_name,
      phone_no: bookingDetails.mobile_number,
      email: bookingDetails.email_id,
      // MODIFIED: 'Table Booking' changed to 'General Reservation'
      booking_type: bookingDetails.type === 'table' ? 'General Reservation' : 'Group Booking',
      event_date_time: eventDateTime, // Combined date and time string
      guest_count: bookingDetails.guestCount, // Corrected from guest_count to guestCount
      "Status": status, // CHANGED: From 'Booking Status' to 'Status' to match CSV
      event_time_local: eventTimeLocal, // Local Dubai time in YYYY-MM-DD HH:mm:ss
      // storage_time_utc: storageTimeUtc, // Removed: This field is computed in Airtable
    };

    // Add venue details
    if (bookingDetails.venue) {
      fields.space_name = bookingDetails.venue; // Matches CSV 'space_name'
      if (bookingDetails.venue_id) { // Corrected from space_id to venue_id as per context
        fields.space_id = [bookingDetails.venue_id]; // Ensure this is an array for linked records
      }
    }

    // Explicitly set package and add-on related fields to null for ALL bookings
    fields.package_name = null;
    fields.package_id = null;
    fields.selected_add_ons = null;
    fields.grand_total = null; // No grand total calculated by bot anymore

    const data = { records: [{ fields }] };
    const response = await axios.post(url, data, cfg);
    console.log('Booking successful:', response.data.records[0].id);
    return response.data.records[0]; // Return the created record
  } catch (error) {
    console.error('Error creating booking:', error.response ? error.response.data : error.message);
    throw new Error('Failed to create booking.');
  }
}

// REMOVED: 🔹 Create records in the "Booking_Addons" table for selected add-ons (createBookingAddons)


// 🔹 Dialogflow Webhook Endpoint
app.post("/webhook", async (req, res) => {
  const intent = req.body.queryResult.intent.displayName;
  const session = req.body.session;
  const params = req.body.queryResult.parameters;
  const contexts = req.body.queryResult.outputContexts || [];

  // Helper to find a context by its display name
  const findContext = (contextName) => {
    return contexts.find((c) => c.name.endsWith(`/contexts/${contextName}`));
  };

  // Log the exact intent string and its length for debugging
  console.log(`DEBUG: Webhook received intent (exact): "${intent}" (length: ${intent.length})`);

  try { // START OF MAIN TRY BLOCK FOR WEBHOOK
    // ✅ Welcome Intent (MODIFIED: All fulfillment text from Gemini)
    if (intent === "Welcome Intent") {
        console.log("DEBUG: Entering Welcome Intent.");
        const venues = await getAvailableVenues(); // Get all venues, no guest count filter yet
        const venueNames = venues.map(v => v.name).join(', ');
        const prompt = `Hello! Welcome to our booking service. We offer bookings for ${venueNames}. Are you looking to book a table or a group event?`;
        return res.json({
            fulfillmentText: await generateGeminiReply(prompt), // Now uses Gemini
            outputContexts: [{
                name: `${session}/contexts/awaiting-booking-type`,
                lifespanCount: 5
            }]
        });
    }

    // ✅ Booking Intent (MODIFIED: Handles flexible initial parameters)
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

        let fulfillmentText;
        let outputContexts = [];
        let bookingType;
        let currentBookingDetails = {};

        // Scenario 1: All initial parameters (guest count, date, time) are provided
        if (guestCount && rawBookingDate && rawBookingTime) {
            console.log("DEBUG: Booking Intent - All parameters provided.");
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

            const venues = await getAvailableVenues(guestCount); // Filtered by seated_capacity
            const venueNames = venues.map(v => v.name).join(', ');

            // MODIFIED PROMPT: Explicitly ask Gemini to list all venues and forbid filtering
            fulfillmentText = await generateGeminiReply(`Got it! For ${guestCount} guests, which implies a ${bookingType} booking, on ${formatDubai(bookingUTC).date} at ${formatDubai(bookingUTC).time}. Which venue would you like to book? Here are our options: ${venueNames}. Please list ALL of these options clearly to the user and ask if any of these work for them. Do NOT filter or ask about preferences like 'vibe'.`);

            outputContexts.push({
                name: `${session}/contexts/booking-flow`,
                lifespanCount: 5,
                parameters: currentBookingDetails // Store all initial details
            });
            outputContexts.push({
                name: `${session}/contexts/awaiting-venue-selection`, // Direct to venue selection
                lifespanCount: 2
            });

        }
        // Scenario 2: Only date and time are provided (e.g., "I want to book an event on 29th July")
        else if (rawBookingDate && rawBookingTime) {
            console.log("DEBUG: Booking Intent - Only date and time provided.");
            const bookingDateOnly = moment(rawBookingDate).format("YYYY-MM-DD");
            let bookingTimeStr;
            const timeStartIndex = rawBookingTime.indexOf('T') + 1;
            const timeEndIndex = rawBookingTime.indexOf('+');
            if (timeStartIndex !== -1 && timeEndIndex !== -1 && timeEndIndex > timeStartIndex) {
                bookingTimeStr = rawBookingTime.substring(timeStartIndex, timeEndIndex).substring(0, 5);
            } else {
                bookingTimeStr = moment(rawBookingTime).format("HH:mm");
            }
            const bookingUTC = buildDubaiUTC(bookingDateOnly, bookingTimeStr);

            currentBookingDetails.bookingDate = bookingDateOnly;
            currentBookingDetails.bookingTime = bookingTimeStr;
            currentBookingDetails.bookingUTC = bookingUTC;

            fulfillmentText = await generateGeminiReply(`Okay, for ${formatDubai(bookingUTC).date} at ${formatDubai(bookingUTC).time}. How many guests will there be?`);
            outputContexts.push({
                name: `${session}/contexts/booking-flow`,
                lifespanCount: 5,
                parameters: currentBookingDetails
            });
            outputContexts.push({
                name: `${session}/contexts/awaiting-guest-count`,
                lifespanCount: 2
            });
        }
        // Scenario 3: Only guest count is provided
        else if (guestCount) {
            console.log("DEBUG: Booking Intent - Only guest count provided.");
            currentBookingDetails.guestCount = guestCount;
            // Infer type now if not already set (e.g., if user says "book for 5")
            if (!currentBookingDetails.type) {
                currentBookingDetails.type = (guestCount >= 10) ? 'group' : 'table';
            }

            fulfillmentText = await generateGeminiReply(`Got it! For ${guestCount} guests. And on what date and time would you like to book? (e.g., 'tomorrow at 7 PM')`);
            outputContexts.push({
                name: `${session}/contexts/booking-flow`,
                lifespanCount: 5,
                parameters: currentBookingDetails
            });
            outputContexts.push({
                name: `${session}/contexts/awaiting-datetime`,
                lifespanCount: 2
            });
        }
        // Scenario 4: No key parameters provided initially (e.g., "I want to book something")
        else {
            console.log("DEBUG: Booking Intent - No key parameters provided initially.");
            fulfillmentText = await generateGeminiReply(`To help you book, how many guests will there be?`);
            outputContexts.push({
                name: `${session}/contexts/awaiting-guest-count`,
                lifespanCount: 2
            });
        }
        return res.json({ fulfillmentText, outputContexts });
    }

    // ✅ Select Booking Type Intent
    if (intent === "Select Booking Type Intent") {
        console.log("DEBUG: Entering Select Booking Type Intent.");
        const bookingType = getParameter(req.body, 'booking_type'); // Use req.body for getParameter
        let fulfillmentText = ``;
        let outputContexts = [];
        // Get current booking details from context if any (e.g., if guest count was captured earlier)
        const bookingFlowCtx = findContext("booking-flow", contexts);
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        currentBookingDetails.type = bookingType; // Set/update booking type

        outputContexts.push({
            name: `${session}/contexts/booking-flow`,
            lifespanCount: 5,
            parameters: currentBookingDetails // Pass updated parameters
        });

        if (bookingType === 'table') {
            // If guest count is already known, proceed to date/time
            if (currentBookingDetails.guestCount) {
                fulfillmentText = await generateGeminiReply(`Great! For ${currentBookingDetails.guestCount} guests, on what date and time would you like to book? (e.g., 'tomorrow at 7 PM')`);
                outputContexts.push({
                    name: `${session}/contexts/awaiting-datetime`,
                    lifespanCount: 2
                });
            } else { // If guest count not known, ask for it
                fulfillmentText = await generateGeminiReply("Great! For a table booking, how many guests will there be?");
                outputContexts.push({
                    name: `${session}/contexts/awaiting-guest-count`,
                    lifespanCount: 2
                });
            }
        } else if (bookingType === 'group') {
            // For group, directly ask for guest count, skip package selection
            if (currentBookingDetails.guestCount) {
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

    // REMOVED: Select Packages Intent

    // ✅ Capture Guest Count Intent
    if (intent === "Capture Guest Count Intent") {
        console.log(`DEBUG: Entering Capture Guest Count Intent.`);
        const guestCount = getParameter(req.body, 'number'); // Use req.body for getParameter
        const bookingFlowCtx = findContext("booking-flow", contexts); // Use contexts from webhook scope
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        if (!guestCount || guestCount <= 0) {
            return res.json({ fulfillmentText: await generateGeminiReply("Please provide a valid number of guests.") });
        }

        currentBookingDetails.guestCount = guestCount; // Corrected to guestCount
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
        const dateParam = getParameter(req.body, 'date'); // Use req.body for getParameter
        const timeParam = getParameter(req.body, 'time'); // Use req.body for getParameter
        const bookingFlowCtx = findContext("booking-flow", contexts); // Use contexts from webhook scope
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

        const venues = await getAvailableVenues(currentBookingDetails.guestCount); // Filtered by seated_capacity
        const venueNames = venues.map(v => v.name).join(', ');

        // MODIFIED PROMPT: Explicitly ask Gemini to list all venues and forbid filtering
        return res.json({
            fulfillmentText: await generateGeminiReply(`Got it! For ${currentBookingDetails.guestCount} guests on ${formatDubai(currentBookingDetails.bookingUTC).date} at ${formatDubai(currentBookingDetails.bookingUTC).time}. Which venue would you like to book? Here are our options: ${venueNames}. Please list ALL of these options clearly to the user and ask if any of these work for them. Do NOT filter or ask about preferences like 'vibe'.`),
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

    // ✅ Ask Venue Details Intent
    if (intent === "Ask Venue Details Intent") { // Corrected intent name with spaces
      console.log(`DEBUG: Entering Ask Venue Details Intent.`);
      // Prioritize 'venue_name' as per user's request, fallback to 'space_name'
      let venueRaw = getParameter(req.body, 'venue_name') || getParameter(req.body, 'space_name');

      if (Array.isArray(venueRaw)) {
          venueRaw = venueRaw[venueRaw.length - 1]; // Take the last element if it's an array
      }
      if (typeof venueRaw === 'object' && venueRaw !== null && venueRaw.name) {
          venueRaw = venueRaw.name; // If it's an object with a 'name' property
      }
      // Ensure venueRaw is definitely a string before proceeding
      venueRaw = String(venueRaw || '').trim();

      console.log(`DEBUG: Ask Venue Details Intent - venueRaw (after string conversion and trim): '${venueRaw}' (type: ${typeof venueRaw})`);

      if (!venueRaw) {
        console.log(`DEBUG: Ask Venue Details Intent - No venue name provided.`);
        return res.json({
          fulfillmentText: await generateGeminiReply(`I couldn't catch the venue name you're asking about. Could you please say it again?`),
        });
      }

      // Add an explicit check and conversion just before toLowerCase, as a final safeguard
      let venueName = '';
      if (typeof venueRaw === 'string') {
          venueName = venueRaw.toLowerCase();
      } else {
          console.error(`CRITICAL ERROR: venueRaw is not a string before toLowerCase in Ask Venue Details Intent: ${venueRaw} (type: ${typeof venueRaw})`);
          return res.json({
              fulfillmentText: await generateGeminiReply("There was an unexpected issue with the venue name. Please try again.")
          });
      }

      const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_VENUES_TABLE_ID}`;
      const cfg = {
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
      };
      let resp;
      try {
        resp = await axios.get(url, cfg);
        console.log(`DEBUG: Ask Venue Details Intent - Fetched venues from Airtable.`);
      } catch (error) {
        console.error("❌ Ask Venue Details Intent - Error fetching venues from Airtable:", error.message);
        return res.json({
            fulfillmentText: await generateGeminiReply("There was a problem fetching venue details. Please try again.")
        });
      }

      const match = resp.data.records.find(
        (r) =>
          r.fields.space_name &&
          r.fields.space_name.toLowerCase() === venueName
      );

      if (!match) {
        console.log(`DEBUG: Ask Venue Details Intent - No match found for venue: ${venueName}`);
        return res.json({
          fulfillmentText: await generateGeminiReply(`Sorry, I couldn't find details for "${venueRaw}". Please ensure you're asking about one of our listed venues.`),
        });
      }

      const venue = match.fields;
      // MODIFIED PROMPT FOR Ask Venue Details Intent - now includes both standing and seated capacity
      const prompt = `The user asked for details about the venue "${venue.space_name}". It has a standing capacity of ${venue.standing_capacity} and a seated capacity of ${venue.seated_capacity}. Here is the description: ${venue.description || "No description provided."} As a helpful booking concierge, explain this information clearly to the user. Do NOT ask any follow up questions.`;

      console.log(`DEBUG: Ask Venue Details Intent - Gemini prompt: ${prompt}`);
      const reply = await generateGeminiReply(prompt);
      console.log(`DEBUG: Ask Venue Details Intent - Gemini reply: ${reply}`);

      // Set the venue name and ID in the booking-flow context
      const bookingFlowCtx = findContext("booking-flow", contexts);
      let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};
      currentBookingDetails.venue = venue.space_name;
      currentBookingDetails.venue_id = match.id; // Store venue ID here

      return res.json({
        fulfillmentText: reply,
        outputContexts: [
          {
            name: `${session}/contexts/booking-flow`,
            lifespanCount: 5,
            parameters: currentBookingDetails, // Ensure updated parameters are passed
          },
        ],
      });
    }

    // ✅ Select Venue Intent
    if (intent === "Select Venue Intent") {
        console.log(`DEBUG: Entering Select Venue Intent.`);
        // Prioritize 'venue_name' as per user's request, fallback to 'space_name'
        let venueRaw = getParameter(req.body, 'venue_name') || getParameter(req.body, 'space_name');
        if (Array.isArray(venueRaw)) {
            venueRaw = venueRaw[venueRaw.length - 1]; // Take the last element if it's an array
        }
        if (typeof venueRaw === 'object' && venueRaw !== null && venueRaw.name) {
            venueRaw = venueRaw.name; // If it's an object with a 'name' property
        }
        // Ensure venueRaw is definitely a string before proceeding
        venueRaw = String(venueRaw || '').trim();

        console.log(`DEBUG: Select Venue Intent - venueRaw (after string conversion and trim): '${venueRaw}' (type: ${typeof venueRaw})`);

        const bookingFlowCtx = findContext("booking-flow", contexts);
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        // NEW LOGIC: If venueRaw is empty, but a venue is already selected in context,
        // then the user is likely trying to confirm or move on from venue selection.
        // We should then proceed to ask for contact details.
        if ((!venueRaw || venueRaw.trim() === '') && currentBookingDetails.venue) {
            console.log("DEBUG: Select Venue Intent - venueRaw empty, but venue already in context. Skipping re-prompt for venue.");
            return res.json({
                fulfillmentText: await generateGeminiReply(`Great! You've chosen ${currentBookingDetails.venue}. Now, could I get your full name, email, and phone number to finalize your inquiry?`),
                outputContexts: [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: currentBookingDetails
                    },
                    {
                        name: `${session}/contexts/awaiting-contact-details`, // Direct to contact details
                        lifespanCount: 2
                    },
                    {
                        name: `${session}/contexts/awaiting-venue-selection`, // Clear this context
                        lifespanCount: 0
                    }
                ]
            });
        }

        // OLD LOGIC (for when venueRaw is truly empty and no venue is in context)
        if (!venueRaw || venueRaw.trim() === '') { // This block will now only hit if no venue is in context either
            let prompt;
            if (currentBookingDetails.guestCount && currentBookingDetails.bookingUTC) {
                const { date, time } = formatDubai(currentBookingDetails.bookingUTC);
                prompt = `Okay, for ${currentBookingDetails.guestCount} guests on ${date} at ${time}. Which venue are you interested in?`;
            } else {
                prompt = `Which venue are you interested in?`;
            }
            return res.json({
                fulfillmentText: await generateGeminiReply(prompt),
                outputContexts: [
                    {
                        name: `${session}/contexts/awaiting-venue-name`, // New context to explicitly await venue name
                        lifespanCount: 2
                    },
                    // Keep booking-flow context if it exists
                    ...(bookingFlowCtx ? [{
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 5,
                        parameters: bookingFlowCtx.parameters
                    }] : [])
                ]
            });
        }

        // Add an explicit check and conversion just before toLowerCase, as a final safeguard
        let venueName = '';
        if (typeof venueRaw === 'string') {
            venueName = venueRaw.toLowerCase();
        } else {
            console.error(`CRITICAL ERROR: venueRaw is not a string before toLowerCase in Select Venue Intent: ${venueRaw} (type: ${typeof venueRaw})`);
            return res.json({
                fulfillmentText: await generateGeminiReply("There was an unexpected issue with the venue name. Please try again.")
            });
        }

        // Proceed with original logic if venueRaw is not empty
        // The bookingFlowCtx is already defined above
        // let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {}; // This line is redundant now

        const availableVenues = await getAvailableVenues(currentBookingDetails.guestCount); // Filtered by seated_capacity
        const selectedVenue = availableVenues.find(v => v.name.toLowerCase() === venueName.toLowerCase());

        if (!selectedVenue) {
            return res.json({ fulfillmentText: await generateGeminiReply("I couldn't find that venue. Please select from the available venues.") });
        }

        currentBookingDetails.venue = selectedVenue.name;
        currentBookingDetails.venue_id = selectedVenue.id; // Store venue ID here

        // CORRECTED: For both table and group bookings, now directly ask for contact details
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

    // REMOVED: Capture Add-ons Intent
    // REMOVED: No Add-ons Intent

    // ✅ Collect Contact Details Intent
    if (intent === "CollectContactDetails") { // Corrected intent name
        console.log(`DEBUG: Entering CollectContactDetails Intent.`);
        console.log(`DEBUG: Raw params in CollectContactDetails: ${JSON.stringify(params, null, 2)}`);

        const bookingFlowCtx = findContext("booking-flow", contexts); // Use contexts from webhook scope
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        // Retrieve existing details from context, or initialize if not present
        let fullName = currentBookingDetails.full_name || '';
        let mobileNumber = currentBookingDetails.mobile_number || '';
        let emailAddress = currentBookingDetails.email_id || '';

        // Update with new parameters from the current turn
        // Ensure we handle the personName object structure correctly
        if (params.personName && typeof params.personName === 'object' && params.personName.name) {
            fullName = params.personName.name;
        } else if (params.personName && typeof params.personName === 'string') { // Fallback for direct string
            fullName = params.personName;
        }
        if (params.phoneNumber) {
            mobileNumber = params.phoneNumber;
        }
        if (params.emailAddress) {
            emailAddress = params.emailAddress;
        }

        // NEW: If personName parameter is still not set, try to extract from queryText
        if (!fullName) {
            const queryText = req.body.queryResult.queryText;
            // More flexible regex for names (e.g., "John Doe", "Dr. Smith", "O'Malley")
            // This regex attempts to capture common name formats, including optional titles.
            // MODIFIED REGEX: Made it more generic for common names.
            const nameRegex = /([A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,2})/; // Captures 1 to 3 words with hyphens/apostrophes
            const nameMatch = queryText.match(nameRegex);
            console.log(`DEBUG: CollectContactDetails - queryText for name regex: "${queryText}"`);
            console.log(`DEBUG: CollectContactDetails - nameMatch result: ${JSON.stringify(nameMatch)}`);
            if (nameMatch && nameMatch[1]) {
                fullName = nameMatch[1].trim();
                console.log(`DEBUG: Extracted name from queryText in CollectContactDetails: ${fullName}`);
            }
        }


        console.log(`DEBUG: Collected contact details (after update) - Name: '${fullName}' (Type: ${typeof fullName}), Phone: '${mobileNumber}' (Type: ${typeof mobileNumber}), Email: '${emailAddress}' (Type: ${typeof emailAddress})`);

        // --- NEW DEBUG LOGGING ---
        console.log(`DEBUG: Before final check: fullName='${fullName}', mobileNumber='${mobileNumber}', emailAddress='${emailAddress}'`);
        console.log(`DEBUG: Condition (fullName && mobileNumber && emailAddress) evaluates to: ${!!(fullName && mobileNumber && emailAddress)}`);
        // --- END NEW DEBUG LOGGING ---


        // Update bookingDetails in context for persistence
        currentBookingDetails.full_name = fullName;
        currentBookingDetails.mobile_number = mobileNumber;
        currentBookingDetails.email_id = emailAddress;

        let finalConfirmationPrompt;
        let outputContexts = [
            {
                name: `${session}/contexts/booking-flow`,
                lifespanCount: 5,
                parameters: currentBookingDetails // Always update booking-flow context
            }
        ];

        // Check if all required contact details are present
        if (fullName && mobileNumber && emailAddress) {
            console.log("DEBUG: All contact details present. Proceeding to summary.");
            // Generate summary for confirmation
            const { date, time } = formatDubai(currentBookingDetails.bookingUTC);
            const venueName = currentBookingDetails.venue || "the selected venue";

            // Simplified summary as no packages/add-ons/pricing are involved
            let summaryText;
            if (currentBookingDetails.type === 'group') {
                summaryText = `Alright, ${fullName}, let's summarize your group inquiry:\n`;
                summaryText += `Guests: ${currentBookingDetails.guestCount}\n`;
                summaryText += `Date: ${date} at ${time}\n`;
                summaryText += `Venue: ${venueName}\n`;
                summaryText += `Email: ${currentBookingDetails.email_id}\n`;
                summaryText += `Mobile: ${currentBookingDetails.mobile_number}\n`;
                summaryText += `Is this all correct? (Yes/No)`;
            } else { // It's a table booking (<10 guests)
                summaryText = `Alright, ${fullName}, let's summarize your table reservation:\n`;
                summaryText += `Guests: ${currentBookingDetails.guestCount}\n`;
                summaryText += `Date: ${date} at ${time}\n`;
                summaryText += `Venue: ${venueName}\n`;
                summaryText += `Is this all correct? (Yes/No)`;
            }

            // Pass isSummaryConfirmation = true to generateGeminiReply
            finalConfirmationPrompt = await generateGeminiReply(summaryText, true);

            outputContexts.push({
                name: `${session}/contexts/awaiting-final-confirmation`, // New context to await final confirmation
                lifespanCount: 2,
                parameters: {
                    // Pass collected contact details to this context as well, if needed for the final confirmation prompt
                    full_name: fullName,
                    mobile_number: mobileNumber,
                    email_id: emailAddress
                }
            });
            // Clear awaiting-guest-details context as we have all info
            outputContexts.push({
                name: `${session}/contexts/awaiting-contact-details`, // Clear this context
                lifespanCount: 0,
            });

        } else {
            console.log("DEBUG: Missing contact details. Prompting again.");
            // If not all contact details are present, prompt for them.
            let missingFields = [];
            if (!fullName) missingFields.push("full name");
            if (!mobileNumber) missingFields.push("mobile number");
            if (!emailAddress) missingFields.push("email address");

            finalConfirmationPrompt = await generateGeminiReply(`I still need your ${missingFields.join(' and ')} to finalize the booking.`);

            // Keep the awaiting-guest-details context active
            outputContexts.push({
                name: `${session}/contexts/awaiting-contact-details`,
                lifespanCount: 2, // Keep active
                parameters: { // Pass back what was collected to maintain state
                    personName: fullName, // Use personName as per Dialogflow parameter name
                    phoneNumber: mobileNumber, // Use phoneNumber as per Dialogflow parameter name
                    emailAddress: emailAddress // Use emailAddress as per Dialogflow parameter name
                }
            });
        }
        // --- NEW LOGGING FOR WEBHOOK RESPONSE ---
        const webhookResponse = {
            fulfillmentText: finalConfirmationPrompt,
            outputContexts: outputContexts
        };
        console.log(`DEBUG: Webhook response for CollectContactDetails: ${JSON.stringify(webhookResponse, null, 2)}`);
        // --- END NEW LOGGING ---

        return res.json(webhookResponse);
    }

    // ✅ Confirm Booking Intent (NEW HANDLER)
    if (intent === "ConfirmBooking") {
        console.log(`DEBUG: Entering ConfirmBooking Intent.`);
        const bookingFlowCtx = findContext("booking-flow", contexts);

        if (!bookingFlowCtx || !bookingFlowCtx.parameters) {
            console.error("❌ ConfirmBooking: booking-flow context or its parameters not found.");
            return res.json({
                fulfillmentText: await generateGeminiReply("I apologize, I seem to have lost track of your booking details. Could you please start over?")
            });
        }

        const bookingDetails = bookingFlowCtx.parameters;
        console.log(`DEBUG: ConfirmBooking: Retrieved booking details from context: ${JSON.stringify(bookingDetails, null, 2)}`);

        // Perform booking creation in Airtable
        try {
            await createBooking(bookingDetails, 'Confirmed'); // Set status to 'Confirmed'
            console.log("DEBUG: Booking successfully created in Airtable.");

            let confirmationMessage;
            if (bookingDetails.type === 'group') {
                // For group bookings, send email and provide specific confirmation
                const emailSent = await sendEmailWithPdf(bookingDetails.email_id, bookingDetails.full_name);
                if (emailSent) {
                    confirmationMessage = `Excellent! Your group booking for ${bookingDetails.guestCount} guests at ${bookingDetails.venue} on ${formatDubai(bookingDetails.bookingUTC).date} at ${formatDubai(bookingDetails.bookingUTC).time} has been confirmed. A manager will be in touch shortly, and we've sent the event packages to ${bookingDetails.email_id}.`;
                } else {
                    confirmationMessage = `Excellent! Your group booking for ${bookingDetails.guestCount} guests at ${bookingDetails.venue} on ${formatDubai(bookingDetails.bookingUTC).date} at ${formatDubai(bookingDetails.bookingUTC).time} has been confirmed. A manager will be in touch shortly. (Note: There was an issue sending the email with packages, please check your webhook logs.)`;
                }
            } else {
                // For table bookings, provide simple confirmation
                confirmationMessage = `Excellent! Your table reservation for ${bookingDetails.guestCount} guests at ${bookingDetails.venue} on ${formatDubai(bookingDetails.bookingUTC).date} at ${formatDubai(bookingDetails.bookingUTC).time} has been confirmed. We look forward to seeing you!`;
            }

            return res.json({
                fulfillmentText: await generateGeminiReply(confirmationMessage),
                outputContexts: [
                    {
                        name: `${session}/contexts/booking-flow`,
                        lifespanCount: 0 // Clear booking-flow context to end the session
                    },
                    {
                        name: `${session}/contexts/awaiting-final-confirmation`,
                        lifespanCount: 0 // Clear this context as well
                    }
                ]
            });

        } catch (error) {
            console.error("❌ Error confirming booking:", error.message);
            return res.json({
                fulfillmentText: await generateGeminiReply("I'm sorry, there was an issue confirming your booking. Please try again later or contact us directly.")
            });
        }
    }


    // If intent is not handled (this line will be hit if no specific intent handler above matches)
    return res.json({
        fulfillmentText: await generateGeminiReply("I'm not sure how to handle that request yet.")
    });

  } catch (error) { // END OF MAIN TRY BLOCK, START OF CATCH BLOCK
    console.error("❌ Webhook error:", error);
    return res.status(500).json({
      fulfillmentText: await generateGeminiReply("I'm sorry, there was a technical issue. Please try again later."),
    });
  }
}); // CLOSING BRACE FOR app.post CALLBACK

// --- Start the Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
