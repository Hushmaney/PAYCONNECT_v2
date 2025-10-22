import express from "express";
import axios from "axios";
// import Airtable from "airtable"; // REMOVED: No longer needed for Baserow
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors()); // allow cross-origin requests from frontend

// ----------------- BASEROW SETUP -----------------
// Use environment variables directly
const BASEROW_HOST_URL = process.env.BASEROW_HOST_URL;
const BASEROW_API_KEY = process.env.BASEROW_API_KEY;
const BASEROW_TABLE_ID = process.env.BASEROW_TABLE_ID;

// Define helper function for authentication headers
const baserowHeaders = {
    'Authorization': `Token ${BASEROW_API_KEY}`,
    'Content-Type': 'application/json'
};
// ----------------- END BASEROW SETUP -----------------


// ----------------- TEST ROUTE -----------------
app.get("/test", (req, res) => {
  res.json({
    ok: true,
    message: "PAYCONNECT backend is live 🎉",
    env: {
      BULKCLIX_API_KEY: process.env.BULKCLIX_API_KEY ? "✅ Loaded" : "❌ Missing",
      // Updated to check Baserow key instead of Airtable key
      BASEROW_API_KEY: process.env.BASEROW_API_KEY ? "✅ Loaded" : "❌ Missing", 
      HUBTEL_CLIENT_ID: process.env.HUBTEL_CLIENT_ID ? "✅ Loaded" : "❌ Missing",
      HUBTEL_CLIENT_SECRET: process.env.HUBTEL_CLIENT_SECRET ? "✅ Loaded" : "❌ Missing"
    }
  });
});

