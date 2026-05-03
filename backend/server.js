const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");

dotenv.config();

// ✅ CREATE APP FIRST (VERY IMPORTANT)
const app = express();
const PORT = process.env.PORT || 3000;

// ✅ MIDDLEWARE
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// Razorpay Instance
let razorpay;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} else {
  console.warn("WARNING: Razorpay keys not found in .env");
}

// Product Catalog for Backend Price Validation
// Replace these with your exact prices
const catalog = {
  "Lavender (Big Box)": 250,
  "Jawadhu (Big Box)": 250,
  "Hibiscus (Big Box)": 250,
  "Jasmine (Big Box)": 250,
  "Kewda (Big Box)": 250,
  "Sugandh (Big Box)": 250,
  "Sindhu (Big Box)": 250,
  "Banaras (Big Box)": 250,
  "Pineapple (Big Box)": 250,
  "Sambrani (Big Box)": 250,
  "Rose (Big Box)": 250,
  "Sandalwood (Big Box)": 250,
  "Kasturi (Big Box)": 250,
  "Jasmine (Small Box)": 189,
  "Kewda (Small Box)": 189,
  "Lavender (Small Box)": 189,
  "Rose (Small Box)": 189,
  "Sandalwood (Small Box)": 189,
  "Sandalwood (Dhoop)": 189,
  "Kewda (Dhoop)": 189,
  "Rose (Dhoop)": 189,
  "Lavender (Dhoop)": 189,
  "Sindhu (Dhoop)": 189
};

// ==========================================
// SERVE STATIC FRONTEND
// ==========================================
app.use(express.static('./'));

// ==========================================
// GOOGLE SHEETS HELPER
// ==========================================
async function saveToGoogleSheets(orderData) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    console.log("Google Sheets credentials missing. Skipping save.");
    return;
  }

  try {
    // Replace literal \n with actual newlines securely
    const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

    const auth = new google.auth.JWT(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      privateKey,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );

    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "Sheet1!A1", // Make sure Sheet1 is correct
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          orderData.orderId,
          orderData.customer.name,
          orderData.customer.phone,
          orderData.customer.address,
          orderData.cart.map(i => `${i.name} (${i.qty})`).join(", "),
          orderData.cart.reduce((sum, i) => sum + i.qty, 0),
          orderData.totalAmount / 100, // Convert paise to INR
          orderData.paymentId,
          "Success",
          new Date().toLocaleString()
        ]]
      }
    });
    console.log("Order saved to Google Sheets");
  } catch (error) {
    console.error("Google Sheets Error:", error);
  }
}

// ==========================================
// NODEMAILER HELPER
// ==========================================
async function sendOrderEmail(orderData) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log("Email credentials missing. Skipping email.");
    return;
  }

  try {
    let transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const cartHtml = orderData.cart.map(item => {
      const price = catalog[item.name] || 0;
      return `
        <tr>
          <td style="padding:8px; border:1px solid #ddd;">${item.name}</td>
          <td style="padding:8px; border:1px solid #ddd; text-align:center;">${item.qty}</td>
          <td style="padding:8px; border:1px solid #ddd; text-align:right;">Rs. ${price * item.qty}</td>
        </tr>
      `;
    }).join("");

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER, // Send to store admin
      subject: "New Order Received - ARA Store",
      html: `
        <h2>New Order Confirmed</h2>
        <p><strong>Order ID:</strong> ${orderData.orderId}</p>
        <p><strong>Payment ID:</strong> ${orderData.paymentId}</p>
        <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
        <hr>
        <h3>Customer Details</h3>
        <p><strong>Name:</strong> ${orderData.customer.name}</p>
        <p><strong>Phone:</strong> ${orderData.customer.phone}</p>
        <p><strong>Address:</strong> ${orderData.customer.address}</p>
        <hr>
        <h3>Order Items</h3>
        <table style="border-collapse: collapse; width: 100%; max-width: 600px;">
          <thead>
            <tr style="background:#fdf5e6;">
              <th style="padding:8px; border:1px solid #ddd; text-align:left;">Product</th>
              <th style="padding:8px; border:1px solid #ddd;">Quantity</th>
              <th style="padding:8px; border:1px solid #ddd; text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${cartHtml}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="padding:8px; border:1px solid #ddd; text-align:right; font-weight:bold;">Total Amount:</td>
              <td style="padding:8px; border:1px solid #ddd; text-align:right; font-weight:bold;">Rs. ${orderData.totalAmount / 100}</td>
            </tr>
          </tfoot>
        </table>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log("Email sent successfully");
  } catch (error) {
    console.error("Nodemailer Error:", error);
  }
}

// ==========================================
// WEBHOOK ENDPOINT (Needs Raw Body)
// ==========================================
app.post('/api/razorpay-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(200).send("Webhook secret not configured.");

  const signature = req.headers['x-razorpay-signature'];
  const expectedSignature = crypto.createHmac('sha256', secret)
    .update(req.body)
    .digest('hex');

  if (expectedSignature === signature) {
    // Process Webhook (e.g., payment.captured)
    try {
      const event = JSON.parse(req.body);
      console.log("Valid Webhook Received:", event.event);
    } catch (e) {
      console.error(e);
    }
    res.status(200).json({ status: "ok" });
  } else {
    res.status(400).send('Invalid signature');
  }
});

// JSON Middleware for the rest of the endpoints
app.use(express.json());

// ==========================================
// CREATE ORDER
// ==========================================
app.post('/api/create-order', async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(500).json({ error: "Payment gateway is not configured on the server." });
    }

    const { cart } = req.body;

    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // Backend price validation
    let totalAmountInINR = 0;
    cart.forEach(item => {
      const itemPrice = catalog[item.name];
      if (!itemPrice) {
        throw new Error(`Product ${item.name} not found in catalog.`);
      }
      totalAmountInINR += itemPrice * item.qty;
    });

    const amountInPaise = totalAmountInINR * 100;

    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);

    res.json({
      orderId: order.id,
      amount: amountInPaise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID
    });

  } catch (error) {
    console.error("Create Order Error:", error);
    res.status(500).json({ error: error.message || "Failed to create order" });
  }
});

// ==========================================
// VERIFY PAYMENT & PROCESS ORDER
// ==========================================
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      customer,
      cart,
      amount
    } = req.body;

    // Verify Signature
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Package data
    const orderData = {
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      customer: customer,
      cart: cart,
      totalAmount: amount
    };

    // Process asynchronously (do not block the user response)
    saveToGoogleSheets(orderData);
    sendOrderEmail(orderData);

    res.json({ success: true, message: "Payment verified and order processed." });

  } catch (error) {
    console.error("Verify Payment Error:", error);
    res.status(500).json({ error: "Failed to process order" });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
