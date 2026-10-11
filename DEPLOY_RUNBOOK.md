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

## Free-plan Render deploy path (CURRENT LIVE SERVICE)

The **live azaman-backend Render service is on the Free plan**, which does NOT
execute the Pre-Deploy Command. Its Build Command runs only three overlay
installers (E2EE server-blind, inventory-restock, reservation-capacity).
Consequences:

- `npm run release` does not run on deploys, so an installer added to the
  release chain does NOT automatically provision the production database.
- `infra/autoRelease.js` is not invoked during normal startup, so boot does
  not self-heal the gap either.

**Required dashboard change (Settings → Build & Deploy)** — append the
missing installer to the Build Command (idempotent, additive-only, ~1s):

    npm install && npm run build && node infra/install-business-price-overlay.js

Long term the blueprint (`render.yaml`) already encodes
`preDeployCommand: npm run release`; once the service moves to a plan that
executes pre-deploy commands, that becomes the authoritative path again and
the appended build-command step is a harmless replay.

**Until the dashboard change is applied**, the guarded workflow
`.github/workflows/provision-azaman-new-business-price.yml` (dispatch it on
the branch that carries it) is the supported way to provision new overlay
objects on the Azaman-New Neon database: it requires typing `Azaman-New` as
an explicit confirmation, applies ONLY `install-business-price-overlay.js`,
and finishes with a read-only verification of the full BusinessPrice
contract. See also `ops/azaman-new-neon-bootstrap` for the initial bootstrap
workflow (do not re-run it — it requires an EMPTY database).

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
