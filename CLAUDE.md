# Project Context: DTC Coffee Store (Website + Admin + Android + iOS)

> **For AI assistants:** read this file in full before writing code. It is the source of truth for scope, stack, architecture and conventions. If a request conflicts with this file, point out the conflict before proceeding. Do not introduce Shopify, a hosted commerce platform, or a new major dependency without asking.

- **Brand name:** TBD (use `brand` / `Brand` as placeholders in code)
- **Market:** India only (INR, GST, Hindi/English users, UPI-first, Cash on Delivery)
- **Last updated:** 2026-11-19
- **Current phase:** Phase 1 – Core API: slices 1 (schema, migration, seed), 2 (OTP auth) and 3 (catalog) done; next slice 4 (pricing). Phase 0 non-code items (accounts, GST/FSSAI, Figma) still pending (update this line as work progresses)

---

## 1. What we are building

A direct-to-consumer store selling flavoured coffee premix sachets (zero added sugar, monk-fruit sweetened). Everything is built and owned in-house. **No Shopify or any hosted commerce platform.**

Four clients, one API:

| Client      | Tech                | Users                            |
| ----------- | ------------------- | -------------------------------- |
| Website     | Next.js             | Shoppers                         |
| Android app | React Native (Expo) | Shoppers                         |
| iOS app     | React Native (Expo) | Shoppers                         |
| Admin panel | Next.js             | Owner, operations, support staff |

Only three kinds of outside services: **Razorpay** (payments), **Shiprocket** (shipping, tracking, COD collection) and **messaging** (SMS/WhatsApp OTP and alerts, push, email).

### Catalog (initial)

- 5 flavours: Hazel Almond Latte, Silk Chocolate Mocha, Sea Salt Caramel, French Vanilla Cloud, Butter Gooey Toffee. (Placeholder names from the reference; final names, copy and photos will be our own.)
- Pack sizes: 6 sachets, 15 sachets (20 g each).
- **Trial kit:** ₹399, one sachet of each flavour + tumbler. One per customer.
- **Bundles:** Bundle of 2 (two 15-packs), Bundle of 3 (three 6-packs), customer picks flavours.
- **Gift sets:** fixed assortments, seasonal, limited stock.
- Merchandise: tumbler.

### The core business rule: trial kit cashback

1. Customer buys the ₹399 trial kit (once per customer, enforced server-side).
2. When Shiprocket reports **Delivered**, credit **₹399 to the customer's wallet**, valid **30 days**, usable only on a **15-sachet pack**.
3. The customer may instead request a **refund within 48 hours of delivery**. A refund reverses the wallet credit.
4. If unused, the credit expires after 30 days. Send a reminder 3 days before expiry.
5. Failed delivery / return-to-origin (RTO) → cancel the claim, no credit.

### Shipping and fees (configurable in admin settings, not hard-coded)

- Free shipping on orders ≥ ₹399; ₹99 below that.
- COD fee: ₹49 (non-refundable).
- Dispatch within 24 hours from one warehouse.

---

## 2. Architecture

```
Website (Next.js) ─┐
Android (RN/Expo) ─┤
iOS (RN/Expo) ─────┼──► API (NestJS, TypeScript) ──► PostgreSQL, Redis, S3 + CDN
Admin (Next.js) ───┘            │   ▲
                                │   │ webhooks
                                ▼   │
             Razorpay · Shiprocket · SMS/WhatsApp · Firebase (FCM) · Email
```

- **Modular monolith:** one NestJS deployable with clear modules; background workers run from the same codebase (BullMQ on Redis). Do not split into microservices without a concrete reason.
- **Webhooks are the source of truth** for payment and shipment state. Client callbacks are a fast path only.
- All clients share TypeScript types and validation schemas from the monorepo.

---

## 3. Tech stack

