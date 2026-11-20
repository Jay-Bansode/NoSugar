# ADR 0001: Build the commerce core in NestJS (no Medusa / Saleor)

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

CLAUDE.md §11 left one question open until a two-day spike in week 1: should we write the commerce core ourselves in NestJS, or start from a self-hosted open-source engine (Medusa.js or Saleor)?

The parts that set this store apart are not generic commerce:

- the ₹399 trial kit, limited to one per customer, with a wallet credit on delivery, a 48-hour refund window, 30-day expiry and use only on the 15-sachet pack (§1)
- GST invoices with gapless numbering per financial year and credit notes (§8)
- order and payment state driven by Shiprocket (including COD and RTO) and Razorpay webhooks (§6)
- an append-only wallet ledger and order event log (§8)

## Decision

We build the core ourselves as a NestJS modular monolith with PostgreSQL and Prisma, as described in CLAUDE.md §2–§5. The spike is skipped.

## Consequences

- We own every piece of the logic and data model, with no engine upgrades to track and no plugin APIs to work around.
- Cart, catalog and discount basics have to be written ourselves. They are small and well understood, and the shared Zod schemas keep them consistent across clients.
- More tests up front: pricing, tax, wallet, trial rules, payment verification and webhooks (already required by §8).
- If the scope grows a lot (multi-vendor, multi-currency, marketplaces), revisit this decision.
