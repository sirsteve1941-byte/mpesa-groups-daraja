# M-Pesa Groups — Daraja Edition

This is the standalone version of the M-Pesa Groups app with a server-side Daraja STK Push integration.

## Features
- 16 groups, maximum 6 customers per group
- CSV import with the required five columns
- Sequential payment cycle 500 → 490 → 480
- Final installment is capped at the remaining authorized balance
- Zero-balance customers cannot request STK
- Safaricom callback updates paid amount and receipt
- Daraja credentials stay on the server

## Setup
1. Install Node.js.
2. Copy `.env.example` to `.env`.
3. Put your Daraja Sandbox Consumer Key and Consumer Secret in `.env`.
4. Put the Sandbox STK Passkey and Sandbox Short Code in `.env`.
5. Set `MPESA_CALLBACK_URL` to the public HTTPS URL of this server followed by `/api/mpesa/callback`.
6. Run `npm install`, then `npm start`.

Official Daraja documentation: https://developer.safaricom.co.ke/
Sandbox OAuth endpoint: https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials
Sandbox STK endpoint: https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest

Important: do not put Consumer Secret or Passkey in the browser/frontend.