| Layer          | Choice                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Language       | TypeScript everywhere (strict mode)                                                                                                           |
| Monorepo       | pnpm workspaces + Turborepo                                                                                                                   |
| API            | NestJS (Node.js LTS)                                                                                                                          |
| Database       | PostgreSQL + Prisma ORM                                                                                                                       |
| Cache / queues | Redis + BullMQ                                                                                                                                |
| Validation     | Zod schemas in `packages/shared`, reused by API and clients                                                                                   |
| Website        | Next.js (App Router) + Tailwind CSS                                                                                                           |
| Admin          | Next.js (App Router) + Tailwind + shadcn/ui                                                                                                   |
| Mobile         | React Native with Expo (development builds, EAS Build, EAS Update). **Not Expo Go** – the Razorpay SDK needs native code via `expo prebuild`. |
| Mobile data    | TanStack Query; secure storage via `expo-secure-store`                                                                                        |
| Web payments   | Razorpay Standard Checkout (checkout.js)                                                                                                      |
| App payments   | `react-native-razorpay`                                                                                                                       |
| Shipping       | Shiprocket REST API (`apiv2.shiprocket.in`) + tracking webhooks                                                                               |
| Auth           | Phone OTP → JWT access token (short-lived) + rotating refresh token                                                                           |
| Media          | S3-compatible storage + CDN                                                                                                                   |
| Push           | Firebase Cloud Messaging (APNs underneath on iOS)                                                                                             |
| Email          | Amazon SES or Resend                                                                                                                          |
| Observability  | Sentry (all apps), structured JSON logs (pino), uptime checks                                                                                 |
| Analytics      | GA4 or PostHog; Meta Pixel + server-side Conversions API on web                                                                               |
| Hosting        | AWS Mumbai (ap-south-1) or another India-region host; Docker                                                                                  |
| Testing        | Vitest (unit; SWC plugin in the API for decorators), Supertest (API e2e), Playwright (web), Maestro or Detox (mobile)                         |

---

## 4. Monorepo layout

```
/
├── apps/
│   ├── api/          # NestJS API + workers
│   ├── web/          # Next.js storefront
│   ├── admin/        # Next.js admin panel
│   └── mobile/       # Expo React Native app (Android + iOS)
├── packages/
│   ├── shared/       # Zod schemas, TS types, constants, money/tax helpers
│   ├── api-client/   # Typed fetch client used by web, admin, mobile
│   ├── ui-tokens/    # Colours, spacing, typography tokens
│   └── config/       # Shared ESLint, TS and Prettier config
├── infra/            # Docker Compose (local Postgres + Redis), IaC
├── .github/          # CI workflows (GitHub only reads this folder), Dependabot
├── docs/             # ADRs, runbooks, this file
└── PROJECT_CONTEXT.md
```

### API module layout (`apps/api/src/modules/`)

`auth`, `catalog`, `pricing`, `cart`, `checkout`, `orders`, `payments`, `fulfilment`, `invoicing`, `wallet` (includes trial claims), `reviews`, `notifications`, `content`, `admin`, `webhooks`.

Each module: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, `*.spec.ts`. Business logic lives in services, never in controllers.

---

## 5. Data model (PostgreSQL)

| Domain         | Tables                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Customers      | `users`, `addresses`, `sessions`, `devices`                                                           |
| Catalog        | `products`, `variants`, `product_media`, `collections`, `collection_items`, `bundles`, `bundle_items` |
| Pricing        | `discounts`, `discount_redemptions`                                                                   |
| Cart           | `carts`, `cart_items`                                                                                 |
| Orders         | `orders`, `order_items`, `order_events`                                                               |
| Payments       | `payments`, `refunds`                                                                                 |
| Fulfilment     | `shipments`, `shipment_events`                                                                        |
| Tax            | `invoices`, `credit_notes`, `invoice_series`                                                          |
| Trial & wallet | `trial_claims`, `wallet_ledger`                                                                       |
| Engagement     | `reviews`, `review_media`, `leads`, `notifications`                                                   |
| Platform       | `admin_users`, `roles`, `audit_log`, `webhook_events`, `settings`                                     |

Key fields:

- `variants`: `sku`, `mrp_paise`, `price_paise`, `hsn_code`, `gst_rate_bps`, `stock`, `reserved_stock`, `weight_g`.
- `orders`: `number` (human-readable), `status`, `payment_method` (`prepaid` | `cod`), `subtotal_paise`, `discount_paise`, `wallet_paise`, `shipping_paise`, `cod_fee_paise`, `tax_paise`, `total_paise`, `shipping_address` (JSON snapshot), `customer_id`, `idempotency_key`.
- `order_items`: snapshot of `product_name`, `variant_name`, `sku`, `unit_price_paise`, `gst_rate_bps`, `hsn_code`, `quantity`.
- `trial_claims`: `customer_id` (unique), `order_id`, `status`, `delivered_at`, `refund_deadline`, `credited_ledger_id`.
- `wallet_ledger`: `customer_id`, `amount_paise` (positive credit / negative debit), `type` (`trial_credit` | `order_debit` | `reversal` | `expiry` | `manual_adjustment`), `source_id`, `expires_at`, `created_by`.
- `webhook_events`: `source`, `external_event_id` (unique per source), `payload`, `received_at`, `processed_at`, `error`.

