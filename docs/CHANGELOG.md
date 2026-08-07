# TradeFlow Changelog

All notable changes are recorded here. Versions align with release candidate tags
(12.1). Format based on Keep a Changelog; the project follows semantic versioning.

## [Unreleased]

### Added (12.1 Release Candidate readiness)
- **Production seed isolation**: demo seed refuses to run when `NODE_ENV=production`
  unless `SEED_PRODUCTION_ALLOWED=true`. `deploy:start` and the Docker image now only
  run `prisma migrate deploy && node dist/src/server.js`; dev/test seed moved to:
  - `npm run deploy:dev-seed` (migrate + demo seed + server)
- **Feature flag registry**: `backend/src/lib/feature-flags.ts` + new
  `FEATURE_FLAG_*` env vars gate high-risk modules (Stripe, OAuth, QPay, E-barimt,
  delivery-partner) for a controlled pilot (12.8).
- **Targeted rate limits** (12.4): OTP, OAuth, checkout, and QPay callback endpoints
  now have their own limits via `backend/src/lib/rate-limits.ts`.
- **Upload hardening** (12.4): filename path-traversal sanitization, executable
  extension blocklist, strict MIME/opaque-type rejection, and size limits.
- **Operational docs**: `ENV_MATRIX.md`, `MIGRATION_ROLLBACK.md`,
  `RELEASE_CANDIDATE_CHECKLIST.md`, `DISASTER_RECOVERY.md`, UAT/pilot/data/ops guides.

### Security
- Rate limiting on OTP/OAuth/checkout/QPay callback endpoints.

## [1.0.0-rc.0] - planned

### Added
- Full end-to-end automated acceptance tests for the purchase→report cycle,
  B2B IDOR matrix, QPay callback replay, and locked-period financial mutation
  rejections (12.2).
- Backup / restore / disaster-recovery runbook (12.5).

## [0.x] - earlier (pre-release)

See commit history for detailed changes. Core features: auth/tenant/RBAC, catalog,
procurement, inventory, sales/fulfillment, finance, reports, platform admin,
storefront + B2B portal, notifications.
