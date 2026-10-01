const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
const DATA = path.join(__dirname, "data.json");
const CYCLE = [500, 490, 480];

function load() { return JSON.parse(fs.readFileSync(DATA, "utf8")); }
function save(x) { fs.writeFileSync(DATA, JSON.stringify(x, null, 2)); }
function normalizePhone(p) {
  p = String(p || "").replace(/\s/g, "");
  if (/^0?7\d{8}$/.test(p)) return p.startsWith("0") ? "254" + p.slice(1) : "254" + p.slice(1);
  if (/^2547\d{8}$/.test(p)) return p;
  throw Error("Invalid M-Pesa number: " + p);
}
function balance(c) { return Math.max(0, Number(c.auth) - Number(c.paid || 0)); }
function nextAmount(c) {
  const bal = balance(c);
  if (bal <= 0) return 0;
  // step is advanced only by a successful callback. Imported paid balances
  // may include historical payments, so infer the next cycle position when possible.
  let step = Number.isInteger(c.step) ? c.step : 0;
  if (c.paid > 0 && step === 0) {
    if (c.paid === 500) step = 1;
    else if (c.paid === 990) step = 2;
  }
  return Math.min(CYCLE[Math.min(step, CYCLE.length - 1)], bal);
}
async function token() {
  const base = process.env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
  const r = await axios.get(base + "/oauth/v1/generate?grant_type=client_credentials", {
    auth: { username: process.env.MPESA_CONSUMER_KEY, password: process.env.MPESA_CONSUMER_SECRET }
  });
  return r.data.access_token;
}
function stamp() {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return d.toISOString().replace(/\D/g, "").slice(0, 14);
}
function configured() {
  return !!(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET && process.env.MPESA_PASSKEY && process.env.MPESA_SHORTCODE && process.env.MPESA_CALLBACK_URL);
}
function findCustomer(d, id) {
  for (const g of d.groups) {
    const c = g.customers.find(x => x.id === id);
    if (c) return { group: g, customer: c };
  }
  return null;
}

app.get("/api/health", (q, r) => r.json({ ok: true, configured: configured() }));
app.get("/api/groups", (q, r) => r.json(load()));

app.post("/api/import", (q, r) => {
  try {
    const { rows } = q.body;
    if (!Array.isArray(rows)) return r.status(400).json({ message: "rows required" });
    const groups = Array.from({ length: 16 }, (_, i) => ({ name: `Group ${i + 1}`, customers: [] }));
    for (let j = 0; j < rows.length; j++) {
      const x = rows[j];
      const m = /^Group\s+([1-9]|1[0-6])$/i.exec(String(x.group || ""));
      if (!m) throw Error(`Invalid group on row ${j + 1}`);
      const gi = Number(m[1]) - 1;
      if (groups[gi].customers.length >= 6) throw Error(`${groups[gi].name} exceeds 6 customers`);
      const phone = normalizePhone(x.phone);
      const auth = Number(x.auth), paid = Number(x.paid);
      if (!Number.isFinite(auth) || !Number.isFinite(paid) || auth < 0 || paid < 0 || paid > auth) throw Error(`Invalid amount on row ${j + 1}`);
      let step = 0;
      if (paid === 500) step = 1;
      else if (paid === 990) step = 2;
      groups[gi].customers.push({
        id: crypto.randomUUID(), name: x.name || "Customer", phone, auth, paid, step,
        status: paid >= auth ? "completed" : "pending", checkoutRequestId: null,
        lastReceipt: null, lastAmount: null, lastStk: null
      });
    }
    save({ groups });
    r.json({ ok: true });
  } catch (e) { r.status(400).json({ message: e.message }); }
});

app.post("/api/customer", (q, r) => {
  try {
    let { group, name, phone, auth } = q.body;
    const d = load(), g = d.groups[group];
    if (!g) return r.status(400).json({ message: "Invalid group" });
    if (g.customers.length >= 6) return r.status(400).json({ message: "Maximum 6 customers" });
    phone = normalizePhone(phone); auth = Number(auth);
    if (!Number.isFinite(auth) || auth <= 0) throw Error("Invalid authorized total");
    g.customers.push({ id: crypto.randomUUID(), name: name || "Customer", phone, auth, paid: 0, step: 0, status: "pending", checkoutRequestId: null, lastReceipt: null, lastAmount: null, lastStk: null });
    save(d); r.json({ ok: true });
  } catch (e) { r.status(400).json({ message: e.message }); }
});

