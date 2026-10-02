# M-Pesa Groups (TypeScript: Express + PostgreSQL + React/Vite)
One Render web service serves the API and the built React app. `npm install && npm run build && npm start`; `npm test` for logic tests.
Login: any username, password = ADMIN_PASSWORD (required in production). Never commit `.env`.

## Phase 1: sandbox (default)
1. Deploy with MPESA_ENV=sandbox, PayBill type, and the sandbox shortcode, passkey and keys from the Daraja portal. Callback URL must be the public Render URL.
2. Import a CSV using the Daraja sandbox test phone. Send a prompt and complete it.
3. The dashboard "Sandbox verification" panel must show all four checks done: STK accepted, successful callback credited once, failed/cancelled callback leaves paid unchanged, duplicate callback ignored. (To test the duplicate, re-POST the same callback body to /api/mpesa/callback.)

## Phase 2: production (only after all checks are green)
Set MPESA_ENV=production, production key/secret/passkey, MPESA_BUSINESS_SHORTCODE (may differ from the Till), MPESA_TILL_NUMBER=1739052, MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline, then PRODUCTION_VERIFIED=true. Until that flag is true, production refuses to send prompts. First live test: one customer with a tiny Authorized Total (e.g. 20 gives a KSh 20 prompt), confirm the callback credits it, then proceed.

## Tests
`npm test` runs unit tests (cycle, phones, CSV, Daraja request, callback parsing). `npm run typecheck` checks server and client.
`DATABASE_URL=<throwaway db> npm run test:integration` boots the real server against Postgres with Safaricom mocked and checks import limits, per-customer amounts, pending lock, callbacks (success, cancel, duplicate) and history. Run it before going live.

## Callback security
The server appends `?token=MPESA_CALLBACK_TOKEN` to the CallBackURL it sends Safaricom and rejects callbacks without it, so nobody can forge a payment confirmation. Render generates the token; it is required in production.