### State machines

**Order status**

```
pending_payment → confirmed → packed → shipped → out_for_delivery → delivered
pending_payment → payment_failed | cancelled (timeout)
confirmed/packed → cancelled (before dispatch only)
shipped/out_for_delivery → undelivered → (reattempt) | rto → returned
delivered → refunded (full) | partially_refunded
payment_failed → confirmed (late capture on the same Razorpay order)
shipped | undelivered → delivered (courier skips the out-for-delivery scan)
returned → refunded · partially_refunded → refunded
COD orders start at confirmed (no payment step)
```

**Trial claim status**

```
ordered → delivered → credited → (used | refunded | expired)
ordered → cancelled (failed delivery / RTO / order cancelled)
```

Every transition writes a row to `order_events` (or the equivalent events table) and is enforced in one place in the service layer. Invalid transitions throw.

---

## 6. Key flows

### Checkout and payment

1. Cart is server-side. A guest cart (by cart id) merges into the customer's cart at login.
2. Customer chooses an address → API checks pincode serviceability with Shiprocket and computes shipping, COD fee, discount, wallet credit and GST.
3. API creates our order (`pending_payment`), reserves stock, and creates a Razorpay order for the total in paise.
4. Client opens Razorpay Checkout (web: checkout.js; apps: `react-native-razorpay`).
5. Client posts `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature` → API verifies the HMAC signature.
6. The `payment.captured` webhook also confirms the order, so payment succeeds even if the app is closed.
7. Confirmation is **one DB transaction**: decrement stock, debit wallet, set status `confirmed`. Then queue jobs: invoice PDF, Shiprocket order, notifications.
8. COD skips 4–6. Send a WhatsApp/OTP confirmation before dispatch to reduce RTO.
9. Unpaid orders release reserved stock after a timeout (e.g. 30 minutes).

### Login

1. Phone number → OTP via SMS/WhatsApp provider. Rate-limited per phone and per IP; bot protection on the endpoint.
2. Correct OTP → access token (~15 min) + rotating refresh token (~30 days).
3. Web: refresh token in an `httpOnly`, `Secure`, `SameSite=Lax` cookie. Apps: `expo-secure-store` (Keychain / Keystore).
4. If social login (e.g. Google) is added later, iOS also needs Sign in with Apple.
5. Users can delete their account from inside the app.

### Fulfilment (Shiprocket)

1. Job: create Shiprocket order → assign AWB → schedule pickup → fetch label and manifest.
2. Labels and manifests downloadable in admin.
3. Shiprocket tracking webhook → update `shipments` + order status → notify customer (push, WhatsApp, email).
4. On **Delivered** for a trial-kit order → wallet credit (see §1).
5. Undelivered (NDR) / RTO → admin task; RTO cancels any trial claim.
6. Shiprocket remits COD cash on its cycle; reconcile daily.

---

## 7. API conventions

- REST + JSON, base path `/v1`. Resource names plural, kebab-case (`/v1/cart-items`).
- Customer routes: `/v1/...`. Admin routes: `/v1/admin/...` with role guards.
- Request/response bodies validated with Zod schemas from `packages/shared`.
- Errors: `{ "error": { "code": "OUT_OF_STOCK", "message": "...", "details": {} } }` with a correct HTTP status. Error codes are `UPPER_SNAKE_CASE` constants in `packages/shared`.
- Pagination: cursor-based (`?cursor=...&limit=20`), response `{ data: [], nextCursor }`.
- Mutating checkout/payment endpoints accept an `Idempotency-Key` header.
- Dates: ISO 8601 UTC in the API; display in `Asia/Kolkata`.

### Main customer endpoints (initial)

