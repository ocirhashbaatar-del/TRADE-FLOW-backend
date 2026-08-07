# TradeFlow — Backup, Restore & Disaster Recovery — 12.5

**Owner:** DevOps / Platform Admin. This runbook defines RPO/RTO targets and the
exact procedures to back up, restore, and reconcile after a disaster.

## 1. Objectives (to confirm with stakeholders)

Recommended targets (confirm and record with the stakeholder):

| Metric | Target | Owner |
|---|---|---|
| RPO (Recovery Point Objective) | ≤ 24h for PostgreSQL; assets recoverable from Cloudinary | DevOps |
| RTO (Recovery Time Objective) | ≤ 4h full restore | DevOps |
| Backup retention | 30 daily + 12 monthly | DevOps |

## 2. PostgreSQL automated backup

- Enable PostgreSQL automated backups on the managed provider (Render) with the
  retention above.
- Keep the backups in a separate region/account to survive provider outage.
- Verify backup completion daily (alert if a scheduled backup fails).

## 3. Restore test (must be run before go-live)

1. Provision a fresh PostgreSQL instance.
2. Restore the latest backup into it.
3. Point a staging/standby service at the restored DB using `DATABASE_URL`.
4. Run `npm run prisma:generate` and `prisma migrate deploy` against it.
5. Run the acceptance suite (12.2) and confirm 0-diff inventory/finance.
6. Record the restore drill date and owner (12.10 schedule).

## 4. Redis / cache recovery

- Redis is a **cache + lock**, not a source of truth (see tech-stack decision).
- If Redis is lost, the app must start and serve from PostgreSQL (graceful fallback).
- Test: stop Redis, confirm the API still returns correct data (uncached), then
  restart and confirm cache repopulates.
- Distributed locks (reservation expiry job) rely on pg-boss/PostgreSQL, not Redis,
  so a Redis loss does not corrupt reservations.

## 5. Uploaded asset backup / lifecycle

- Assets live in Cloudinary; PostgreSQL stores stable keys/URLs.
- Enable Cloudinary backup/export; define a lifecycle policy (e.g. keep originals,
  delete orphaned assets after N days via `sync-assets` reconciliation).
- Document the asset export/migration path (Cloudinary → R2 decision pending, 15.10).

## 6. Database corruption / provider outage runbook

1. **Detect:** health checks, Sentry, worker/DB/Redis alerts (12.10).
2. **Contain:** block writes via feature flags / tenant `active=false`; trip circuit
   breakers on external providers.
3. **Assess:** classify as corruption vs provider outage; use standby/read replica.
4. **Restore:** follow Section 3; for corruption restore the last known-good backup.
5. **Reconcile:** run inventory + finance reconciliation and confirm 0-diff (Section 7).
6. **Communicate:** record incident severity/escalation per 12.10.

## 7. Post-restore reconciliation checklist

- [ ] `reconcileInventory()` reports 0 mismatches.
- [ ] Ledger balance = inventory balance (12.2 acceptance).
- [ ] Payment allocations sum matches invoice balances.
- [ ] Period locks intact; no financial mutation in a locked period.
- [ ] External provider state (QPay/SMS/email) aligned with restored DB.
- [ ] Tenant/role/permission matrix intact.
- [ ] Stakeholder sign-off recorded before reopening writes.
