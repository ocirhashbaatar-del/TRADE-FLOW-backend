# Release Candidate Checklist — 12.1

**Goal:** A versioned release candidate deployable to a staging environment identical
to production (Render/PostgreSQL/Redis/Vercel).

## 1. Dependency & lockfile
- [ ] `backend/package-lock.json` and `Supply/package-lock.json` are committed and in sync.
- [ ] `npm ci` installs cleanly from lockfile (no drift).
- [ ] `npm audit` has no open Critical/High advisories; document any remaining moderate.

## 2. Environment variables
- [ ] Full list reviewed against `docs/ENV_MATRIX.md` (owner + rotation).
- [ ] Production secret store has all required variables.
- [ ] `SEED_PRODUCTION_ALLOWED=false` in production.
- [ ] Feature flags set according to pilot scope (12.8).

## 3. Seed separation
- [ ] Production startup runs `prisma migrate deploy && node dist/src/server.js` only.
- [ ] Demo seed is never invoked automatically in production.
- [ ] Dev/test seed runs via `npm run deploy:dev-seed` or `npm run prisma:seed`.

## 4. Migrations
- [ ] Every new migration has a forward step and a rollback/compensation entry in
      `docs/MIGRATION_ROLLBACK.md`.
- [ ] `prisma migrate deploy` applied cleanly on a fresh staging database.

## 5. Staging parity
- [ ] Staging uses the same Render web service, PostgreSQL, Redis, and Vercel project
      topology as production.
- [ ] Staging uses production-like feature flags and env values (non-secret).
- [ ] Deployment artifact is the same image/tag deployed to production.

## 6. Versioning & changelog
- [ ] Release candidate tagged (e.g. `v1.0.0-rc.0`).
- [ ] `docs/CHANGELOG.md` updated with the candidate's changes.

## 7. Feature flags / high-risk modules
- [ ] High-risk modules identified (`docs/ENV_MATRIX.md` / `feature-flags.ts`).
- [ ] Pilot-scope modules disabled where stakeholder decision is pending
      (Stripe, E-barimt, delivery-partner).

## Gate
- [ ] All of the above complete → the candidate is deployable to staging.
