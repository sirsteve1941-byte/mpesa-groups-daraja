import 'dotenv/config';
import path from 'path';
import express from 'express';
import { Pool } from 'pg';
import rateLimit from 'express-rate-limit';
import * as L from './lib';
import { buildStkBody, parseCallback, configProblems } from './mpesa';
const E = process.env, isProd = E.MPESA_ENV === 'production';
const pool = new Pool({ connectionString: E.DATABASE_URL, ssl: E.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false });
const q = (t: string, p?: any[]) => pool.query(t, p);
const ev = (k: string) => isProd ? null : q('INSERT INTO events(kind,count,last_at) VALUES($1,1,now()) ON CONFLICT(kind) DO UPDATE SET count=events.count+1,last_at=now()', [k]);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const ah = (f: any) => (req: any, res: any, next: any) => f(req, res, next).catch(next);
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  if (req.path === '/api/health' || req.path === '/api/mpesa/callback') return next();
  if (!E.ADMIN_PASSWORD) return isProd ? res.status(503).json({ error: 'Set ADMIN_PASSWORD to enable the app in production' }) : next();
  const dec = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString();
  if (dec.slice(dec.indexOf(':') + 1) === E.ADMIN_PASSWORD && dec.includes(':')) return next();
  res.set('WWW-Authenticate', 'Basic realm="M-Pesa Groups"').status(401).send('Authentication required');
});
app.use('/api', rateLimit({ windowMs: 60000, limit: 300, skip: r => r.path === '/mpesa/callback' }));
const stkLimit = rateLimit({ windowMs: 60000, limit: 30, message: { error: 'Too many payment requests, slow down' } });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups(id INT PRIMARY KEY CHECK(id BETWEEN 1 AND 16), name TEXT NOT NULL);
INSERT INTO groups SELECT g,'Group '||g FROM generate_series(1,16) g ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS customers(id SERIAL PRIMARY KEY, group_id INT NOT NULL REFERENCES groups(id), name TEXT NOT NULL, phone TEXT NOT NULL,
 authorized INT NOT NULL CHECK(authorized>0), paid INT NOT NULL DEFAULT 0 CHECK(paid>=0), cycle_step INT NOT NULL DEFAULT 0,
 pending_checkout_id TEXT, pending_since TIMESTAMPTZ, last_receipt TEXT, last_status TEXT, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(group_id,phone));
CREATE OR REPLACE FUNCTION enforce_group_limit() RETURNS trigger AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(NEW.group_id);
 IF (SELECT count(*) FROM customers WHERE group_id=NEW.group_id AND id<>COALESCE(NEW.id,-1))>=6 THEN RAISE EXCEPTION 'group_full' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS customers_group_limit ON customers;