| Method & path                                                                                   | Purpose                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `POST /v1/auth/otp` · `POST /v1/auth/verify` · `POST /v1/auth/refresh` · `POST /v1/auth/logout` | Login                                               |
| `GET /v1/products` · `GET /v1/products/:slug` · `GET /v1/collections/:slug`                     | Catalog                                             |
| `GET /v1/bundles` · `GET /v1/bundles/:slug`                                                     | Bundles and their pickable packs (bundle builder)   |
| `GET /v1/me`                                                                                    | Logged-in customer profile                          |
| `GET/POST/PATCH/DELETE /v1/cart` and `/v1/cart/items`                                           | Cart                                                |
| `GET /v1/serviceability?pincode=`                                                               | Delivery check                                      |
| `POST /v1/checkout`                                                                             | Create order + Razorpay order                       |
| `POST /v1/payments/verify`                                                                      | Verify Razorpay signature                           |
| `GET /v1/orders` · `GET /v1/orders/:number` · `POST /v1/orders/:number/cancel`                  | Orders                                              |
| `GET /v1/orders/:number/invoice`                                                                | Invoice PDF                                         |
| `GET /v1/wallet`                                                                                | Balance, expiry, ledger                             |
| `POST /v1/trial/refund-request`                                                                 | 48-hour trial refund                                |
| `POST /v1/reviews`                                                                              | Submit review (verified buyers)                     |
| `POST /v1/leads`                                                                                | Notify-me form                                      |
| `POST /v1/devices`                                                                              | Register push token                                 |
| `GET /v1/config`                                                                                | Banners, countdown end dates, min app version, fees |
| `DELETE /v1/me`                                                                                 | Delete account                                      |

### Webhooks received

| Path                           | Events                                                   |
| ------------------------------ | -------------------------------------------------------- |
| `POST /v1/webhooks/razorpay`   | `payment.captured`, `payment.failed`, `refund.processed` |
| `POST /v1/webhooks/shiprocket` | Tracking status updates (Delivered, NDR, RTO, etc.)      |

Rules: verify signature/token → store in `webhook_events` (unique on external id) → return 200 fast → process in a queue job. Never process the same event twice.

---

## 8. Non-negotiable rules

### Money and tax

- **All money is stored and computed as integer paise** (`₹399 = 39900`). Never use floats. Format only at display time.
- GST rates stored in basis points (`gst_rate_bps`). Prices shown to customers are **tax-inclusive** (MRP style); compute the tax component back from the inclusive price.
- Invoice tax split: CGST + SGST if delivery state = seller's state, otherwise IGST.
- Invoice numbers: sequential per financial year (April–March), no gaps; refunds issue credit notes. Final format to be confirmed by a chartered accountant.
- Snapshot price, tax, HSN and address onto the order. Later catalog edits must never change past orders.

### Data integrity

- `wallet_ledger` and `order_events` are **append-only**. Corrections are new rows (`reversal`, `manual_adjustment`), never updates or deletes.
- Wallet balance = sum of unexpired, non-reversed ledger rows for the customer.
- Stock changes and order confirmation happen in the same DB transaction.
- Use DB constraints (unique, foreign keys, check constraints) in addition to app checks; e.g. unique `trial_claims.customer_id`.

### Security

- Card/UPI data never touches our servers (Razorpay hosted checkout).
- Secrets only in environment variables / a secrets manager. Never commit `.env`.
- Admin: two-factor auth, role-based access (`owner`, `operations`, `support`), every action in `audit_log`.
- Rate-limit OTP, login, checkout and review endpoints.
- Validate and sanitise all input; parameterised queries only (Prisma).
- Follow OWASP Top 10. Run dependency scanning in CI.
- Personal data handling must respect India's Digital Personal Data Protection Act: clear notice, consent for marketing messages, account deletion.

### Code quality

- TypeScript strict; no `any` without a comment explaining why.
- ESLint + Prettier; must pass in CI.
- Tests are required for pricing, tax, wallet, trial rules, payment verification and webhook handling.
- Small, focused PRs. Conventional Commits (`feat(wallet): ...`, `fix(checkout): ...`).
- Database changes only through Prisma migrations.
- Feature flags / settings for anything business may want to change (fees, thresholds, offers).
- Log with context (`orderId`, `customerId`, `requestId`); never log OTPs, tokens or full phone numbers.

### Frontend / mobile

- Mobile-first design; most traffic is phone.
- Images through the CDN at the right sizes; check Core Web Vitals before web releases.
- Accessibility: labels on all inputs and buttons, sufficient contrast, support dynamic text sizes in the apps.
- Push permission is requested after the first order, not on first launch.
- Deep links: iOS Universal Links + Android App Links for products, orders and wallet.

### Content and claims

