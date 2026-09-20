# Production Deploy Runbook — Smart Escrow + Business Accounts

## One-time step BEFORE pushing this branch to production

Your production database was managed with `prisma db push` like your dev DB. 
The baseline migration (20260614000000_baseline_db_push_drift) records schema 
objects that already exist on production. Running it would fail with 
"relation already exists."

Connect to your production environment and run:
  npx prisma migrate resolve --applied 20260614000000_baseline_db_push_drift

This marks it as already applied WITHOUT executing the SQL. Do this once.

## Normal deploy resumes after that one-time step

Push to main → Render runs `npm run release` → the additive overlay
installers (`infra/install-*-overlay.js` + `install-prod-drift-remediation.js`)
apply any pending idempotent DDL → server restarts with new features live.

**Schema authority (r15 follow-up):** production DDL is deployed EXCLUSIVELY by
the overlay installers in `npm run release`. `prisma migrate deploy` is NOT
part of the release step, and the production database intentionally carries no
`_prisma_migrations` table. Do NOT add `prisma/migrations` files for
invariants the overlays already own (the `20260920060000_r15_receipt_available_unique`
file was removed for exactly this reason — the fiat-liquidity overlay creates
that unique index). New schema invariants go into the appropriate
`infra/install-*-overlay.js`, with the installer preflight raising loudly on
contradictory historical data instead of auto-repairing it.

## New environment variables to add on Render BEFORE deploying:

  SMART_ESCROW_FEE_PCT=0.005
  ESCROW_DRAFT_EXPIRY_HOURS=24
  ESCROW_FUNDED_EXPIRY_DAYS=30
