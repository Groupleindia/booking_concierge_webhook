// index.js - Replit Webhook for AI Booking Concierge

const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const moment = require("moment-timezone");
// const fetch = require("node-fetch"); // Used for Gemini API calls - OLD LINE
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

// 🔹 Fetch available packages from Airtable
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
        category: r.fields.category || "General" // Corrected from A_category to category
      }))
      .filter((p) => p.name); // Ensure package name exists
  } catch (error) {
    console.error("❌ Error fetching packages from Airtable:", error.message);
    return []; // Return empty array on error
  }
}

// 🔹 Fetch available add-ons from Airtable
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
        name: r.fields.add_on_name, // Corrected field name based on screenshot
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
        // You might want to add a small delay or a more robust check here
        // if this block is hit before the import completes.
        // For most cases, the top-level await import will ensure it's ready.
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

// 🔹 Create a new booking record in the "Bookings" table
/**
 * Creates a new booking record in the main "Bookings" Airtable table.
 * @param {object} bookingDetails - Object containing all booking and customer details.
 * @returns {Promise<object>} - The created record from Airtable.
 */
async function createBooking(bookingDetails) {
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

    // Prepare fields based on booking type
    const fields = {
      created_date: formattedCreatedDate,
      guest_name: bookingDetails.full_name,
      phone_no: bookingDetails.mobile_number,
      email: bookingDetails.email_id,
      booking_type: bookingDetails.type === 'table' ? 'Table Booking' : 'Group Booking', // Map 'type' to 'booking_type'
      event_date_time: eventDateTime, // Combined date and time string
      guest_count: bookingDetails.guest_count,
      status: 'Confirmed', // Default status
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

    // Add group booking specific details
    if (bookingDetails.type === 'group') {
      // Store packages as a comma-separated string if multiple are selected
      fields.package_name = Array.isArray(bookingDetails.packages) ? bookingDetails.packages.join(', ') : bookingDetails.packages;
      // Store package IDs as an array of linked record IDs
      if (bookingDetails.package_ids && bookingDetails.package_ids.length > 0) {
        fields.package_id = bookingDetails.package_ids; // Assuming this is a Linked Record field in Airtable
      }
      fields.grand_total = `AED${bookingDetails.grand_total.toFixed(2)}`; // Format total price as "AEDX.XX"
      // total_package_cost and proposal_summary still need to be addressed if distinct from grand_total and generated summary
    }

    const data = { records: [{ fields }] };
    const response = await axios.post(url, data, cfg);
    console.log('Booking successful:', response.data.records[0].id);
    return response.data.records[0]; // Return the created record
  } catch (error) {
    console.error('Error creating booking:', error.response ? error.response.data : error.message);
    throw new Error('Failed to create booking.');
  }
}