- Do not copy text, images or design from any competitor site.
- Health claims ("zero added sugar", "diabetic-friendly", etc.) must be approved against FSSAI and ASCI rules before they appear in UI copy. Use placeholders until approved.

---

## 9. Environment variables (API)

```
NODE_ENV=
APP_URL=                     # website base URL
API_URL=
DATABASE_URL=
REDIS_URL=
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=          # HMAC key for stored refresh-token hashes
OTP_SECRET=                  # HMAC key for stored OTP hashes (all three secrets must differ)
OTP_PROVIDER=                # "console" (dev only) until the SMS/WhatsApp provider is chosen
TRUST_PROXY=                 # number of proxies in front of the API; decides client IP for rate limits
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
SHIPROCKET_API_EMAIL=        # dedicated API user, not the main login
SHIPROCKET_API_PASSWORD=
SHIPROCKET_WEBHOOK_TOKEN=
SHIPROCKET_PICKUP_LOCATION=
SMS_PROVIDER_API_KEY=
WHATSAPP_PROVIDER_API_KEY=
FCM_SERVICE_ACCOUNT_JSON=
EMAIL_PROVIDER_API_KEY=
S3_BUCKET=
S3_REGION=ap-south-1
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
CDN_BASE_URL=
SENTRY_DSN=
SELLER_GSTIN=
SELLER_STATE_CODE=
FSSAI_LICENSE_NO=
```

Mobile (`apps/mobile`) uses only public values: `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_RAZORPAY_KEY_ID`, `EXPO_PUBLIC_SENTRY_DSN`. Never put a secret in a client app.

---

## 10. Roadmap (one developer ≈ 24 weeks; three developers ≈ 12–14 weeks)

| Phase                                | Weeks | Goal                                                                                                                               |
| ------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0. Foundations                       | 1     | Accounts (Razorpay, Shiprocket, AWS, Apple, Google Play, Firebase, SMS/WhatsApp), GST/FSSAI, monorepo + CI, design system in Figma |
| 1. Core API                          | 2–6   | Schema, OTP auth, catalog, pricing + GST, cart, serviceability, orders, Razorpay + COD, invoices, tests                            |
| 2. Admin panel                       | 5–8   | Admin auth + 2FA, products, orders, refunds, discounts, content, reviews, audit log                                                |
| 3. Fulfilment, wallet, notifications | 7–9   | Shiprocket integration, tracking webhooks, NDR/RTO, trial claims, wallet ledger + jobs, refunds, message templates                 |
| 4. Website                           | 8–12  | Storefront pages, cart drawer, bundle builder, checkout, account, SEO, analytics, security review, **launch end of week 12**       |
| 5. App foundation                    | 13–16 | Expo setup, shared API client, browse screens, cart                                                                                |
| 6. App checkout & accounts           | 16–20 | OTP login, Razorpay + COD, orders, wallet, push, deep links, OTA updates, account deletion                                         |
| 7. QA & release                      | 21–24 | Device testing, edge cases, TestFlight + Play testing, store listings, review, staged rollout                                      |

### Edge cases that must be tested

- Payment captured but client never returned → webhook confirms order.
- Duplicate webhook delivery → processed once.
- Two tabs checking out the last unit of stock.
- Wallet credit expired between cart and payment.
- Trial refund requested after 48 hours → rejected.
- Second trial kit attempt by the same customer (same phone, different address).
- Delivery fails → no wallet credit; RTO → claim cancelled.
- Partial refund → credit note amounts and GST split correct.

---

## 11. Open decisions

Owner-facing list with deadlines, options and placeholders in use: [`docs/pending-decisions.md`](docs/pending-decisions.md). Keep both in sync.

- [ ] Brand name and domain
- [x] Build commerce core ourselves (NestJS) vs. self-hosted open-source engine (Medusa.js / Saleor) – decided: custom NestJS core (see §12, `docs/adr/0001-custom-nestjs-core.md`)
- [ ] SMS and WhatsApp provider (OTP code is behind the `OtpSender` interface; a dev console sender stands in, refused in production)
- [ ] Bot protection on `POST /v1/auth/otp` (§6 Login): needs a CAPTCHA provider, e.g. Cloudflare Turnstile or hCaptcha. Rate limits are in place meanwhile.
- [ ] Subscriptions (repeat delivery) in v1 or later
- [ ] Final GST rate and HSN code per product (confirm with CA)
- [ ] Invoice number format (confirm with CA)
- [ ] Hosting provider and region

