
PAYCONNECT v2 - Checkout (Node.js + Express backend)

Structure:
- frontend/index.html          -> Static checkout page
- backend/server.js            -> Express server with BulkClix initiation + webhook handling + Airtable + Hubtel
- backend/package.json
- backend/.env.example         -> Fill this before running locally
- README.md

Quick start (local):
1. cd backend
2. npm install
3. copy .env.example to .env and fill values (do NOT commit)
4. npm run dev      # or npm start
5. Open frontend/index.html in browser (for local testing change fetch URL to http://localhost:3000/api/start-checkout if serving file://)
   - By default frontend posts to /api/start-checkout relative to the host. If hosting frontend separately, enable CORS or update endpoint URL.

Notes:
- The backend calls BulkClix momopay endpoint to initiate payment. It creates an Airtable record first (Status: Pending), then calls BulkClix.
- BulkClix webhook should be configured to hit: https://YOUR_PUBLIC_DOMAIN/api/bulkclix/webhook after deployment (Render, Railway, etc.).
- On receiving BulkClix webhook with status 'success', the server will send an SMS via Hubtel and update Airtable's Hubtel Sent/Hubtel Response fields. It intentionally DOES NOT change the Status field — admin should mark Delivered manually in Airtable.
- Redirect: After successful initiation the frontend will redirect the customer to https://ovaldataafrica.glide.page
- Security: Keep API keys secret in the .env. Implement webhook signature verification if BulkClix provides it for production.

If you want, I can also:
- Add CORS and serve the frontend from backend.
- Deploy the backend to Render for you (I can prepare a GitHub-ready repo).
