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

## Production-required environment variables (fail-closed contracts)

- `ENCRYPTION_KEY` - 32-byte key (64 hex chars or 44-char base64) for the
  field-level AES-256-GCM encryption of KYC government identifiers
  (`services/crypto/fieldCipher.js`). With `NODE_ENV=production` and this key
  missing or invalid, live KYC REFUSES every verification and webhook before
  any provider I/O - a government ID number can never be persisted plaintext
  because of a misconfigured deploy. Local/test environments keep the
  fail-soft plaintext passthrough explicitly, and only outside production.
  Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## New environment variables to add on Render BEFORE deploying:

  SMART_ESCROW_FEE_PCT=0.005
  ESCROW_DRAFT_EXPIRY_HOURS=24
  ESCROW_FUNDED_EXPIRY_DAYS=30