## 12. Decision log

Record decisions here (or as ADRs in `docs/adr/`) so every AI tool and teammate sees the same history.

| Date       | Decision                                                                                                                                                  | Reason                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-19 | Fully custom build, no Shopify                                                                                                                            | Full ownership of code, data and checkout                                                                                                     |
| 2026-11-19 | TypeScript monorepo: NestJS + PostgreSQL, Next.js, React Native (Expo)                                                                                    | One language and shared types across all clients                                                                                              |
| 2026-11-19 | Razorpay for payments, Shiprocket for shipping                                                                                                            | Standard for Indian DTC; UPI + COD support; one courier integration                                                                           |
| 2026-11-19 | Website launches before the apps                                                                                                                          | Faster revenue; apps reuse the same API                                                                                                       |
| 2026-11-19 | Custom NestJS commerce core; no Medusa/Saleor spike                                                                                                       | Our trial-cashback wallet, GST invoicing and Shiprocket/COD flows are the core of the product and would fight an engine's model; see ADR 0001 |
| 2026-11-19 | Native ESM across the API and `packages/shared`; Vitest (+ SWC) for API tests                                                                             | NestJS 12 is ESM-only; one test runner for the whole repo                                                                                     |
| 2026-11-19 | Pin TypeScript ~5.9                                                                                                                                       | TypeScript 7 is not yet supported by typescript-eslint and Nest tooling; revisit when it is                                                   |
| 2026-11-19 | Prisma 7 (stable), not 8 RC                                                                                                                               | npm `latest` points at an 8.0 release candidate; stay on stable                                                                               |
| 2026-11-19 | Order state machine lives in `packages/shared/src/order-status.ts`; §5 extended with late capture, direct delivery, refund after return                   | Real courier/Razorpay behaviour; one table used by API and clients, Prisma enum checked against it in tests                                   |
| 2026-11-19 | DB-level integrity: CHECK constraints (money, totals, stock, GST split) and an append-only trigger on `order_events`, hand-written in migration SQL       | Prisma cannot declare them; proven by `test:db` against real Postgres in CI                                                                   |
| 2026-11-19 | UUIDv7 primary keys; `order_events` uses a bigint sequence                                                                                                | Time-ordered ids index well; events need strict ordering                                                                                      |
| 2026-11-19 | Auth: `jose` (HS256 access JWTs, 15 min) + opaque rotating refresh tokens (30 days) stored as HMACs, with reuse detection that revokes the session family | Stateless access checks; a stolen refresh token is caught on reuse. Access tokens stay valid until expiry after logout (max 15 min)           |
| 2026-11-19 | OTPs only in Redis, as HMACs bound to the phone; 5-minute TTL, 30-second resend, 5 attempts; Redis keys use a hashed phone                                | Codes and raw phone numbers never stored or logged                                                                                            |
| 2026-11-19 | Global deny-by-default auth guard; routes opt out with `@Public()`                                                                                        | A new route can't be left open by accident                                                                                                    |
| 2026-11-19 | `ioredis` for Redis                                                                                                                                       | Required by BullMQ later; one client for rate limits, OTPs and queues                                                                         |
| 2026-11-19 | Public catalog shows `inStock` flags only, never stock counts, HSN codes or GST rates; one mapper (`catalog.mapper.ts`) decides what leaves the API       | Competitors can't scrape inventory; tax data stays internal                                                                                   |
| 2026-11-19 | Catalog responses cached `public, max-age=60, stale-while-revalidate=300`; no Redis cache yet                                                             | Edits show within a minute; add server-side caching only if traffic needs it                                                                  |
| 2026-11-19 | Added `GET /v1/bundles` and `/v1/bundles/:slug` to §7                                                                                                     | The bundle builder needs the list of pickable packs                                                                                           |

---

## 13. How to work with an AI assistant on this repo

- Start each session by pointing the assistant at this file and stating the current phase and task.
- Ask for one module or feature at a time, with tests.
- Ask the assistant to list the files it will touch before it writes code.
- After a decision changes, update §11 and §12 here first, then ask for code.
- Name it per tool if needed: `AGENTS.md` (many agents), `CLAUDE.md` (Claude Code), `.cursor/rules/project.mdc` or `.cursorrules` (Cursor), `.github/copilot-instructions.md` (GitHub Copilot). Keep one master copy and symlink or copy the others.
