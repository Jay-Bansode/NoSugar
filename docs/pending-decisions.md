# Pending decisions (owner)

Decisions only you can make. Development continues meanwhile using placeholders or stand-ins, but each item blocks something by the date shown. When you decide one, tell the assistant and it will update CLAUDE.md §11/§12 and remove the item here.

_Last updated: 2026-11-19 · Current phase: Phase 1 (Core API)_

## Blocks launch

These must be settled before the website goes live (end of week 12).

| #   | Decision                                                          | What it blocks                                                                                           | Options / recommendation                                                                                                                                                            | Needed by                 |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | **SMS / WhatsApp provider** for OTP and order alerts              | Production login. The API refuses to start in production without one; locally a console stand-in is used | MSG91, Gupshup, Twilio, Interakt (WhatsApp). Pick one that does both SMS (DLT-registered templates) and WhatsApp                                                                    | Phase 3 (week 7)          |
| 2   | **Bot protection (CAPTCHA)** on the OTP endpoint                  | Spam OTP sends cost money per SMS. Only rate limits protect it today                                     | Cloudflare Turnstile (free, invisible) or hCaptcha. Recommendation: Turnstile                                                                                                       | Phase 4 (week 8)          |
| 3   | **GST rate and HSN code per product** (confirm with CA)           | Correct tax on every order and invoice                                                                   | Seed uses placeholders: coffee HSN 2101 @ 5%, tumbler HSN 9617 @ 18%. Ask the CA specifically about the **trial kit** (coffee + tumbler = mixed supply, taxed at the highest rate?) | Phase 1 invoices (week 5) |
| 4   | **Invoice number format** (confirm with CA)                       | Invoice and credit note PDFs                                                                             | Placeholder: `INV/2026-27/000123`, `CN/2026-27/000045`; sequential per financial year, no gaps                                                                                      | Phase 1 invoices (week 5) |
| 5   | **Real prices** for 6-packs, 15-packs, bundles and tumbler        | Checkout totals, free-shipping threshold behaviour                                                       | Seed placeholders: 6-pack ₹299 (MRP ₹349), 15-pack ₹699 (MRP ₹799), Bundle of 2 ₹1,299, Bundle of 3 ₹849, tumbler ₹499. Only the ₹399 trial kit is final                            | Phase 4 (week 8)          |
| 6   | **Brand name and domain**                                         | Website URL, emails, cookie names, app store listings, order number prefix (placeholder `BR-`)           | —                                                                                                                                                                                   | Phase 4 (week 8)          |
| 7   | **Product names, descriptions and photos**                        | Storefront content. Current flavour names come from the reference site and must not be used as-is        | Your own copy and photography                                                                                                                                                       | Phase 4 (week 10)         |
| 8   | **Health claims** ("zero added sugar", "diabetic-friendly", etc.) | Any such wording in UI copy                                                                              | Get them checked against FSSAI and ASCI rules; placeholders until approved                                                                                                          | Phase 4 (week 10)         |
| 9   | **Hosting provider and region**                                   | Deployment, Postgres/Redis hosting, S3 + CDN                                                             | AWS Mumbai (`ap-south-1`) is the default in CLAUDE.md §3; alternatives are other India-region hosts                                                                                 | Phase 4 (week 9)          |

## Accounts and registrations to open (Phase 0)

Needed before the related code can be tested against real services.

| #   | Item                                                           | Needed for                                                         | Needed by                       |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------- |
| 10  | **Razorpay** account (test + live keys, webhook secret)        | Payments                                                           | Phase 1 payments (week 4)       |
| 11  | **Shiprocket** account + a dedicated API user, pickup location | Serviceability checks, shipping, COD                               | Phase 1 serviceability (week 3) |
| 12  | **GSTIN, seller state code, FSSAI licence number**             | Invoices (`SELLER_GSTIN`, `SELLER_STATE_CODE`, `FSSAI_LICENSE_NO`) | Phase 1 invoices (week 5)       |
| 13  | **AWS** (or chosen host) account                               | S3 media, hosting                                                  | Phase 4 (week 9)                |
| 14  | **Firebase** project                                           | Push notifications                                                 | Phase 6 (week 16)               |
| 15  | **Apple Developer** and **Google Play** accounts               | App builds, TestFlight, store listings                             | Phase 5 (week 13)               |
| 16  | **Design system in Figma**                                     | Website and app UI                                                 | Phase 4 (week 8)                |

## Choices with a default (confirm or change)

Work is going ahead on the default. Say if you want something else.

| #   | Decision                                                      | Default in use                                                                                                                                                     | Needed by                 |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| 17  | Email provider                                                | Amazon SES (alternative: Resend)                                                                                                                                   | Phase 3 (week 7)          |
| 18  | Analytics                                                     | PostHog (alternative: GA4); Meta Pixel + Conversions API on web either way                                                                                         | Phase 4 (week 10)         |
| 19  | Subscriptions (repeat delivery)                               | Not in v1; revisit after launch                                                                                                                                    | Before Phase 4            |
| 20  | Extra order-status transitions added beyond the original spec | Late payment capture, direct delivery, refund after return (see CLAUDE.md §5). Keep unless you object                                                              | Now                       |
| 21  | Logout takes effect on access tokens within 15 minutes        | Accepted tradeoff for fast, stateless auth checks                                                                                                                  | Now                       |
| 22  | OTP limits                                                    | 5-minute code, 30-second resend, 5 attempts per code, 5 codes per phone and 20 per IP per hour                                                                     | Now                       |
| 23  | **Wallet credit and GST** (ask the CA)                        | Wallet credit counts as a payment, not a discount, so GST is calculated on the full price. The alternative (treat it as a discount) lowers the GST on those orders | Phase 1 invoices (week 5) |
| 24  | **GST on shipping and the COD fee** (ask the CA)              | Charged at the highest GST rate among the items in the order (usually 5%; 18% when a trial kit or tumbler is in it)                                                | Phase 1 invoices (week 5) |
| 25  | Free-shipping threshold uses the amount after discount        | A ₹419 order with a ₹30 code (₹389) pays ₹99 shipping. Alternative: check before the discount                                                                      | Phase 4 (week 8)          |
| 26  | Discount codes don't apply to the trial kit                   | The trial kit is already a promotional price                                                                                                                       | Phase 4 (week 8)          |
| 27  | Trial wallet credit can't be used on bundles                  | Only standalone 15-sachet packs, as §1 says. Alternative: also allow the Bundle of 2 (two 15-packs)                                                                | Phase 3 (week 7)          |
