# SHAHEE ORGANIC – full-stack store (Node + Express + MongoDB + Razorpay)

## Run locally
1. Install Node 18+ and create a free MongoDB Atlas cluster (Database Access → add user; Network Access → allow your IP; Connect → copy the URI).
2. `npm install`
3. `cp .env.example .env` and fill it in (use Razorpay **test** keys from Dashboard → Account & Settings → API Keys).
4. `npm run seed` (creates the 200 ml ₹499 and 500 ml ₹999 products and your admin from ADMIN_EMAIL / ADMIN_PASSWORD).
5. `npm start` → store at http://localhost:3000, admin at http://localhost:3000/admin.html

## Razorpay
- Test: use test keys, pay with Razorpay's test card/UPI details from their docs.
- Webhook: Dashboard → Webhooks → URL `https://YOUR-DOMAIN/api/payments/razorpay/webhook`, events `payment.captured` and `payment.failed`, secret = RAZORPAY_WEBHOOK_SECRET (needs a public HTTPS URL, e.g. your deployed site or ngrok).
- Live: after Razorpay approves your account, replace the keys with live keys and create a live webhook.

## How it works
- Prices and stock are read from MongoDB; the browser only sends SKUs and quantities. Stock is reserved atomically and released on cancel or after 30 minutes unpaid.
- Paid status is set only after HMAC signature verification (checkout callback) or a signed webhook; webhook events are de-duplicated by event id.
- COD orders start as COD_PENDING and become COD_COLLECTED only from the admin panel.
- Refunds: do them in the Razorpay dashboard (paid orders cannot be cancelled in the admin until refunded).
- `GET /api/orders/track?number=SH…&phone=9876543210` returns order status for the customer.

## Deploy (Render)
New Web Service → connect repo → Build `npm install`, Start `npm start` → add all env vars with NODE_ENV=production. HTTPS and secure cookies are automatic.

## Not included yet
Customer accounts, coupons, reviews, returns workflow, email, Cloudinary uploads, React/3D frontend.
