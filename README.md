# Escrow Marketplace (MVP)

A multi-vendor marketplace where the buyer's payment is held in escrow until delivery.
The design is in `market ecom - revised.docx`; this is the MVP from section 13 of that spec.

```
packages/shared   Domain rules used by both apps: money, order state machine, shipping formula,
                  fraud scoring, scam-message detection, input validation schemas
apps/api          NestJS + Prisma + PostgreSQL REST API (port 4000)
apps/web          Next.js website (port 3000); proxies /api and /uploads to the API
```

## Run it locally

Needs Node 22 and the Homebrew `postgresql@14` binaries. The project runs its own database
in `.pgdata/` on port 5433 so it doesn't touch any other Postgres on your machine.

```bash
npm install
npm run db:start                      # start the project database
cp apps/api/.env.example apps/api/.env   # then set JWT_SECRET and CARRIER_WEBHOOK_SECRET
npm run build:shared
npx -w @market/api prisma migrate dev
npx -w @market/api prisma db seed
npm run dev:api                       # terminal 1
npm run dev:web                       # terminal 2
```

Open http://localhost:3000. Log in with a seeded account; there are no passwords. Login codes
and all notifications appear in the **development inbox** at http://localhost:3000/dev/inbox.

| Account | Role |
|---|---|
| `buyer@example.test` | Buyer with a Philadelphia address |
| `seller@example.test`, `seller2@example.test` | Verified sellers (New York, Boston) |
| `admin@example.test` | Admin: verification, fraud review, reports, finance |
| `agent@example.test` | Resolution agent: decides escalated disputes |

At checkout, a development-only menu chooses what the fake payment provider does: succeed,
decline, or flag elevated fraud risk.

## Deploying

The repo holds two apps that deploy to different places:

| App | Where | Why |
|---|---|---|
| `apps/web` (website) | Cloudflare Workers, via `@opennextjs/cloudflare` | Static pages and the `/api` proxy run at the edge |
| `apps/api` (API) | A Node.js host with PostgreSQL (Render, Railway, Fly.io) | Needs a database, scheduled jobs, disk for uploads and the `sharp` image library, which Workers don't provide |

**Website on Cloudflare:** Cloudflare's default deploy command, `npx wrangler deploy`, works as-is.
The root `wrangler.jsonc` runs `npm run build` (shared package, then the OpenNext build of
`apps/web`) and deploys the result. In the dashboard (Workers & Pages → your project → Settings):

- Root directory: `/`
- Build variable `API_URL`: your API's public URL, e.g. `https://api.yourdomain.com`. It's read at build
  time, so redeploy after changing it.
- The Worker name (`e-com-apps`) in `wrangler.jsonc` and `apps/web/wrangler.jsonc` must match the
  project name in the dashboard.

Test the Cloudflare build locally with `npm run build:shared && npm run preview:cf -w @market/web`.

**API:** set the variables from `apps/api/.env.example`, with `NODE_ENV=production`,
`WEB_ORIGIN` set to the website's URL, and a managed PostgreSQL `DATABASE_URL`. Build with
`npm ci && npm run build:shared && npx -w @market/api prisma migrate deploy && npm run build -w @market/api`
and start with `npm start -w @market/api`.

## Tests

```bash
npm test          # shared unit tests + API end-to-end tests (uses the marketplace_test database)
npm run typecheck
```

The API tests drive real HTTP requests through the whole stack: escrow and ledger balances,
auto-release, disputes, fraud holds/blocks, access control, CSRF, oversell protection,
webhook signatures, upload metadata stripping, search and recommendations.

## What's built

**MVP**
- **Accounts:** passwordless email login, rate-limited, httpOnly session cookie
- **Sellers:** store application → admin verification; listings with photos and package size
- **Catalog:** search with price/condition/category/distance filters; trending, similar items,
  frequently bought together, more from this seller
- **Checkout and escrow:** multi-seller cart split into one order per seller; delivery quotes from
  distance and chargeable weight; one charge held in escrow; double-entry ledger
- **Order lifecycle:** enforced state machine; ship with tracking; 4-digit proof-of-delivery code;
  signed carrier webhook; buyer confirmation; auto-release after delivery; auto-cancel if not shipped
- **Disputes:** evidence photos, seller offers (full/partial refund), escalation rules, agent
  decisions, default refund if the seller ignores it
- **Fraud and safety:** risk scoring at checkout (allow / step up / hold / block) with an admin review
  queue and labels; prohibited-item and suspicious-price listing review; scam detection in chat;
  report and block; address hidden from sellers after shipping
- **Security:** OWASP-aligned checks (ownership on every request, Origin check, CSP and security
  headers, zod validation, rate limits, EXIF/GPS stripping on uploads, audit log of admin actions)

**Phase 2**
- **Safer money handling:** settlements are committed before refunds go to the provider (no double
  payouts); failed refunds retry; checkouts interrupted by a crash or timeout are recovered
- **Reviews and ratings:** verified-buyer reviews per item, one public seller reply, product and store ratings
- **Returns:** change-of-mind returns within the seller's policy (items refunded, buyer pays postage);
  faulty/wrong items always returnable with a full refund; auto-refund if the seller stays silent;
  seller can send a bad return to the resolution team; lapsed returns release payment
- **Promotions:** seller coupons (percent or fixed, minimums, use limits, expiry) and free-delivery thresholds
- **Wishlist:** save items; price-drop and back-in-stock alerts
- **Notifications:** in-app notification centre plus email, with per-category email preferences
- **Payouts:** payout account change needs a fresh email code and starts a 72-hour hold; daily
  automatic payouts and "pay out now"; failed transfers return to the balance
- **Account security and privacy:** new-device login alerts, device list, data export, account deletion
- **Fraud rings:** self-dealing block (shared address), shared-device risk rule, admin linked-account lookup
- **Admin:** editable business rules (fee, release/handling/dispute/return days, payout hold) and
  platform analytics (GMV, take rate, repeat buyers, on-time shipping, dispute and refund rates)
- **Seller analytics:** 30-day sales, net earnings, best sellers, low stock, rating

## Not done yet (needs your accounts or is a separate project)

| Item | What's needed |
|---|---|
| Real payments and payouts | Stripe test keys → a `StripePaymentProvider` (Connect, separate charges and transfers); Connect onboarding replaces manual seller verification |
| Real email, SMS and push | Postmark/SES, Twilio and Firebase keys → `MailService` and `NotificationsService` |
| Address geocoding | Google Maps or Mapbox key → fill coordinates from the typed address |
| Carrier rates, labels and return labels | ShipEngine/EasyPost key → replace the formula quote; the webhook endpoint is ready |
| Image storage | S3-compatible bucket + CDN instead of the local `uploads/` folder |
| Live chat | WebSockets (chat currently refreshes every 10 seconds) |
| Later phases | Courier bidding, local pickup, shipping insurance, multi-currency, ML fraud model, personalised recommendations, mobile app |
| Before launch | Independent penetration test, legal review of escrow licensing per country |
