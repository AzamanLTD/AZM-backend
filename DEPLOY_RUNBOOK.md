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

Push to main → Render runs `npm run release` → `prisma migrate deploy` 
applies only the escrow migration → server restarts with new features live.

## New environment variables to add on Render BEFORE deploying:

  SMART_ESCROW_FEE_PCT=0.005
  ESCROW_DRAFT_EXPIRY_HOURS=24
  ESCROW_FUNDED_EXPIRY_DAYS=30
