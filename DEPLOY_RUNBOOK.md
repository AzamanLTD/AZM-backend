# Production Deploy Runbook — Smart Escrow + Business Accounts

## Deploying schema changes

Push to main → Render runs `npm run release` → the additive overlay
installers (`infra/install-*-overlay.js` + `install-prod-drift-remediation.js`)
apply any pending idempotent DDL → server restarts with new features live.
Boot additionally self-heals via `infra/autoRelease.js` (same installers,
non-fatal).

**Schema authority (single, unambiguous):** production DDL is deployed
EXCLUSIVELY by the overlay installers. `prisma migrate deploy` is NOT part
of any deploy path — release, boot, or manual — and the production database
intentionally carries NO `_prisma_migrations` table. Never run `prisma
migrate deploy` or `prisma migrate resolve` against production: the
historical `prisma/migrations` chain is retained only as development
history for fresh disposable dev/test databases, and its baseline
(`20260614000000_baseline_db_push_drift`) assumes a `db push`-shaped
database production has drifted away from. New schema invariants go into
the appropriate `infra/install-*-overlay.js`, with the installer preflight
raising loudly on contradictory historical data instead of auto-repairing
it. (The `20260920060000_r15_receipt_available_unique` migration file was
removed for exactly this reason — the fiat-liquidity overlay creates that
unique index.)

## New environment variables to add on Render BEFORE deploying:

  SMART_ESCROW_FEE_PCT=0.005
  ESCROW_DRAFT_EXPIRY_HOURS=24
  ESCROW_FUNDED_EXPIRY_DAYS=30