async function sendStk(customer) {
  const amount = nextAmount(customer);
  if (amount <= 0) return { skipped: true, customerId: customer.id, reason: "zero_balance" };
  if (customer.status === "stk_requested" && customer.checkoutRequestId) return { skipped: true, customerId: customer.id, reason: "already_pending" };
  if (!configured()) throw Object.assign(new Error("Daraja server settings are incomplete"), { status: 503 });
  const ts = stamp();
  const password = Buffer.from(String(process.env.MPESA_SHORTCODE) + String(process.env.MPESA_PASSKEY) + ts).toString("base64");
  const base = process.env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
  const tok = await token();
  const body = {
    BusinessShortCode: String(process.env.MPESA_SHORTCODE), Password: password, Timestamp: ts,
    TransactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline", Amount: amount,
    PartyA: customer.phone, PartyB: String(process.env.MPESA_SHORTCODE), PhoneNumber: customer.phone,
    CallBackURL: process.env.MPESA_CALLBACK_URL, AccountReference: customer.name || "MPESA GROUP",
    TransactionDesc: "M-Pesa Groups payment"
  };
  const rr = await axios.post(base + "/mpesa/stkpush/v1/processrequest", body, { headers: { Authorization: "Bearer " + tok } });
  customer.checkoutRequestId = rr.data.CheckoutRequestID || null;
  customer.status = "stk_requested";
  customer.lastStk = Date.now();
  customer.lastAmount = amount;
  return { customerId: customer.id, amount, response: rr.data };
}

// Send STK prompts to every eligible customer in one selected group.
// Requests are launched together so each customer can receive their own prompt;
// each amount is calculated independently from that customer's remaining balance/cycle.
app.post("/api/stk-push-group", async (q, r) => {
  const groupIndex = Number(q.body?.group);
  const d = load();
  const g = d.groups[groupIndex];
  if (!g) return r.status(400).json({ message: "Invalid group" });
  if (!g.customers.length) return r.status(400).json({ message: "This group has no customers" });
  if (!configured()) return r.status(503).json({ message: "Daraja server settings are incomplete" });

  const eligible = g.customers.filter(c => balance(c) > 0 && !(c.status === "stk_requested" && c.checkoutRequestId));
  if (!eligible.length) return r.status(400).json({ message: "No eligible customers: all balances are zero or prompts are pending" });

  const results = await Promise.allSettled(eligible.map(c => sendStk(c)));
  const output = [];
  results.forEach((res, i) => {
    const c = eligible[i];
    if (res.status === "fulfilled") output.push({ name: c.name, ...res.value, ok: true });
    else output.push({ name: c.name, customerId: c.id, ok: false, error: res.reason?.response?.data || res.reason?.message || "STK request failed" });
  });
  save(d);
  const sent = output.filter(x => x.ok && !x.skipped).length;
  r.json({ ok: true, group: g.name, sent, eligible: eligible.length, results: output });
});

// Keep individual STK for troubleshooting/manual single-customer use.
app.post("/api/stk-push", async (q, r) => {
  try {
    const d = load(), found = findCustomer(d, q.body?.customerId);
    if (!found) return r.status(404).json({ message: "Customer not found" });
    if (balance(found.customer) <= 0) return r.status(400).json({ message: "Zero balance: STK is blocked" });
    const result = await sendStk(found.customer);
    save(d); r.json({ ok: true, amount: result.amount, ...(result.response || {}) });
  } catch (e) { r.status(e.status || e.response?.status || 500).json({ message: e.response?.data || e.message }); }
});

app.post("/api/mpesa/callback", (q, r) => {
  try {
    const c = q.body?.Body?.stkCallback;
    if (!c) return r.json({ ResultCode: 0, ResultDesc: "Accepted" });
    const d = load();
    const found = findCustomer(d, c.CheckoutRequestID);
    // Find by checkoutRequestId because callbacks arrive asynchronously.
    let target = null;
    for (const g of d.groups) for (const y of g.customers) if (y.checkoutRequestId === c.CheckoutRequestID) target = y;
    if (target && Number(c.ResultCode) === 0) {
      const items = c.CallbackMetadata?.Item || [];
      const receipt = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
      const amt = Number(items.find(i => i.Name === "Amount")?.Value || target.lastAmount || 0);
      target.paid = Math.min(target.auth, Number(target.paid || 0) + amt);
      target.lastReceipt = receipt || null;
      target.checkoutRequestId = null;
      target.lastAmount = amt;
      target.status = target.paid >= target.auth ? "completed" : "pending";
      target.step = Math.min(CYCLE.length - 1, Number(target.step || 0) + 1);
      save(d);
    } else if (target) {
      target.status = "failed";
      target.checkoutRequestId = null;
      save(d);
    }
    r.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (e) { r.json({ ResultCode: 0, ResultDesc: "Accepted" }); }
});

app.get("*", (q, r) => r.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(process.env.PORT || 3000, () => console.log("M-Pesa Groups server running"));
