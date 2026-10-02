import * as L from './lib';
export type Env = Record<string, string | undefined>;
const TYPES = ['CustomerBuyGoodsOnline', 'CustomerPayBillOnline'];
export const txType = (E: Env, isProd: boolean) => E.MPESA_TRANSACTION_TYPE || (isProd ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline');

export function configProblems(E: Env, isProd: boolean): string[] {
  const need = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_PASSKEY', 'MPESA_BUSINESS_SHORTCODE', 'MPESA_CALLBACK_URL'];
  const t = txType(E, isProd);
  if (t === 'CustomerBuyGoodsOnline') need.push('MPESA_TILL_NUMBER');
  if (isProd) need.push('MPESA_CALLBACK_TOKEN');
  const p = need.filter(k => !E[k]).map(k => 'missing ' + k);
  if (!TYPES.includes(t)) p.push('MPESA_TRANSACTION_TYPE must be one of ' + TYPES.join(', '));
  if (isProd && E.MPESA_CALLBACK_URL && !E.MPESA_CALLBACK_URL.startsWith('https://')) p.push('MPESA_CALLBACK_URL must be https in production');
  return p;
}
export const callbackUrl = (E: Env) => {
  const u = E.MPESA_CALLBACK_URL || '';
  return E.MPESA_CALLBACK_TOKEN ? u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(E.MPESA_CALLBACK_TOKEN) : u;
};
export function buildStkBody(E: Env, isProd: boolean, c: { name: string; phone: string }, amount: number, ts: string) {
  const sc = E.MPESA_BUSINESS_SHORTCODE as string, type = txType(E, isProd);
  return { BusinessShortCode: sc, Password: Buffer.from(sc + E.MPESA_PASSKEY + ts).toString('base64'), Timestamp: ts, TransactionType: type, Amount: amount,
    PartyA: c.phone, PartyB: type === 'CustomerBuyGoodsOnline' ? E.MPESA_TILL_NUMBER : sc, PhoneNumber: c.phone, CallBackURL: callbackUrl(E),
    AccountReference: L.accountRef(c.name), TransactionDesc: 'Payment' };
}
export function parseCallback(body: any) {
  const cb = body?.Body?.stkCallback; if (!cb?.CheckoutRequestID) return null;
  const items: any[] = cb.CallbackMetadata?.Item || [], get = (n: string) => items.find(i => i.Name === n)?.Value;
  const code = Number(cb.ResultCode);
  return { checkoutRequestId: String(cb.CheckoutRequestID), code, status: code === 0 ? 'completed' : code === 1032 ? 'cancelled' : 'failed',
    desc: String(cb.ResultDesc ?? ''), receipt: (get('MpesaReceiptNumber') as string) || null, amount: Number(get('Amount')) || 0 };
}
