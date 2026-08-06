# TradeFlow MVP implementation matrix

Static/runtime evidence recorded on 2026-07-31.

## Functional coverage

| Area | Implemented evidence | Remaining |
|---|---|---|
| Auth / tenant / RBAC | JWT refresh rotation, OAuth, Tenant, RolePermission, tenant-scoped queries, AuditLog, admin guard | OTP guest checkout, full permission editor enforcement |
| Catalog / pricing | SKU, barcode, variants, channel, VAT, contract/group/tier price, promotion, price history, shared resolver | Excel import/export and category-tree editor |
| Procurement | Supplier relationship, PO, partial receiving, weighted cost, discrepancy quantity, payable, PDF and email | Rich supplier KPI UI |
| Inventory | Multi-warehouse balance, append-only movements, reservation expiry, transfer, stock count, reorder suggestions, batch/expiry and FEFO | Scheduled background job deployment |
| Sales / fulfillment | B2C order, B2B credit order, atomic reservation, partial shipment/backorder, tracking, return/restock/disposal | Delivery-provider integration |
| Finance | VAT invoice, receivable aging, FIFO payment allocation, idempotent reference, double-entry ledger, period-lock enforcement, reconciliation, supplier payable | E-barimt phase 2 |
| Reports / admin | Real dashboard, sales/inventory reports, UTF-8 CSV, SCM admin data views, B2B portal | Additional PDF analytics |

Functional score used by the repository audit: **73/100**.

## Non-functional coverage

- Tenant isolation: tenant filters and IDOR integration test.
- Inventory correctness: serializable transactions and 50-way final-unit concurrency test.
- Price consistency: a shared resolver plus contract/promotion integration test.
- Financial correctness: period lock and FIFO/idempotency logic with tests.
- Performance: indexed schema, Redis cache, compression, request duration logging, and a passing 10,000-SKU report test under 3 seconds.
- Security: Helmet, exact-origin CORS, rate limits, Zod validation, bcrypt, short access tokens, rotating refresh tokens, role middleware and frontend admin guard.
- Observability: request ID, structured JSON request logs with tenant/user/duration, health endpoint and optional Sentry via `SENTRY_DSN`.
- SEO: page titles, metadata, robots.txt and sitemap. Full SSR remains future work.
- Testing: integration coverage for isolation, concurrency, price priority/promotion, FEFO expiry, period lock and 10,000-SKU performance.

Non-functional score used by the repository audit: **71/100**.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Frontend:

```bash
npx eslint src
npx vite build
```

The production dependency audit requires explicit permission to send dependency metadata to the npm registry and is not claimed as verified here.
