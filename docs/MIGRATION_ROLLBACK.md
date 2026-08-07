# TradeFlow — Database Migration & Rollback Guide

**12.1 Release Candidate • forward migration + rollback/compensation per migration**

Migrations live in `backend/prisma/migrations/`. Apply forward migrations before a
release with:

```bash
npm run prisma:generate
prisma migrate deploy
```

> Runbooks must be executed by DevOps/Platform Admin, never automatically with a
> demo seed. Production startup only runs `prisma migrate deploy && node dist/src/server.js`.

## General rules

- Migrations are **append-only / forward**. Never edit an already-applied migration.
- Every release ships:
  1. the new migration folder(s),
  2. a written rollback/compensation plan (below),
  3. a code path that treats schema changes as compatible with the previous schema
     where possible (defer destructive drops).
- Destructive changes (dropping a column/table, changing a unique key) are **blocked
  for a full release cycle** so old instances can be rolled back without data loss.

## Migration inventory & rollback strategy

Each migration is listed with its forward action and the rollback/compensation step.

| Migration | Forward | Rollback / Compensation |
|---|---|---|
| `20260731042903_init` | Baseline schema | Restore last full backup; no reverse migration |
| `20260804000000_add_operational_roles` | Adds operational roles | Drop added role rows; restore roles seed |
| `20260804010000_platform_admin_and_invitations` | Platform admin + invitations | Revoke platform admin flags; delete invitations |
| `20260804020000_otp_qpay_ebarimt` | OTP/QPay/e-barimt models | Delete related rows; reverse via backup |
| `20260805030000_user_cart_and_saved_products` | Cart/saved products | Drop cart/saved tables (backup restore safest) |
| `20260806080532_add_tenant_and_related_tables` | Tenant model + related | Disable new tenant rows; restore backup |
| `20260807050000_product_sku_unique` | SKU unique constraint | Remove unique index (restore if conflicts) |
| `20260807090000_inventory_workflow` | Inventory flow models | Reverse via backup; no auto drop |
| `20260807100000_tenant_catalog_uniques` | Tenant catalog unique keys | Drop composite unique indexes |
| `20260807110000_order_lifecycle_finance_reorder` | Order/finance lifecycle | Restore backup; reverse status columns |
| `20260807120000_receipts_expiry_bank_payments` | Receipt/expiry/bank | Reverse via backup |
| `20260807150000_commerce_fulfillment_completion` | Commerce/fulfillment | Restore backup for shipment data |
| `20260807170000_platform_domain_verification` | Domain verification | Reset verification token/state |
| `20260807200000_unique_user_phone` | Unique phone | Drop unique index; reconcile duplicates |
| `20260807203000_tenant_scope_inventory_variant` | Tenant-scope variant | Restore backup; variant data reversal |
| `20260807223000_catalog_fulfillment_documents` | Docs/attachments | Reverse via backup |

## Rollback procedure

1. **Decision:** Rollback requires Platform Admin + DevOps approval and a recorded
   decision (with date/owner) per the incident process (12.10).
2. **Stop writes:** set the affected tenant(s) to `active=false` or block the API
   via feature flags to prevent new data during rollback.
3. **Restore data:** restore the last known-good full backup (see `DISASTER_RECOVERY.md`).
4. **Deploy previous version:** roll back the application image to the previous
   release candidate tag (12.1). Keep `prisma migrate deploy` from auto-downgrading.
5. **Reconcile:** run `reconcileInventory()` and finance reconciliation to confirm
   0-diff before allowing writes again (12.2).

## Compensation instead of destructive rollback

For non-data-loss cases prefer **compensation** over restore:
- Adding a column: keep it nullable; new code treats it as optional.
- Adding a table: leave it unused; disable feature flag.
- Changing a constraint: keep backward-compatible write paths for one release.
