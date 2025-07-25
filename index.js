// index.js - Replit Webhook for AI Booking Concierge

const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const moment = require("moment-timezone");
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
// AIRTABLE_BOOKINGS_TABLE_ID=YOUR_BOOKINGS_TABLE_ID (e.g., tblAAAAAAAAAAAAAA - from your "Bookings" table)
// GEMINI_API_KEY=YOUR_GEMINI_API_KEY
// EMAIL_SERVICE_HOST=smtp.zoho.com
// EMAIL_SERVICE_PORT=587
// EMAIL_SERVICE_USER=your_zoho_email@yourdomain.com
// EMAIL_SERVICE_PASS=your_zoho_app_password_or_regular_password
// PDF_URL=https://your-domain.com/your-packages.pdf (This PDF URL will still be used in the email for group leads if you want to send it)

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
    const formattedCreatedDate = now.format("M/D/YYYY h:mma"); // e.g., "6/25/2025 3:45pm"
    const storageTimeUtc = now.toISOString(); // ISO string for UTC storage time

    const { date: formattedBookingDate, time: formattedBookingTime, local_datetime: eventTimeLocal } = formatDubai(bookingDetails.bookingUTC);
    const eventDateTime = `${formattedBookingDate} ${formattedBookingTime}`; // e.g., "5 July 2025 8:30pm"

    // Prepare fields for Airtable
    const fields = {
      created_date: formattedCreatedDate,
      guest_name: bookingDetails.full_name,
      phone_no: bookingDetails.mobile_number,
      email: bookingDetails.email_id,
      booking_type: bookingDetails.type === 'table' ? 'Table Booking' : 'Group Booking', // Map 'type' to 'booking_type'
      event_date_time: eventDateTime, // Combined date and time string
      guest_count: bookingDetails.guestCount, // Corrected from guest_count to guestCount
      status: status, // Use the passed status
      event_time_local: eventTimeLocal, // Local Dubai time
      storage_time_utc: storageTimeUtc, // UTC time of storage
    };

    // Add venue details
    if (bookingDetails.venue) {
      fields.space_name = bookingDetails.venue; // Matches CSV 'space_name'
      if (bookingDetails.space_id) {
        fields.space_id = [bookingDetails.space_id]; // Ensure this is an array for linked records
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
        let venueRaw = getParameter(req.body, 'venue_name'); // Use req.body for getParameter

        // If venueRaw is empty, it means Dialogflow triggered this intent without a specific venue name.
        if (!venueRaw || venueRaw.trim() === '') {
            const bookingFlowCtx = findContext("booking-flow", contexts);
            let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};
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

        // Proceed with original logic if venueRaw is not empty
        const bookingFlowCtx = findContext("booking-flow", contexts); // Use contexts from webhook scope
        let currentBookingDetails = bookingFlowCtx ? bookingFlowCtx.parameters : {};

        const availableVenues = await getAvailableVenues(currentBookingDetails.guestCount); // Pass guestCount for filtering
        const selectedVenue = availableVenues.find(v => v.name.toLowerCase() === venueRaw.toLowerCase());

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

    // REMOVED: Capture Add-ons Intent
    // REMOVED: No Add-ons Intent

    // ✅ Capture Contact Details Intent
    if (intent === "Capture Contact Details Intent") {
        console.log(`DEBUG: Entering Capture Contact Details Intent.`);
        console.log(`DEBUG: Raw params in Capture Contact Details Intent: ${JSON.stringify(params, null, 2)}`);

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

        console.log(`DEBUG: Collected contact details (after update) - Name: ${fullName}, Phone: ${mobileNumber}, Email: ${emailAddress}`);
        console.log(`DEBUG: fullName: '${fullName}' (Type: ${typeof fullName})`);
        console.log(`DEBUG: mobileNumber: '${mobileNumber}' (Type: ${typeof mobileNumber})`);
        console.log(`DEBUG: emailAddress: '${emailAddress}' (Type: ${typeof emailAddress})`);


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

            finalConfirmationPrompt = await generateGeminiReply(summaryText); // Use Gemini for the summary prompt

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
                name: `${session}/contexts/awaiting-guest-details`,
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
                name: `${session}/contexts/awaiting-guest-details`,
                lifespanCount: 2,
                parameters: { // Pass back what was collected to maintain state
                    personName: fullName, // Use personName as per Dialogflow parameter name
                    phoneNumber: mobileNumber, // Use phoneNumber as per Dialogflow parameter name
                    emailAddress: emailAddress // Use emailAddress as per Dialogflow parameter name
                }
            });
        }

        return res.json({
            fulfillmentText: finalConfirmationPrompt, // Use the Gemini-generated prompt
            outputContexts: outputContexts
        });
    }

    // ✅ Confirm Booking Intent (User says Yes to summary)
    if (intent === "Confirm Booking Intent") {
        console.log(`DEBUG: Entering Confirm Booking Intent.`);
        const bookingFlowCtx = findContext("booking-flow", contexts); // Use contexts from webhook scope
        if (!bookingFlowCtx) {
            console.error("❌ Confirm Booking Intent - Booking flow context missing!");
            return res.json({ fulfillmentText: await generateGeminiReply("I seem to have lost your booking details. Please start over.") });
        }

        const bookingDetails = bookingFlowCtx.parameters;

        let finalConfirmationPrompt;
        let outputContextsToSet = [];

        // Now both types use createBooking, but with different statuses and data.
        if (bookingDetails.type === 'table') {
            try {
                // Create full booking record with 'Confirmed' status
                const createdBookingRecord = await createBooking(bookingDetails, 'Confirmed');

                // Generate confirmation message for table booking
                const { date, time } = formatDubai(bookingDetails.bookingUTC);
                const venueName = bookingDetails.venue || "the selected venue";

                finalConfirmationPrompt = await generateGeminiReply(`Excellent, ${bookingDetails.full_name}! Your table reservation for ${bookingDetails.guestCount} guests at ${venueName} on ${date} at ${time} is now confirmed! A confirmation email will be sent to ${bookingDetails.email_id}. Thank you!`);

                outputContextsToSet = [
                    { name: `${session}/contexts/booking-finalized`, lifespanCount: 1 },
                    { name: `${session}/contexts/booking-flow`, lifespanCount: 0 },
                    { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 }
                ];

            } catch (error) {
                console.error("❌ Confirm Booking Intent (Table) - Error finalizing booking:", error.message);
                finalConfirmationPrompt = await generateGeminiReply("I'm sorry, there was an issue finalizing your table reservation. Please try again or contact us directly.");
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
                    finalConfirmationPrompt = await generateGeminiReply(`Thank you, ${bookingDetails.full_name}! We've received your group booking inquiry for ${bookingDetails.guestCount} guests at ${venueName} on ${date} at ${time}. We've just sent an email to ${bookingDetails.email_id} with our package details. Our manager will be in touch shortly to help you finalize your selection. Is there anything else I can help you with today?`);
                } else {
                    finalConfirmationPrompt = await generateGeminiReply(`Thank you, ${bookingDetails.full_name}! We've received your group booking inquiry for ${bookingDetails.guestCount} guests at ${venueName} on ${date} at ${time}. We're having trouble sending the package details via email right now, but our manager will be in touch shortly to help you finalize your selection.`);
                }

                outputContextsToSet = [
                    { name: `${session}/contexts/group-lead-submitted`, lifespanCount: 1 }, // New context for lead submitted
                    { name: `${session}/contexts/booking-flow`, lifespanCount: 0 }, // Clear main context
                    { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 } // Clear previous confirmation context
                ];

            } catch (error) {
                console.error("❌ Confirm Booking Intent (Group) - Error submitting group lead or sending email:", error.message);
                finalConfirmationPrompt = await generateGeminiReply("I'm sorry, there was an issue submitting your group inquiry. Please try again or contact us directly.");
                outputContextsToSet = [
                    { name: `${session}/contexts/booking-flow`, lifespanCount: 2 },
                    { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 }
                ];
            }
        } else {
            // Fallback if booking type is somehow missing or invalid
            finalConfirmationPrompt = await generateGeminiReply("I'm sorry, I couldn't determine the booking type. Please try again.");
            outputContextsToSet = [
                { name: `${session}/contexts/booking-flow`, lifespanCount: 0 },
                { name: `${session}/contexts/awaiting-confirmation`, lifespanCount: 0 }
            ];
        }

        return res.json({
            fulfillmentText: finalConfirmationPrompt, // Use the Gemini-generated prompt
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

    // ✅ Restart Booking Intent (from Deny flow) (MODIFIED: All fulfillment text from Gemini)
    if (intent === "Restart Booking Intent") {
        console.log(`DEBUG: Entering Restart Booking Intent.`);
        const venues = await getAvailableVenues();
        const venueNames = venues.map(v => v.name).join(', ');
        const prompt = `Alright, let's start over! We offer bookings for ${venueNames}. Are you looking to book a table or a group event?`;
        return res.json({
            fulfillmentText: await generateGeminiReply(prompt), // Now uses Gemini
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
        const bookingFlowCtx = findContext("booking-flow", contexts);
        if (bookingFlowCtx) {
            return res.json({ fulfillmentText: await generateGeminiReply("I'm sorry, I didn't understand that. Please tell me more about your booking preference or try rephrasing.") });
        } else {
            return res.json({ fulfillmentText: await generateGeminiReply("I didn't quite catch that. Could you please rephrase or tell me what you'd like to do?") });
        }
    }


    // Removed duplicate formatDubai function from here.
    // The one at the top is used.

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