// ----------------- START CHECKOUT (BulkClix MOMO) -----------------
app.post("/api/start-checkout", async (req, res) => {
  try {
    const { email, phone, recipient, dataPlan, amount, network } = req.body; 

    if (!phone || !recipient || !dataPlan || !amount || !network) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    // Generate a unique transaction ID
    const transaction_id = "T" + Math.floor(Math.random() * 1e15);

    // Call BulkClix API to initiate Momo payment (UNCHANGED)
    let response;
    try {
      response = await axios.post(
        "https://api.bulkclix.com/api/v1/payment-api/momopay",
        {
          amount,
          phone_number: phone,
          network, 
          transaction_id,
          callback_url: "https://payconnect-v2.onrender.com/api/payment-webhook",
          reference: "PAYCONNECT"
        },
        {
          headers: {
            "x-api-key": process.env.BULKCLIX_API_KEY,
            "Accept": "application/json"
          },
          timeout: 10000
        }
      );
    } catch (apiErr) {
      console.error("BulkClix API Error:", apiErr.response?.data || apiErr.message);
      return res.status(500).json({
        ok: false,
        error: "BulkClix API error: " + (apiErr.response?.data?.message || apiErr.message)
      });
    }

    // Check BulkClix response
    const apiData = response.data?.data;
    if (!apiData || !apiData.transaction_id) {
      console.error("BulkClix unexpected response:", response.data);
      return res.status(500).json({ ok: false, error: "Failed to initiate BulkClix payment" });
    }

    // 🎯 REWRITE: Create initial BASEROW record (Replaced Airtable logic)
    try {
        const createUrl = `${BASEROW_HOST_URL}/api/database/rows/table/${BASEROW_TABLE_ID}/?user_field_names=true`;

        await axios.post(
            createUrl,
            {
                "Order ID": transaction_id,
                "Customer Phone": phone,
                "Customer Email": email,
                "Data Recipient Number": recipient,
                "Data Plan": dataPlan,
                "Amount": amount,
                "Status": "Initiated", // Use the option value
                "BulkClix Response": JSON.stringify({ initiation: response.data })
            },
            { headers: baserowHeaders }
        );
    } catch (dbErr) {
        console.error("Baserow Create Error:", dbErr.response?.data || dbErr.message);
        // We log the error but still proceed with the response since the payment initiation succeeded
        // The user can still check status later
    }


    // ✅ Send successful response back to frontend
    res.json({
      ok: true,
      message: "Payment initiated successfully",
      data: {
        transaction_id: apiData.transaction_id,
        amount: apiData.amount,
        phone: apiData.phone_number,
        status: "Initiated" 
      }
    });

  } catch (err) {
    console.error("Start Checkout Outer Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ----------------- PAYMENT WEBHOOK -----------------
// Called by BulkClix after payment confirmation
app.post("/api/payment-webhook", async (req, res) => {
  try {
    let { amount, status, transaction_id, phone_number } = req.body; 

    if (!transaction_id || !phone_number || !amount || !status) {
      return res.status(400).json({ ok: false, error: "Missing payment data" });
    }

    // 🎯 STEP 1: Find the existing Baserow record using the Order ID
    const filterUrl = `${BASEROW_HOST_URL}/api/database/rows/table/${BASEROW_TABLE_ID}/?user_field_names=true&filter__Order%20ID__equal=${transaction_id}`;

    const baserowFindResponse = await axios.get(filterUrl, { headers: baserowHeaders });
    const records = baserowFindResponse.data.results;

    if (records.length === 0) {
        console.error("Webhook Error: Could not find matching Baserow record for:", transaction_id);
        return res.status(200).json({ ok: false, error: "Record not found. Webhook acknowledged." });
    }
    
    const record = records[0];
    const baserowRowId = record.id; // CRITICAL: Get the internal Baserow row ID for updating
    
    // Baserow fields are accessed directly as properties
    const dataPlanFromAirtable = record["Data Plan"]; 
    const recipientFromAirtable = record["Data Recipient Number"]; 
    
    
    // Override status to "Pending" ONLY for successful payments.
    const orderStatus = status.toLowerCase() === "success" ? "Pending" : status;

    // Ensure amount is a number
    amount = Number(amount);
    if (isNaN(amount)) return res.status(400).json({ ok: false, error: "Invalid amount value" });

    // 1️⃣ Update Baserow record with final status and webhook data
    const updateUrl = `${BASEROW_HOST_URL}/api/database/rows/table/${BASEROW_TABLE_ID}/${baserowRowId}/?user_field_names=true`;

    await axios.patch(
        updateUrl,
        {
            "Amount": amount, 
            "Status": orderStatus, // Status field
            "BulkClix Response": JSON.stringify(req.body) 
        },
        { headers: baserowHeaders }
    );

    // We only send SMS on successful status (Pending). 
    if (orderStatus === "Pending") {
        
        // ⭐ Determine delivery timeframe 
        let deliveryTimeframe = "30 minutes to 4 hours"; // Default for Normal
        // Check if the dataPlan string contains the "(Express)" tag
        if (dataPlanFromAirtable && dataPlanFromAirtable.includes("(Express)")) {
            deliveryTimeframe = "5 to 30 minutes";
        }

        // ⭐ Use the dynamic delivery timeframe in the SMS content
        const smsContent = `Your data purchase of ${dataPlanFromAirtable} for ${recipientFromAirtable} has been processed and will be delivered in ${deliveryTimeframe}. Order ID: ${transaction_id}. For support, WhatsApp: 233531300654`;

        // 2️⃣ Send SMS via Hubtel to Customer Phone (UNCHANGED)
        const smsUrl = `https://smsc.hubtel.com/v1/messages/send?clientsecret=${process.env.HUBTEL_CLIENT_SECRET}&clientid=${process.env.HUBTEL_CLIENT_ID}&from=PAYCONNECT&to=${phone_number}&content=${encodeURIComponent(smsContent)}`;

        const smsResponse = await axios.get(smsUrl);

        // 3️⃣ Update Baserow with Hubtel SMS response
        await axios.patch(
            updateUrl,
            {
                "Hubtel Response": JSON.stringify(smsResponse.data),
                "Hubtel Sent": true,
            },
            { headers: baserowHeaders }
        );
    }

    res.json({ ok: true, message: "Payment received & record updated" });

  } catch (err) {
    console.error("Payment Webhook Error:", err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data || err.message });
  }
});

// ----------------- CHECK PAYMENT STATUS -----------------
app.get("/api/check-status/:transaction_id", async (req, res) => {
  try {
    const { transaction_id } = req.params;

    // 1. Query Baserow for the record
    const filterUrl = `${BASEROW_HOST_URL}/api/database/rows/table/${BASEROW_TABLE_ID}/?user_field_names=true&filter__Order%20ID__equal=${transaction_id}`;

    const baserowFindResponse = await axios.get(filterUrl, { headers: baserowHeaders });
    const records = baserowFindResponse.data.results;

    if (records.length === 0) {
        return res.status(404).json({ 
            ok: false, 
            error: "Transaction record not found in Baserow." 
        });
    }
    
    const record = records[0];
    
    // 2. Extract the Status field from the Baserow record
    // Baserow returns the Status as an object, we need the "value" property.
    const baserowStatusObject = record["Status"]; 
    const currentStatus = baserowStatusObject ? baserowStatusObject.value : 'Unknown';

    // 3. Send the status back to the frontend
    res.json({ 
        ok: true, 
        data: { 
            status: currentStatus, 
            transaction_id: transaction_id
        } 
    });

  } catch (err) {
    console.error("Check Status Error:", err.message);
    res.status(500).json({ ok: false, error: "Internal server error while checking status." });
  }
});

// ----------------- CANCEL TRANSACTION -----------------
// Called by the frontend when the user clicks "Cancel Transaction"
app.post("/api/cancel-transaction/:transaction_id", async (req, res) => {
    try {
        const { transaction_id } = req.params;

        // 1. Find the existing Baserow record using the Order ID
        const filterUrl = `${BASEROW_HOST_URL}/api/database/rows/table/${BASEROW_TABLE_ID}/?user_field_names=true&filter__Order%20ID__equal=${transaction_id}`;

        const baserowFindResponse = await axios.get(filterUrl, { headers: baserowHeaders });
        const records = baserowFindResponse.data.results;

        if (records.length === 0) {
            console.warn(`Attempted to cancel non-existent transaction: ${transaction_id}`);
            return res.status(404).json({ 
                ok: false, 
                error: "Transaction record not found to cancel." 
            });
        }
        
        const record = records[0];
        const baserowRowId = record.id;
        
        // 2. Update the Status field to "Failed" in Baserow
        const updateUrl = `${BASEROW_HOST_URL}/api/database/rows/table/${BASEROW_TABLE_ID}/${baserowRowId}/?user_field_names=true`;

        await axios.patch(
            updateUrl,
            {
                "Status": "Failed",
            },
            { headers: baserowHeaders }
        );
        
        console.log(`Transaction ${transaction_id} marked as Failed by user cancellation.`);

        // 3. Send success response back to frontend
        res.json({ 
            ok: true, 
            message: "Transaction status successfully updated to Failed." 
        });

    } catch (err) {
        console.error("Cancel Transaction Error:", err.message);
        res.status(500).json({ ok: false, error: "Internal server error during cancellation." });
    }
});


// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`PAYCONNECT backend listening on port ${PORT}`));