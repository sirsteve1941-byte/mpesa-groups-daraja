// End-to-end test against REAL Postgres + the real server, with Safaricom mocked locally.
// Run on a THROWAWAY database:  DATABASE_URL=postgres://... npm run test:integration
import http from 'http'; import { spawn } from 'child_process'; import a from 'assert';
if (!process.env.DATABASE_URL) { console.log('SKIP: set DATABASE_URL (throwaway database) to run'); process.exit(0); }
const sent: any[] = []; let n = 0;
const daraja = http.createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { s.setHeader('content-type', 'application/json');
  if (q.url!.startsWith('/oauth')) return s.end(JSON.stringify({ access_token: 'test-token', expires_in: '3599' }));
  const body = JSON.parse(b); sent.push(body); n++; s.end(JSON.stringify({ MerchantRequestID: 'm' + n, CheckoutRequestID: 'ws_CO_' + n, ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'Success' })); }); }).listen(4010);
const env = { ...process.env, PORT: '3100', MPESA_ENV: 'sandbox', MPESA_BASE_URL: 'http://localhost:4010', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_PASSKEY: 'p', MPESA_BUSINESS_SHORTCODE: '174379', MPESA_TILL_NUMBER: '1739052', MPESA_TRANSACTION_TYPE: 'CustomerPayBillOnline', MPESA_CALLBACK_URL: 'https://example.test/api/mpesa/callback', MPESA_CALLBACK_TOKEN: 'tok', ADMIN_PASSWORD: '' };
const srv = spawn('npx', ['tsx', 'src/server.ts'], { env, stdio: 'inherit' });
const U = 'http://localhost:3100/api', j = async (p: string, body?: any, method?: string) => { const r = await fetch(U + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, d: await r.json().catch(() => ({})) as any }; };
const cb = (id: string, code: number, extra: any[] = []) => fetch(U + '/mpesa/callback?token=tok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'x', CheckoutRequestID: id, ResultCode: code, ResultDesc: 'r', ...(code === 0 ? { CallbackMetadata: { Item: extra } } : {}) } } }) });
const cust = async (name: string) => (await j('/customers')).d.find((c: any) => c.name === name);
const H = 'Group,Customer Name,M-Pesa Number,Authorized Total,Amount Already Paid';
(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await j('/health')).s === 200) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
  a.strictEqual((await j('/customers')).d.length, 0, 'database must be empty (use a throwaway DB)');
  a.strictEqual((await j('/groups')).d.groups.length, 16);
  const big = await j('/import', { csv: [H, ...Array.from({ length: 8 }, (_, i) => `Group 2,X${i},07123456${10 + i},500,0`)].join('\n') });
  a.strictEqual(big.s, 422); a.ok(big.d.errors.includes('Group 2 contains 8 customers. Maximum allowed is 6.')); a.strictEqual((await j('/customers')).d.length, 0);
  const imp = await j('/import', { csv: [H, 'Group 1,A One,0712345678,1470,0', 'Group 1,B Two,0112345678,980,500', 'Group 1,C Three,254712345679,250,0', 'Group 1,D Done,254112345679,500,500'].join('\n') });
  a.strictEqual(imp.d.imported, 4);
  for (let i = 0; i < 2; i++) a.strictEqual((await j('/customers', { group: 1, name: 'F' + i, phone: '07000000' + (10 + i), authorized: 100, paid: 0 })).s, 201);
  a.strictEqual((await j('/customers', { group: 1, name: 'G', phone: '0700000099', authorized: 100 })).s, 422, '7th customer in group rejected');
  const g = await j('/stk-push-group', { groupId: 1 });
  a.deepStrictEqual([g.d.sent, g.d.failed, g.d.skipped], [5, 0, 1]);
  const amt = (nm: string) => g.d.results.find((r: any) => r.customer === nm).amount;
  a.deepStrictEqual([amt('A One'), amt('B Two'), amt('C Three'), amt('D Done')], [500, 480, 250, 0]);
  a.ok(sent.every(b => b.AccountReference.length <= 12 && b.CallBackURL.endsWith('?token=tok')));
  a.strictEqual((await j('/stk-push-group', { groupId: 1 })).d.sent, 0, 'pending customers not re-prompted');
  const A = await cust('A One'); a.strictEqual((await j('/stk-push', { customerId: A.id })).s, 409);
  const crid = g.d.results.find((r: any) => r.customer === 'A One').checkoutRequestId;
  a.strictEqual((await cb(crid, 0, [{ Name: 'Amount', Value: 999 }, { Name: 'MpesaReceiptNumber', Value: 'RCPT1' }])).status, 200);
  await new Promise(r => setTimeout(r, 500));
  let A2 = await cust('A One'); a.deepStrictEqual([A2.paid, A2.status, A2.nextAmount, A2.lastReceipt], [500, 'Ready', 490, 'RCPT1']);
  await cb(crid, 0, [{ Name: 'Amount', Value: 500 }, { Name: 'MpesaReceiptNumber', Value: 'RCPT1' }]); await new Promise(r => setTimeout(r, 500));
  a.strictEqual((await cust('A One')).paid, 500, 'duplicate callback must not double count');
  a.strictEqual((await fetch(U + '/mpesa/callback?token=bad', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const bcr = g.d.results.find((r: any) => r.customer === 'B Two').checkoutRequestId; await cb(bcr, 1032); await new Promise(r => setTimeout(r, 500));
  const B = await cust('B Two'); a.deepStrictEqual([B.paid, B.status], [500, 'Cancelled']);
  const ccr = g.d.results.find((r: any) => r.customer === 'C Three').checkoutRequestId; await cb(ccr, 0, [{ Name: 'Amount', Value: 250 }, { Name: 'MpesaReceiptNumber', Value: 'RCPT3' }]); await new Promise(r => setTimeout(r, 500));
  const C = await cust('C Three'); a.deepStrictEqual([C.balance, C.status], [0, 'Completed']); a.strictEqual((await j('/stk-push', { customerId: C.id })).s, 409);
  const pay = (await j('/payments')).d; a.ok(pay.length >= 5 && pay.some((p: any) => p.status === 'completed' && p.receipt === 'RCPT1') && pay.some((p: any) => p.status === 'cancelled'));
  const v = (await j('/verification')).d; a.ok(v.allDone, 'verification checklist should be complete');
  a.strictEqual((await j('/nope')).s, 404); a.strictEqual((await fetch(U + '/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
  console.log('integration ok');
})().then(() => 0, e => { console.error(e); return 1; }).then(code => { srv.kill(); daraja.close(); process.exit(code); });