CREATE TRIGGER customers_group_limit BEFORE INSERT OR UPDATE OF group_id ON customers FOR EACH ROW EXECUTE FUNCTION enforce_group_limit();
CREATE TABLE IF NOT EXISTS events(kind TEXT PRIMARY KEY, count INT NOT NULL DEFAULT 0, last_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS payments(id SERIAL PRIMARY KEY, customer_id INT REFERENCES customers(id) ON DELETE CASCADE, amount INT NOT NULL, status TEXT NOT NULL,
 merchant_request_id TEXT, checkout_request_id TEXT UNIQUE, receipt TEXT, result_code INT, result_desc TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());`;

const view = c => {
  const bal = L.balance(c), pend = !!c.pending_checkout_id && (!c.pending_since || Date.now() - new Date(c.pending_since).getTime() < 600000);
  const status = bal <= 0 ? 'Completed' : pend ? 'Pending' : c.last_status === 'cancelled' ? 'Cancelled' : c.last_status === 'failed' ? 'Failed' : 'Ready';
  return { id: c.id, group: c.group_id, name: c.name, phone: c.phone, authorized: c.authorized, paid: c.paid, balance: bal, nextAmount: L.nextAmount(c), cycleStep: c.cycle_step, status, lastReceipt: c.last_receipt };
};

// ---- Daraja ----
const base = () => isProd ? 'https://api.safaricom.co.ke' : (E.MPESA_BASE_URL || 'https://sandbox.safaricom.co.ke');
let tok = { v: null, exp: 0 };
async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const r = await fetch(base() + '/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: 'Basic ' + Buffer.from(E.MPESA_CONSUMER_KEY + ':' + E.MPESA_CONSUMER_SECRET).toString('base64') } });
  if (!r.ok) throw new Error('OAuth failed (HTTP ' + r.status + '), check consumer key/secret and MPESA_ENV');
  const d = await r.json();
  tok = { v: d.access_token, exp: Date.now() + (Number(d.expires_in || 3599) - 60) * 1000 };
  return tok.v;
}
async function daraja(c, amount) {
  const t = await token(), ts = new Date(Date.now() + 3 * 3600e3).toISOString().replace(/\D/g, '').slice(0, 14);
  const r = await fetch(base() + '/mpesa/stkpush/v1/processrequest', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(buildStkBody(E, isProd, c, amount, ts)) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

async function sendPrompt(id) {
  const out = (c, amount, result, detail, extra = {}) => ({ customerId: c?.id, customer: c?.name, amount, result, detail, ...extra });
  const { rows: [c] } = await q(`UPDATE customers SET pending_checkout_id='LOCK',pending_since=now() WHERE id=$1 AND (pending_checkout_id IS NULL OR pending_since<now()-interval '10 minutes') RETURNING *`, [id]);
  if (!c) {
    const { rows: [e] } = await q('SELECT * FROM customers WHERE id=$1', [id]);
    return e ? out(e, L.nextAmount(e), 'skipped', 'Pending STK request already exists') : out(null, 0, 'failed', 'Customer not found');
  }
  const release = (s?: string) => q('UPDATE customers SET pending_checkout_id=NULL,pending_since=NULL,last_status=COALESCE($2,last_status) WHERE id=$1', [c.id, s || null]);
  const amount = L.nextAmount(c);
  if (amount <= 0) { await release(); return out(c, 0, 'skipped', 'Balance is zero'); }
  if (!L.normPhone(c.phone)) { await release(); return out(c, amount, 'failed', 'Invalid phone number, not sent to Safaricom'); }
  const problems = configProblems(E, isProd);
  if (problems.length) { await release(); return out(c, amount, 'failed', 'Server not configured: ' + problems.join('; ')); }
  if (isProd && E.PRODUCTION_VERIFIED !== 'true') { await release(); return out(c, amount, 'failed', 'Production is locked: finish the sandbox verification checklist, then set PRODUCTION_VERIFIED=true'); }
  let r;
  try { r = await daraja(c, amount); } catch (e) { await release('failed'); log('STK error customer', c.id, e.message); return out(c, amount, 'failed', 'Safaricom request error: ' + e.message); }
  const d = r.data, desc = d.ResponseDescription || d.errorMessage || 'HTTP ' + r.status;
  log('STK customer', c.id, 'http', r.status, 'ResponseCode', d.ResponseCode || d.errorCode, 'desc', desc, 'MRID', d.MerchantRequestID, 'CRID', d.CheckoutRequestID);
  if (r.status === 200 && d.ResponseCode === '0') {
    try {
      await q(`INSERT INTO payments(customer_id,amount,status,merchant_request_id,checkout_request_id,result_code,result_desc) VALUES($1,$2,'pending',$3,$4,0,$5)`, [c.id, amount, d.MerchantRequestID, d.CheckoutRequestID, desc]);
      await q('UPDATE customers SET pending_checkout_id=$2 WHERE id=$1', [c.id, d.CheckoutRequestID]);
    } catch (e: any) {
      // The external STK request may already have succeeded. Reconcile by
      // CheckoutRequestID before leaving the customer locked.
      try {
        const { rows: [existing] } = await q('SELECT id FROM payments WHERE checkout_request_id=$1', [d.CheckoutRequestID]);
        if (existing) {
          await q('UPDATE customers SET pending_checkout_id=$2,pending_since=now() WHERE id=$1', [c.id, d.CheckoutRequestID]);
          log('Recovered recorded STK after local write error. customer', c.id, 'CRID', d.CheckoutRequestID);
          return out(c, amount, 'sent', 'Prompt sent and payment record recovered', { checkoutRequestId: d.CheckoutRequestID, recovered: true });
        }
      } catch (reconcileError: any) { log('CRITICAL: STK reconciliation failed. customer', c.id, 'CRID', d.CheckoutRequestID, reconcileError.message); }
      // Keep the temporary lock for its 10-minute safety window. This avoids
      // accidentally sending a duplicate prompt while the operator checks
      // the Safaricom transaction. It expires automatically.
      log('CRITICAL: STK sent but not recorded. customer', c.id, 'CRID', d.CheckoutRequestID, e.message);
      return out(c, amount, 'failed', 'Prompt sent but could not be recorded; check Safaricom statement before retrying');
    }
    await ev('stk_accepted');
    return out(c, amount, 'sent', d.CustomerMessage || desc, { checkoutRequestId: d.CheckoutRequestID });
  }
  await q(`INSERT INTO payments(customer_id,amount,status,merchant_request_id,result_code,result_desc) VALUES($1,$2,'failed',$3,$4,$5)`, [c.id, amount, d.MerchantRequestID || null, Number(d.ResponseCode) || null, desc]);
  await release('failed');
  return out(c, amount, 'failed', 'Safaricom: ' + desc, { httpStatus: r.status, responseCode: d.ResponseCode || d.errorCode });
}

app.post('/api/stk-push', stkLimit, ah(async (req, res) => {
  const id = Number(req.body.customerId); if (!Number.isInteger(id)) return res.status(400).json({ error: 'customerId required' });
  const r = await sendPrompt(id); res.status(r.result === 'sent' ? 200 : r.result === 'skipped' ? 409 : r.detail === 'Customer not found' ? 404 : 502).json(r);
}));
app.post('/api/stk-push-group', stkLimit, ah(async (req, res) => {
  const g = Number(req.body.groupId); if (!Number.isInteger(g) || g < 1 || g > 16) return res.status(400).json({ error: 'groupId must be 1-16' });
  const { rows } = await q('SELECT id FROM customers WHERE group_id=$1 ORDER BY id', [g]);
  const results = []; for (const { id } of rows) results.push(await sendPrompt(id));
  const n = k => results.filter(r => r.result === k).length;
  res.json({ group: g, sent: n('sent'), failed: n('failed'), skipped: n('skipped'), results });
}));

async function processCallback(cb: NonNullable<ReturnType<typeof parseCallback>>) {
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const { rows: [p] } = await cl.query(`UPDATE payments SET status=$2,result_code=$3,result_desc=$4,receipt=$5,updated_at=now() WHERE checkout_request_id=$1 AND status='pending' RETURNING *`, [cb.checkoutRequestId, cb.status, cb.code, cb.desc, cb.receipt]);
    if (!p) { await cl.query('ROLLBACK'); log('Callback ignored (unknown or already processed)', cb.checkoutRequestId); await ev('callback_duplicate'); return; }
    const clear = `pending_checkout_id=CASE WHEN pending_checkout_id=$1 THEN NULL ELSE pending_checkout_id END, pending_since=CASE WHEN pending_checkout_id=$1 THEN NULL ELSE pending_since END`;
    if (cb.code === 0) {
      if (cb.amount && cb.amount !== p.amount) log('WARNING callback amount differs', cb.checkoutRequestId, 'expected', p.amount, 'got', cb.amount);
      // Credit exactly the amount our server recorded for this checkout.
      // Safaricom callback metadata is used for verification/logging, not for
      // changing the amount that was actually authorized by this payment row.
      await cl.query(`UPDATE customers SET paid=LEAST(authorized,paid+$2),cycle_step=cycle_step+1,last_receipt=$3,last_status='completed',${clear} WHERE id=$4`, [cb.checkoutRequestId, p.amount, cb.receipt, p.customer_id]);
    } else await cl.query(`UPDATE customers SET last_status=$2,${clear} WHERE id=$3`, [cb.checkoutRequestId, cb.status, p.customer_id]);
    await cl.query('COMMIT');
    log('Callback', cb.checkoutRequestId, cb.status, 'code', cb.code);
    await ev(cb.code === 0 ? 'callback_completed' : 'callback_failed');
  } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
}
app.post('/api/mpesa/callback', (req, res) => {
  if (E.MPESA_CALLBACK_TOKEN && req.query.token !== E.MPESA_CALLBACK_TOKEN) { log('Callback rejected: bad token'); return res.status(403).json({ ResultCode: 1, ResultDesc: 'Forbidden' }); }
  const cb = parseCallback(req.body);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  if (cb) processCallback(cb).catch(e => log('CRITICAL callback processing failed', cb.checkoutRequestId, e.message));
});

// ---- Groups & customers ----
const all = async () => (await q('SELECT * FROM customers ORDER BY group_id,id')).rows.map(view);
app.get('/api/groups', ah(async (req, res) => {
  const cs = await all(), t = { customers: cs.length, completed: 0, pending: 0, authorized: 0, paid: 0, balance: 0 };
  const groups = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, name: 'Group ' + (i + 1), count: 0, max: 6, authorized: 0, paid: 0, balance: 0, completed: 0, pending: 0 }));
  for (const c of cs) {
    const g = groups[c.group - 1]; g.count++; g.authorized += c.authorized; g.paid += c.paid; g.balance += c.balance;
    if (c.status === 'Completed') { g.completed++; t.completed++; } if (c.status === 'Pending') { g.pending++; t.pending++; }
    t.authorized += c.authorized; t.paid += c.paid; t.balance += c.balance;
  }
  res.json({ groups, totals: t });
}));
app.get('/api/groups/:id', ah(async (req, res) => {
  const g = Number(req.params.id); if (!Number.isInteger(g) || g < 1 || g > 16) return res.status(404).json({ error: 'Group not found' });
  res.json({ id: g, max: 6, customers: (await q('SELECT * FROM customers WHERE group_id=$1 ORDER BY id', [g])).rows.map(view) });
}));
app.get('/api/customers', ah(async (req, res) => res.json(await all())));
app.get('/api/customers/:id', ah(async (req, res) => {
  const { rows: [c] } = await q('SELECT * FROM customers WHERE id=$1', [Number(req.params.id) || 0]);
  c ? res.json(view(c)) : res.status(404).json({ error: 'Customer not found' });
}));
function parseCust(b) {
  const phone = L.normPhone(b.phone), a = Number(b.authorized), p = Number(b.paid || 0), g = Number(b.group), err = [];
  if (!Number.isInteger(g) || g < 1 || g > 16) err.push('Group must be 1 to 16');
  if (!String(b.name || '').trim()) err.push('Name required');
  if (!phone) err.push('Invalid M-Pesa number');
  if (!Number.isInteger(a) || a <= 0) err.push('Authorized total must be a positive whole number');
  if (!Number.isInteger(p) || p < 0 || p > a) err.push('Paid must be between 0 and authorized total');
  return { err, g, name: String(b.name || '').trim().slice(0, 80), phone, a, p };
}
const saveCust = (mode) => ah(async (req, res) => {
  const v = parseCust(req.body); if (v.err.length) return res.status(400).json({ errors: v.err });
  const id = Number(req.params.id) || 0;
  const { rows: [n] } = await q('SELECT count(*)::int n FROM customers WHERE group_id=$1 AND id<>$2', [v.g, id]);
  if (n.n >= 6) return res.status(422).json({ errors: [`Group ${v.g} is full (maximum 6 customers)`] });
  try {
    const r = mode === 'new'
      ? await q('INSERT INTO customers(group_id,name,phone,authorized,paid,cycle_step) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [v.g, v.name, v.phone, v.a, v.p, L.stepFromPaid(v.p)])
      : await q('UPDATE customers SET group_id=$2,name=$3,phone=$4,authorized=$5,paid=$6,cycle_step=$7 WHERE id=$1 RETURNING *', [id, v.g, v.name, v.phone, v.a, v.p, L.stepFromPaid(v.p)]);
    r.rows[0] ? res.status(mode === 'new' ? 201 : 200).json(view(r.rows[0])) : res.status(404).json({ error: 'Customer not found' });
  } catch (e) { if (e.code === '23514') return res.status(422).json({ errors: [`Group ${v.g} is full (maximum 6 customers)`] }); if (e.code === '23505') return res.status(409).json({ errors: ['This phone number already exists in the group'] }); throw e; }
});
app.post('/api/customers', saveCust('new'));
app.put('/api/customers/:id', saveCust('edit'));
app.delete('/api/customers/:id', ah(async (req, res) => {
  const r = await q(`DELETE FROM customers WHERE id=$1 AND (pending_checkout_id IS NULL OR pending_since<now()-interval '10 minutes')`, [Number(req.params.id) || 0]);
  r.rowCount ? res.status(204).end() : res.status(409).json({ error: 'Customer not found or has a pending STK request' });
}));

app.post('/api/import', ah(async (req, res) => {
  const ex: Record<string, string[]> = {}; (await q('SELECT group_id,phone FROM customers')).rows.forEach(r => (ex[r.group_id] ??= []).push(r.phone));
  const v = L.validateCsv(String(req.body.csv || ''), ex);
  if (v.errors.length || req.body.dryRun) return res.status(v.errors.length ? 422 : 200).json({ ...v, imported: 0 });
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    for (const r of v.rows) await cl.query('INSERT INTO customers(group_id,name,phone,authorized,paid,cycle_step) VALUES($1,$2,$3,$4,$5,$6)', [r.grp, r.name, r.phone, r.a, r.p, L.stepFromPaid(r.p)]);
    await cl.query('COMMIT');
  } catch (e) { await cl.query('ROLLBACK'); if (e.code === '23514') return res.status(422).json({ ...v, errors: ['A group would exceed 6 customers. Nothing imported.'], imported: 0 }); throw e; } finally { cl.release(); }
  res.json({ ...v, imported: v.rows.length });
}));

app.get('/api/payments', ah(async (req, res) => {
  const cid = Number(req.query.customerId) || null;
  res.json((await q(`SELECT p.*,c.name customer,c.group_id "group" FROM payments p JOIN customers c ON c.id=p.customer_id WHERE ($1::int IS NULL OR p.customer_id=$1) ORDER BY p.id DESC LIMIT 300`, [cid])).rows);
}));
app.get('/api/health', ah(async (req, res) => { await q('SELECT 1'); res.json({ ok: true, env: isProd ? 'production' : 'sandbox', productionUnlocked: !isProd || E.PRODUCTION_VERIFIED === 'true', configProblems: configProblems(E, isProd) }); }));
app.get('/api/verification', ah(async (req, res) => {
  const seen = new Map((await q('SELECT kind,count,last_at FROM events')).rows.map((r: any) => [r.kind, r]));
  const L2: [string, string][] = [['stk_accepted', 'Sandbox STK Push accepted by Safaricom'], ['callback_completed', 'Successful callback received and payment credited once'], ['callback_failed', 'Failed or cancelled callback received, paid amount unchanged'], ['callback_duplicate', 'Repeated callback ignored (no double count)']];
  const checks = L2.map(([key, label]) => ({ key, label, done: seen.has(key), count: (seen.get(key) as any)?.count || 0 }));
  res.json({ env: isProd ? 'production' : 'sandbox', checks, allDone: checks.every(c => c.done) });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(process.cwd(), 'client/dist')));
app.use((err: any, req: any, res: any, next: any) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  log('ERROR', req.method, req.path, err.message); res.status(500).json({ error: 'Internal server error' });
});
q(SCHEMA).then(() => app.listen(E.PORT || 3000, () => log('M-Pesa Groups on', E.PORT || 3000, isProd ? 'PRODUCTION' : 'sandbox')))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