// 🔹 Create records in the "Booking_Addons" table for selected add-ons
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
    // ✅ Booking Intent - Initial booking request
    if (intent === "Booking Intent") {
      let guestCount = Array.isArray(params.guestCount)
        ? params.guestCount[0]
        : params.guestCount;

      // Extract only the date part (YYYY-MM-DD) from bookingdate parameter
      const rawBookingDate = Array.isArray(params.bookingdate) ? params.bookingdate[0] : params.bookingdate;
      const bookingDateOnly = moment(rawBookingDate).format("YYYY-MM-DD");

      // Handle bookingtime which might be an array (as seen in the curl output)
      let rawBookingTime;
      if (Array.isArray(params.bookingtime)) {
        // If multiple times, try to pick the last one as it's usually the most relevant
        rawBookingTime = params.bookingtime[params.bookingtime.length - 1];
      } else {
        rawBookingTime = params.bookingtime;
      }

      console.log(`DEBUG: rawBookingDate (from Dialogflow): ${rawBookingDate}`);
      console.log(`DEBUG: bookingDateOnly (formatted): ${bookingDateOnly}`);
      console.log(`DEBUG: rawBookingTime (from Dialogflow parameter): ${rawBookingTime}`);
      console.log(`DEBUG: params.bookingtime.original: ${JSON.stringify(params.bookingtime.original)}`);

      let bookingTimeStr;
      // Extract the HH:mm part from the raw Dialogflow timestamp string directly.
      // This assumes the HH:mm part of the incoming timestamp is the intended time in Dubai.
      // Example: "2025-07-03T21:30:00+05:30" -> "21:30"
      const timeStartIndex = rawBookingTime.indexOf('T') + 1;
      const timeEndIndex = rawBookingTime.indexOf('+');
      if (timeStartIndex !== -1 && timeEndIndex !== -1 && timeEndIndex > timeStartIndex) {
          bookingTimeStr = rawBookingTime.substring(timeStartIndex, timeEndIndex).substring(0, 5); // Get "HH:mm"
      } else {
          // Fallback if parsing fails or unexpected format, though it should ideally not happen
          bookingTimeStr = moment(rawBookingTime).format("HH:mm");
          console.warn(`WARN: Fallback time parsing used for rawBookingTime: ${rawBookingTime}`);
      }

      console.log(`DEBUG: bookingTimeStr (extracted for buildDubaiUTC): ${bookingTimeStr}`);

      // Now combine the correct date and time to build the UTC timestamp
      // buildDubaiUTC will now take "2025-07-28" and "17:00" and interpret it as 5 PM Dubai.
      const bookingUTC = buildDubaiUTC(bookingDateOnly, bookingTimeStr);
      const { date, time } = formatDubai(bookingUTC); // This will format it back to readable Dubai time

      console.log(`DEBUG: Final booking date (formatted): ${date}`);
      console.log(`DEBUG: Final booking time (formatted): ${time}`);
      console.log(`DEBUG: Final bookingUTC (stored in context): ${bookingUTC}`);

      const category =
        guestCount <= 10 ? "a general reservation" : "a group booking";
      const venues = await getAvailableVenues(guestCount);

      const prompt = venues.length
        ? `A user requested ${category} for ${guestCount} guests on ${date} at ${time}. Available venues: ${venues
            .map((v) => v.name)
            .join(", ")}. Write a short, helpful spoken-style response suitable for a phone booking. Mention the venue options clearly and ask the user if any of those work for them.`
        : `No venues available for ${guestCount} guests on ${date} at ${time}. Kindly offer an apology in a friendly, spoken tone.`;

      const reply = await generateGeminiReply(prompt);

      console.log("DEBUG: About to send response for Booking Intent."); // NEW LOG HERE

      return res.json({
        fulfillmentText: reply,
        outputContexts: [
          {
            name: `${session}/contexts/booking-flow`,
            lifespanCount: 5,
            parameters: { guestCount, bookingUTC, type: category === "a general reservation" ? "table" : "group" }, // Store booking type
          },
        ],
      });
    }

    // ✅ Modify Booking Intent
    if (intent === "ModifyBookingIntent") {
      const bookingFlowCtx = findContext("booking-flow");
      let { guestCount, bookingUTC, type } = bookingFlowCtx?.parameters || {};

      // Parse current bookingUTC to get its date and time components in Dubai time
      let currentDubaiMoment = moment.utc(bookingUTC).tz("Asia/Dubai");
      let currentDubaiDate = currentDubaiMoment.format("YYYY-MM-DD");
      let currentDubaiTime = currentDubaiMoment.format("HH:mm"); // Use 24-hour for internal consistency

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
        currentDubaiDate = moment(newDate).format("YYYY-MM-DD"); // Use the new date
      }
      if (newTime) {
        // Extract the HH:mm part from the Dialogflow timestamp.
        const timeStartIndex = newTime.indexOf('T') + 1;
        const timeEndIndex = newTime.indexOf('+');
        if (timeStartIndex !== -1 && timeEndIndex !== -1 && timeEndIndex > timeStartIndex) {
            currentDubaiTime = newTime.substring(timeStartIndex, timeEndIndex).substring(0, 5); // Get "HH:mm"
        } else {
            currentDubaiTime = moment(newTime).format("HH:mm");
            console.warn(`WARN: Fallback time parsing used for newTime: ${newTime}`);
        }
        console.log(`DEBUG (Modify): currentDubaiTime (extracted for buildDubaiUTC): ${currentDubaiTime}`);
      }

      // Rebuild bookingUTC with potentially updated date/time
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

    // ✅ Ask Venue Details Intent
    if (intent === "Ask Venue Details Intent") { // Corrected intent name with spaces
      console.log(`DEBUG: Entering AskVenueDetailsIntent`);
      let venueRaw;
      if (Array.isArray(params.venue_name)) {
          venueRaw = params.venue_name[params.venue_name.length - 1];
      } else {
          venueRaw = params.venue_name;
      }
      // Fallback for venueName if venue_name is not present or not an array
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
      // 🚨 MODIFIED PROMPT FOR Ask Venue Details Intent
      const prompt = `The user asked for details about the venue "${venue.space_name}". The standing capacity is ${venue.standing_capacity}. Here is the description: ${venue.description || "No description provided."} As a helpful booking concierge, explain this information clearly to the user. Do NOT ask any follow up questions.`;

      console.log(`DEBUG: AskVenueDetailsIntent - Gemini prompt: ${prompt}`);
      const reply = await generateGeminiReply(prompt);
      console.log(`DEBUG: AskVenueDetailsIntent - Gemini reply: ${reply}`);

      // 🚨 NEW: Set the venue name in the booking-flow context
      return res.json({ 
        fulfillmentText: reply,
        outputContexts: [
          {
            name: `${session}/contexts/booking-flow`,
            lifespanCount: 5, 
            parameters: { 
              venue: venue.space_name, 
              space_id: match.id, 
            }, 
          },
        ],
      });
    }

    // ✅ Select Venue Intent
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
        let { guestCount, bookingUTC, type, venue: contextVenueName, space_id: contextSpaceId, packages: selectedPackagesInContext } = bookingFlowCtx?.parameters || {};

        if ((!venueRaw || venueRaw === '.') && contextVenueName) {
            venueRaw = contextVenueName;
            if (!params.space_id && contextSpaceId) {
                params.space_id = contextSpaceId;
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

        const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${process.env.AIRTABLE_VENUES_TABLE_ID}`;
        const cfg = {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
        };
        let resp;
        try {
          resp = await axios.get(url, cfg);
          console.log(`DEBUG: SelectVenueIntent - Fetched venues from Airtable.`);
        } catch (error) {
          console.error("❌ SelectVenueIntent - Error fetching venues from Airtable:", error.message);
          return res.json({
              fulfillmentText: "There was a problem fetching venue details. Please try again."
          });
        }

        const match = resp.data.records.find(
          (r) =>
            r.fields.space_name &&
            r.fields.space_name.toLowerCase() === venueName &&
            r.fields.standing_capacity >= guestCount
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
                venue: match.fields.space_name, 
                space_id: match.id, 
                type 
              }, 
            },
        ];

        // Check if packages are already selected in the context
        if (type === 'group' && selectedPackagesInContext && selectedPackagesInContext.length > 0) {
            console.log(`DEBUG: Packages already selected: ${selectedPackagesInContext.join(', ')}. Skipping package type question.`);
            // If packages are already selected, proceed to ask about add-ons or finalize
            const availableAddOns = await getAvailableAddOns();
            let addOnDetailsList = "";
            if (availableAddOns.length > 0) {
                addOnDetailsList = availableAddOns.map(ao => {
                    const priceInfo = ao.price_type === 'Per Person' ? `${ao.price} per person` : `${ao.price}`;
                    return `${ao.name} (Cost: AED${priceInfo})`;
                }).join('; ');
            }

            if (addOnDetailsList) {
                prompt = `Great! You've selected ${selectedPackagesInContext.join(' and ')}. Would you like to add any extras? We have: ${addOnDetailsList}. If not, you can just say "no add-ons" or "that's all".`;
                outputContexts.push({
                    name: `${session}/contexts/awaiting-add-on-selection`,
                    lifespanCount: 2,
                });
            } else {
                prompt = `Great! You've selected ${selectedPackagesInContext.join(' and ')}. We don't seem to have any add-ons available right now. To finalize your booking, could I please get your full name, mobile number, and email address?`;
                outputContexts.push({
                    name: `${session}/contexts/awaiting-guest-details`, // Assuming this is the next step for finalization
                    lifespanCount: 2,
                });
            }
        } else if (type === 'group') {
          // MODIFIED: Ask specifically for food or beverage packages AND duration
          prompt = `Confirm the booking for ${guestCount} guests on ${date} at ${time} in the ${match.fields.space_name}. State that for group bookings, we have pre-curated package options. Would you be interested in food packages, beverage packages, or perhaps both? And for how long are you planning your event to be?`;
          outputContexts.push({
              name: `${session}/contexts/awaiting-package-type-selection`,
              lifespanCount: 2,
          });
        } else { 
          prompt = `The user chose "${match.fields.space_name}" for their booking of ${guestCount} guests on ${date} at ${time}. Please generate a concise and warm confirmation. Then, immediately ask for their full name, mobile number, and email address to finalize the booking, all in one smooth utterance.`;
          outputContexts.push({
              name: `${session}/contexts/awaiting-guest-details`, // Assuming this is the next step for finalization
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

    // ✅ Get Package Details Intent (Initial request for package categories)
    if (intent === "Get Package Details") { 
        console.log(`DEBUG: Entering Get Package Details Intent.`); 
        console.log(`DEBUG: Raw params for Get Package Details Intent: ${JSON.stringify(params, null, 2)}`); 
        console.log(`DEBUG: Raw req.body.queryResult.parameters: ${JSON.stringify(req.body.queryResult.parameters, null, 2)}`); 

        const bookingFlowCtx = findContext("booking-flow");
        if (!bookingFlowCtx || bookingFlowCtx.parameters.type !== 'group') {
            console.log("DEBUG: Booking flow context missing or not group type in Get Package Details Intent."); 
            return res.json({ fulfillmentText: await generateGeminiReply("I seem to have lost your group booking details. Please start over.") });
        }

        const bookingParams = bookingFlowCtx.parameters;

        let packageCategories = [];
        if (req.body.queryResult.parameters.packagecategory) {
            if (Array.isArray(req.body.queryResult.parameters.packagecategory)) {
                packageCategories = req.body.queryResult.parameters.packagecategory;
            } else {
                packageCategories = [req.body.queryResult.parameters.packagecategory];
            }
        }

        let durationHours = Array.isArray(params.duration_value) ? params.duration_value[0] : params.duration_value;
        if (params.duration && !durationHours) { // If duration is present but duration_value (number) is not
            const durationMatch = params.duration.match(/(\d+)\s*hour/i);
            if (durationMatch && durationMatch[1]) {
                durationHours = parseInt(durationMatch[1], 10);
            }
        }

        // Update booking-flow context with duration if provided
        if (durationHours) {
            bookingParams.duration_value = durationHours;
            bookingParams.duration = `${durationHours} hour${durationHours > 1 ? 's' : ''}`;
        }

        const allPackages = await getAvailablePackages();
        let filteredPackages = allPackages;

        if (packageCategories.length > 0) {
            filteredPackages = allPackages.filter(p => 
                packageCategories.some(cat => p.category.toLowerCase().includes(cat.toLowerCase()))
            );
            console.log(`DEBUG: Filtered packages by categories: ${packageCategories.join(', ')}. Count: ${filteredPackages.length}`);
        }

        if (durationHours) {
            filteredPackages = filteredPackages.filter(p => {
                const inclusionsMatch = p.inclusions.match(/(\d+)\s*hour/i);
                const packageDuration = inclusionsMatch ? parseInt(inclusionsMatch[1], 10) : 0;
                return packageDuration === durationHours;
            });
            console.log(`DEBUG: Further filtered packages by duration: ${durationHours} hours. Count: ${filteredPackages.length}`);
        }

        if (filteredPackages.length === 0) {
            const prompt = `I couldn't find any packages for your criteria. Please apologize and ask if they would like to try different categories or duration.`;
            return res.json({ fulfillmentText: await generateGeminiReply(prompt) });
        }

        const packageList = filteredPackages.map(p => {
            const priceInfo = p.price_type === 'Per Person' ? `${p.price} per person` : `${p.price}`;
            return `${p.name} (Cost: AED${priceInfo}, Inclusions: ${p.inclusions})`;
        }).join('; ');

        const prompt = `Here are the available packages based on your selection: ${packageList}. Please ask the user to choose one or more packages by name.`;
        const reply = await generateGeminiReply(prompt);

        return res.json({
            fulfillmentText: reply,
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 5,
                    parameters: { 
                        ...bookingParams, // Preserve existing booking parameters
                        last_queried_packages: filteredPackages, // Store the list of packages shown
                        last_queried_categories: packageCategories // Store categories for follow-up
                    }
                },
                {
                    name: `${session}/contexts/awaiting-package-selection`,
                    lifespanCount: 2, // Activate context for package selection
                }
            ]
        });
    }

    // ✅ Select Package Intent (User selects specific packages from the list)
    if (intent === "Specify Package Intent") { // RENAMED FROM "Select Package Intent"
        console.log(`DEBUG: Entering Specify Package Intent.`); // Updated log
        console.log(`DEBUG: Raw params for Specify Package Intent: ${JSON.stringify(params, null, 2)}`); // Added logging for params
        const bookingFlowCtx = findContext("booking-flow");
        if (!bookingFlowCtx || bookingFlowCtx.parameters.type !== 'group') {
            console.log("DEBUG: Booking flow context missing or not group type in Specify Package Intent."); // Updated log
            return res.json({ fulfillmentText: await generateGeminiReply("I seem to have lost your group booking details. Please start over.") });
        }

        const bookingParams = bookingFlowCtx.parameters;
        const lastQueriedPackages = bookingParams.last_queried_packages || [];
        const selectedPackageNames = Array.isArray(params.package) ? params.package : (params.package ? [params.package] : []);

        console.log(`DEBUG: Selected package names from Dialogflow: ${selectedPackageNames.join(', ')}`);

        const selectedPackages = selectedPackageNames.map(name => 
            lastQueriedPackages.find(p => p.name.toLowerCase() === name.toLowerCase())
        ).filter(Boolean); // Filter out undefined/null if no match found

        if (selectedPackages.length === 0) {
            const prompt = `I couldn't find any of the packages you mentioned. Please list the packages you want to select from the options I provided earlier.`;
            return res.json({ fulfillmentText: await generateGeminiReply(prompt) });
        }

        // Calculate total price for selected packages
        const totalPackagesCost = selectedPackages.reduce((sum, p) => sum + p.price, 0);

        // Update booking-flow context with selected packages and total cost
        bookingParams.packages = selectedPackages.map(p => p.name); // Store names
        bookingParams.package_ids = selectedPackages.map(p => p.id); // Store IDs for Airtable linking
        bookingParams.total_packages_cost = totalPackagesCost;

        const selectedPackageNamesStr = selectedPackages.map(p => p.name).join(' and ');

        const availableAddOns = await getAvailableAddOns();
        let addOnDetailsList = "";
        if (availableAddOns.length > 0) {
            addOnDetailsList = availableAddOns.map(ao => {
                const priceInfo = ao.price_type === 'Per Person' ? `${ao.price} per person` : `${ao.price}`;
                return `${ao.name} (Cost: AED${priceInfo})`;
            }).join('; ');
        }

        let prompt;
        let outputContexts = [
            {
                name: `${session}/contexts/booking-flow`,
                lifespanCount: 5,
                parameters: bookingParams // Updated booking parameters
            }
        ];

        if (addOnDetailsList) {
            prompt = `Okay, great choice with ${selectedPackageNamesStr}! Would you like to add any extras? We have: ${addOnDetailsList}. If not, you can just say "no add-ons" or "that's all".`;
            outputContexts.push({
                name: `${session}/contexts/awaiting-add-on-selection`,
                lifespanCount: 2,
            });
        } else {
            prompt = `Okay, great choice with ${selectedPackageNamesStr}! We don't seem to have any add-ons available right now. To finalize your booking, could I please get your full name, mobile number, and email address?`;
            outputContexts.push({
                name: `${session}/contexts/awaiting-guest-details`, // Assuming this is the next step for finalization
                lifespanCount: 2,
            });
        }

        return res.json({
            fulfillmentText: await generateGeminiReply(prompt),
            outputContexts: outputContexts
        });
    }

    // ✅ Add Add-Ons Intent
    if (intent === "Add Add-Ons Intent") {
        console.log(`DEBUG: Entering Add Add-Ons Intent.`);
        const bookingFlowCtx = findContext("booking-flow");
        if (!bookingFlowCtx) {
            console.log("DEBUG: Booking flow context missing in Add Add-Ons Intent.");
            return res.json({ fulfillmentText: await generateGeminiReply("I seem to have lost your booking details. Please start over.") });
        }
        const bookingParams = bookingFlowCtx.parameters;

        const selectedAddOnNames = Array.isArray(params.add_on) ? params.add_on : (params.add_on ? [params.add_on] : []);
        console.log(`DEBUG: Selected add-on names from Dialogflow: ${selectedAddOnNames.join(', ')}`);

        if (selectedAddOnNames.length === 0) {
            const prompt = `I didn't catch which add-ons you'd like. Could you please specify?`;
            return res.json({ fulfillmentText: await generateGeminiReply(prompt) });
        }

        const availableAddOns = await getAvailableAddOns();
        const validAddOns = selectedAddOnNames.map(name => 
            availableAddOns.find(ao => ao.name.toLowerCase() === name.toLowerCase())
        ).filter(Boolean);

        if (validAddOns.length === 0) {
            const prompt = `I couldn't find any of the add-ons you mentioned. Please choose from the available options.`;
            return res.json({ fulfillmentText: await generateGeminiReply(prompt) });
        }

        // Calculate total cost of selected add-ons
        const totalAddOnsCost = validAddOns.reduce((sum, ao) => sum + ao.price, 0);

        // Update booking-flow context with selected add-ons and their cost
        bookingParams.selected_add_ons = (bookingParams.selected_add_ons || []).concat(validAddOns.map(ao => ao.name));
        bookingParams.total_add_ons_cost = (bookingParams.total_add_ons_cost || 0) + totalAddOnsCost;

        // Calculate grand total
        bookingParams.grand_total = (bookingParams.total_packages_cost || 0) + (bookingParams.total_add_ons_cost || 0);

        const prompt = `Okay, I've added ${validAddOns.map(ao => ao.name).join(' and ')}. Your current grand total is AED${bookingParams.grand_total.toFixed(2)}. To finalize your booking, could I please get your full name, mobile number, and email address?`;

        return res.json({
            fulfillmentText: await generateGeminiReply(prompt),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 5,
                    parameters: bookingParams // Updated booking parameters
                },
                {
                    name: `${session}/contexts/awaiting-guest-details`, // Move to guest details after add-ons
                    lifespanCount: 2,
                }
            ]
        });
    }

    // ✅ No Add-Ons Intent
    if (intent === "No Add-Ons Intent") {
        console.log(`DEBUG: Entering No Add-Ons Intent.`);
        const bookingFlowCtx = findContext("booking-flow");
        if (!bookingFlowCtx) {
            console.log("DEBUG: Booking flow context missing in No Add-Ons Intent.");
            return res.json({ fulfillmentText: await generateGeminiReply("I seem to have lost your booking details. Please start over.") });
        }

        const bookingParams = bookingFlowCtx.parameters;
        bookingParams.selected_add_ons = []; // Clear any potential add-ons
        bookingParams.total_add_ons_cost = 0;

        // Calculate grand total (only packages cost)
        bookingParams.grand_total = bookingParams.total_packages_cost || 0;

        const prompt = `Okay, no add-ons selected. Your current total is AED${bookingParams.grand_total.toFixed(2)}. To finalize your booking, could I please get your full name, mobile number, and email address?`;

        return res.json({
            fulfillmentText: await generateGeminiReply(prompt),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-flow`,
                    lifespanCount: 5,
                    parameters: bookingParams // Updated booking parameters
                },
                {
                    name: `${session}/contexts/awaiting-guest-details`, // Move to guest details
                    lifespanCount: 2,
                }
            ]
        });
    }

    // ✅ Collect Contact Details Intent
    if (intent === "CollectContactDetails") {
        console.log(`DEBUG: Entering CollectContactDetails Intent.`);
        const bookingFlowCtx = findContext("booking-flow");
        if (!bookingFlowCtx) {
            console.error("❌ CollectContactDetails - Booking flow context missing!");
            return res.json({ fulfillmentText: await generateGeminiReply("I seem to have lost your booking details. Please start over.") });
        }

        const bookingDetails = bookingFlowCtx.parameters;
        // Correctly extract fullName from params.person, which can be an object or a string
        const fullName = params.person?.name || params.person || ''; 
        const mobileNumber = params['phone-number'] || '';
        const emailAddress = params.email || '';

        console.log(`DEBUG: Collected contact details - Name: ${fullName}, Phone: ${mobileNumber}, Email: ${emailAddress}`);

        // Update bookingDetails with contact info in the context for persistence
        bookingDetails.full_name = fullName;
        bookingDetails.mobile_number = mobileNumber;
        bookingDetails.email_id = emailAddress;

        let finalConfirmationPrompt;
        let outputContexts = [
            {
                name: `${session}/contexts/booking-flow`,
                lifespanCount: 5,
                parameters: bookingDetails // Always update booking-flow context
            }
        ];

        // Check if all required contact details are present
        if (fullName && mobileNumber && emailAddress) {
            // Generate summary for confirmation
            const { date, time } = formatDubai(bookingDetails.bookingUTC);
            const venueName = bookingDetails.venue || "the selected venue";
            const packagesSummary = bookingDetails.packages && bookingDetails.packages.length > 0 ? ` for ${bookingDetails.packages.join(' and ')}` : '';
            const addOnsSummary = bookingDetails.selected_add_ons && bookingDetails.selected_add_ons.length > 0 ? ` with ${bookingDetails.selected_add_ons.join(' and ')} as add-ons` : '';

            let totalPrice = '';
            if (bookingDetails.type === 'group' && bookingDetails.grand_total) {
                totalPrice = ` Your total is AED${bookingDetails.grand_total.toFixed(2)}.`;
            } else if (bookingDetails.type === 'table' && bookingDetails.grand_total > 0) {
                // Only show total for table booking if there's an actual cost (e.g., cover charge)
                totalPrice = ` Your total is AED${bookingDetails.grand_total.toFixed(2)}.`;
            }

            const summaryText = `your booking for ${bookingDetails.guestCount} guests at ${venueName} on ${date} at ${time}${packagesSummary}${addOnsSummary}${totalPrice}`;
            finalConfirmationPrompt = `Alright, ${fullName}! So, just to confirm, ${summaryText}. Does that all sound correct?`;

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

        } else {
            // If not all contact details are present, prompt for them.
            let missingFields = [];
            if (!fullName) missingFields.push("full name");
            if (!mobileNumber) missingFields.push("mobile number");
            if (!emailAddress) missingFields.push("email address");

            finalConfirmationPrompt = `I still need your ${missingFields.join(' and ')} to finalize the booking.`;

            // Keep the awaiting-guest-details context active
            outputContexts.push({
                name: `${session}/contexts/awaiting-guest-details`,
                lifespanCount: 2,
                parameters: { // Pass back what was collected to maintain state
                    person: fullName, 
                    'phone-number': mobileNumber,
                    email: emailAddress
                }
            });
        }

        return res.json({
            fulfillmentText: await generateGeminiReply(finalConfirmationPrompt),
            outputContexts: outputContexts
        });
    }

    // ✅ Confirm Booking Intent (NEW BLOCK - triggered after summary presented)
    if (intent === "Confirm Booking Intent") {
        console.log(`DEBUG: Entering Confirm Booking Intent.`);
        const bookingFlowCtx = findContext("booking-flow");
        if (!bookingFlowCtx) {
            console.error("❌ Confirm Booking Intent - Booking flow context missing!");
            return res.json({ fulfillmentText: await generateGeminiReply("I seem to have lost your booking details. Please start over.") });
        }

        const bookingDetails = bookingFlowCtx.parameters;

        let finalConfirmationPrompt;
        try {
            // Attempt to create the booking in Airtable
            const createdBookingRecord = await createBooking(bookingDetails);

            // If add-ons were selected, create records for them
            if (bookingDetails.selected_add_ons && bookingDetails.selected_add_ons.length > 0) {
                const allAvailableAddOns = await getAvailableAddOns(); // Fetch all add-ons to get their IDs
                await createBookingAddons(createdBookingRecord.id, bookingDetails.selected_add_ons, allAvailableAddOns);
            }

            // Generate a final confirmation message
            const { date, time } = formatDubai(bookingDetails.bookingUTC);
            const venueName = bookingDetails.venue || "the selected venue";
            const packagesSummary = bookingDetails.packages && bookingDetails.packages.length > 0 ? ` for ${bookingDetails.packages.join(' and ')}` : '';
            const addOnsSummary = bookingDetails.selected_add_ons && bookingDetails.selected_add_ons.length > 0 ? ` with ${bookingDetails.selected_add_ons.join(' and ')} as add-ons` : '';

            let totalPrice = '';
            if (bookingDetails.type === 'group' && bookingDetails.grand_total) {
                totalPrice = ` Your total is AED${bookingDetails.grand_total.toFixed(2)}.`;
            } else if (bookingDetails.type === 'table' && bookingDetails.grand_total > 0) {
                totalPrice = ` Your total is AED${bookingDetails.grand_total.toFixed(2)}.`;
            }

            // Use the full name from bookingDetails
            finalConfirmationPrompt = `Excellent, ${bookingDetails.full_name}! Your booking for ${bookingDetails.guestCount} guests at ${venueName} on ${date} at ${time}${packagesSummary}${addOnsSummary} is now confirmed!${totalPrice} A confirmation email will be sent to ${bookingDetails.email_id}. Thank you!`;

        } catch (error) {
            console.error("❌ Confirm Booking Intent - Error finalizing booking:", error.message);
            finalConfirmationPrompt = "I'm sorry, there was an issue finalizing your booking. Please try again or contact us directly.";
        }

        return res.json({
            fulfillmentText: await generateGeminiReply(finalConfirmationPrompt),
            outputContexts: [
                {
                    name: `${session}/contexts/booking-finalized`, // Indicate booking is complete
                    lifespanCount: 1,
                },
                {
                    name: `${session}/contexts/booking-flow`, // Clear/reset booking-flow context
                    lifespanCount: 0, 
                },
                {
                    name: `${session}/contexts/awaiting-final-confirmation`, // Clear this context
                    lifespanCount: 0, 
                }
            ]
        });
    }


    // Default fallback for unhandled intents (This must be the last return in the try block)
    return res.json({
      fulfillmentText: await generateGeminiReply("Sorry, I didn't get that. Can you repeat?"),
    });

  } catch (error) { // END OF TRY BLOCK, START OF CATCH BLOCK
    console.error("❌ Webhook error:", error);
    return res.status(500).json({
      fulfillmentText: await generateGeminiReply("I'm sorry, there was a technical issue. Please try again later."),
    });
  }
}); // CLOSING BRACE FOR app.post CALLBACK

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
