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
`.github/workflows/provision-azaman-new-business-price.yml` is the supported
way to provision new overlay objects on the Azaman-New Neon database: it
requires typing `Azaman-New` as an explicit confirmation, fails closed
unless the connection resolves to exactly the Azaman-New direct Neon
endpoint (`ep-floral-hat-b9qwuuq0.c-7.eu-central-1.aws.neon.tech`) with
`current_database()` = `neondb` (checked read-only in preflight, before
apply, and in post-install verification), applies ONLY
`install-business-price-overlay.js`, and finishes with a read-only
verification of the full BusinessPrice contract.

**When it can be run:** GitHub only offers `workflow_dispatch` workflows
whose workflow file is present on the **default branch** — the runbook
manual path therefore becomes dispatchable only after the branch carrying
the workflow file is merged to main. Until then the dashboard Build Command
change above is the only way to provision the overlay. Do not attempt to
dispatch it from a non-default branch; the Actions UI will not list it.
See also `ops/azaman-new-neon-bootstrap` for the initial bootstrap workflow
(do not re-run it — it requires an EMPTY database).

## Marketplace Mix discovery surface (PR #349) — activation blockers

`infra/install-marketplace-discovery-overlay.js` provisions the Marketplace
Mix P1 surface: the `BusinessProfile."isPubliclyDiscoverable"` flag (§9 D-5),
`CatalogSection."taxonomy"` + the `CatalogSectionTaxonomy` mapping table with
its seed rows and deterministic name-match backfill (§4 D-2), and the §3.3
discovery indexes (built `CONCURRENTLY` — no write-blocking lock; a failed
concurrent build leaves an `indisvalid = false` index which the installer
detects, drops and rebuilds on the next run). The installer is wired into
`npm run release` AND boot `infra/autoRelease.js` (same exported function —
no subprocess divergence).

**That wiring does NOT provision the live Free-plan service.** Per the section
above, the live Render Free plan executes NEITHER the Pre-Deploy Command
(`npm run release`) NOR `infra/autoRelease.js` at startup, so the discovery
surface is an **explicit activation blocker** — until one of the supported
paths below runs against the authoritative production database, the
`/api/discovery/items` route cannot be enabled:

1. **Database provisioning** (blocker): apply the installer on the
   authoritative production database. Supported paths, in order of preference:
   the Settings → Build & Deploy dashboard change appending the installer to
   the Build Command (idempotent, additive-only), or a guarded
   `workflow_dispatch` provisioning workflow — which GitHub only offers once
   the workflow file is on the default branch, i.e. after this PR merges.
   **Do not guess which Neon branch is authoritative and do not dispatch any
   provisioning workflow from a non-default branch.** Verify post-apply by
   probing `pg_index` for `business_product_discovery`,
   `business_product_section_active`, `business_profile_eligible`
   (`indisvalid = true`) and the ten `CatalogSectionTaxonomy` rows.
2. **Feature flag** (blocker): `AZM_MARKETPLACE_DISCOVERY_ENABLED=true` in the
   service environment. The route responds 404 until the flag is set.
3. **Consumer** (sequencing, not a blocker): the P2 Mix UI PR swaps the
   frontend gateway composition for `GET /api/discovery/items` behind
   `MixCapability.crossStoreDiscovery` once this PR merges and the flag is on.

Local/CI databases converge via `test.yml` (installer runs after `db push`)
and the release chain; the manual paths above concern only the LIVE service.

## Receive/Request (FinancialOperation + PaymentRequest) provisioning

PR #332 (server-owned payment-request API) is merged on main, but the
Free-plan Render service never ran `npm run release`, so the deployed
Azaman-New database still lacks the two tables that API requires —
`FinancialOperation` (r42 idempotency authority) and `PaymentRequest`
(standalone request resource). Frontend PR #147 is blocked on exactly this.

**Supported path until the dashboard change is applied:** the guarded
workflow `.github/workflows/provision-azaman-new-receive-request.yml`.

- **Exact scope:** applies ONLY the two reviewed, idempotent, additive
  installers — `infra/install-r42-idempotency-overlay.js` and
  `infra/install-payment-requests-overlay.js` (plus a Prisma client
  generation step the installers need). No `prisma db push`, no
  `migrate deploy`, no full release chain, no seeds, no unrelated
  installers.
- **Prerequisites:** the target must be the INITIALIZED Azaman-New Neon
  database — direct endpoint `ep-floral-hat-b9qwuuq0.c-7.eu-central-1.aws.neon.tech`
  (no pooler), `current_database()` = `neondb`, with `User`, `BusinessProfile`
  and `BusinessProduct` present (the PaymentRequest FKs reference `User`).
  All three jobs (preflight, apply, verify) assert the exact target
  read-only and fail closed on any mismatch. Requires typing `Azaman-New`
  as the confirmation input. Connection details are never printed.
- **Fail-closed conditions:** a populated legacy `IdempotencyKey` table.
  The r42 overlay retires that table by dropping it, and BOTH layers
  safeguard populated legacy data. The installer itself fails closed — its
  check-and-drop is one atomic lock-then-count block (ACCESS EXCLUSIVE on
  the legacy table before counting), so a table with any rows is refused
  with the table and every row left intact, and rows that legally appear
  between the preflight job and the apply job (a TOCTOU window across
  jobs) are waited out by the lock and refused the same way. The preflight
  refusal is defense-in-depth and the early, operator-facing guard: if
  the table exists with any rows, preflight refuses to proceed
  (export/migrate them first, empty the table, then re-dispatch). An
  absent or empty `IdempotencyKey` is safe: it is simply dropped/absent by
  design. A populated table cannot be destroyed by either layer. Post-install verification
  (read-only) asserts the full contract — every column, type and default,
  both primary keys, the User FKs with cascade, all indexes, the unique
  token-hash lookup, the §r42 byte-fidelity requirement that
  `FinancialOperation.responseBody` is TEXT (never JSONB), and the
  retirement of `IdempotencyKey`. A verification failure fails the
  workflow.
- **When it can be run:** GitHub only offers `workflow_dispatch` workflows
  whose workflow file is present on the **default branch** — this manual
  path becomes dispatchable only after the branch carrying the workflow
  file is merged to main. Do not attempt to dispatch it from a
  non-default branch; the Actions UI will not list it.
- **Automated checks:** `__tests__/receive-request-provisioning.pg.test.js`
  proves the same contract in CI — provisioning both tables from absent
  through the two installers, the empty-legacy retirement, the JSONB→TEXT
  byte-fidelity convergence, idempotent replay, and the live invariants
  (unique claim identity, User FK, unique token hash). The populated
  legacy refusal is exercised by dedicated PG proofs: a populated table
  is refused with every row intact, and a TOCTOU test deterministically
  reproduces the cross-job window (a row committed while the installer
  runs, coordinated through real `pg_locks` lock-state observation, no
  fixed delays) and proves the installer still fails closed.

Running this workflow provisions the missing tables only. It does NOT
deploy the API runtime, change Render settings, or by itself make the
deployed integration live — deploy the backend service normally
(`POST /api/payment-requests` ships with the code) after the tables exist.

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
