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

The **live azaman-backend Render service is on the Free plan** (verified
read-only against the Render API on 2026-10-15, alongside the release-path
preflight for the Marketplace Mix discovery surface). Its actual execution
paths are:

- **Build Command** (Settings → Build & Deploy):
  `npm install && npm run build && node infra/install-e2ee-server-blind-overlay.js && node infra/install-inventory-restock-overlay.js && node infra/install-reservation-capacity-overlay.js`
  — i.e. `prisma generate` plus THREE overlay installers (E2EE server-blind,
  inventory-restock, reservation-capacity). It does NOT include the other
  fifteen installers of the release chain.
- **Pre-Deploy Command**: `npm run release` is CONFIGURED but the Free plan
  does NOT execute it. The full 19-installer release chain therefore does
  not run on deploys.
- **Start Command**: `node index.js` → `server.js` → `bootTreasury(app, prisma)`
  → `infra/autoRelease.js` — the boot-time auto-release path runs at EVERY
  process start, in the background, non-fatal. Its current `main` sequence
  (source order, mid-way through the chain — NOT appended last):
  1. retail-checkout-integrity
  2. prod-drift-remediation
  3. susu overlay
  4. transaction-quote overlay
  5. wallet-address overlay
  6. **Marketplace Discovery overlay (PR #349)**
  7. azamanId backfill
  8. **Business offered-categories overlay (PR #366)** — adds
     `BusinessProfile.offeredCategories` (`"BusinessCategory"[] NOT NULL
     DEFAULT ARRAY[]::"BusinessCategory"[]`, the exact `db push` shape) if
     absent and fail-closed validates the shape via pg_catalog
     (enum-array element type, NOT NULL, empty-array default).
  9. **Business bookmark overlay (marketplace personalisation, Backend A)**
     — creates the `BusinessBookmark` table (user-scoped saved businesses
     behind `/api/bookmarks`) if absent and fail-closed validates the exact
     `db push` shape: column set/types, pkey, both CASCADE foreign keys, the
     unique `(businessProfileId, customerId)` pair and both lookup indexes.
 10. treasury lookup — the susu-foundation seed and id-number encryption
     run ONLY when the treasury row is missing or a forced release is
     requested; otherwise autoRelease skips both and finishes early.
  Separately, AFTER `autoRelease()` completes, `bootTreasury()` runs the
  Business OS overlay (fail-closed 503 for `/api/business-os` if it
  fails). This whole boot sequence is the "startup schema-convergence
  activity" visible in Render logs.

Two consequences of that split:

- An installer added ONLY to the release chain (e.g. a future
  `npm run release` addition) does NOT automatically provision the
  production database, because the release chain itself never runs.
  (The offered-categories installer of PR #366 is wired into BOTH paths:
  `npm run release` runs `infra/install-business-offered-categories-overlay.js`
  standalone, and `infra/autoRelease.js` calls its exported
  `installBusinessOfferedCategoriesOverlay(prisma)` at every boot.)
- The boot-time path is NOT equivalent to the full release chain: it is a
  SMALLER subset. In particular `infra/autoRelease.js` includes the
  Marketplace Discovery installer but does NOT run
  `infra/install-business-price-overlay.js` (nor r42 idempotency,
  payment-requests, e2ee, inventory-restock, reservation-capacity — the
  last three run at BUILD time instead). Anything the boot subset omits
  still needs the dashboard Build Command, the guarded provisioning
  workflows, or a plan upgrade.

**Verified live database target (2026-10-15 preflight, non-secret facts
only):** the service's `DATABASE_URL` points at the ORIGINAL production
Neon branch of project "Azaman DB" — host `ep-crimson-cell-ab81e3bp.eu-west-2.aws.neon.tech`,
database `neondb`, TLS — NOT the Azaman-New greenfield project
(`ep-floral-hat-…`). Do not assume a Neon branch identity from this
document's history alone: re-verify the target before any provisioning
decision, and never print credentials.

**Ordering invariant for future provisioning:** the full release chain
installs `install-business-price-overlay.js` BEFORE
`install-marketplace-discovery-overlay.js` (the discovery overlay is the
LAST step of the chain). The boot-time path inverts coverage — it carries
Discovery but NOT BusinessPrice. When provisioning by any other route
(dashboard Build Command or a guarded workflow), preserve the
BusinessPrice-before-Discovery order and never remove existing installers.
As of 2026-10-15 the inspected production branch ALREADY carries the
expected `BusinessPrice` schema and DB constraints but ZERO confirmed price
rows — a discovery feed served against it would be legitimately empty
until real business-confirmed prices exist.

**Dashboard Build Command note:** appending
`node infra/install-business-price-overlay.js` to the Build Command
(idempotent, additive-only, ~1s) remains a supported belt-and-braces step,
but it is NOT required for the Marketplace Discovery surface — deploying
current `main` provisions the discovery overlay at boot via autoRelease.

Long term the blueprint (`render.yaml`) already encodes
`preDeployCommand: npm run release`; once the service moves to a plan that
executes pre-deploy commands, that becomes the authoritative path again and
any duplicated installer steps are harmless replays.

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

**On the live Free-plan service the boot-time path IS the provisioning
path** (see the Free-plan section above — verified 2026-10-15): current
`main` includes this installer in `infra/autoRelease.js`, and
`autoRelease` runs at every process start. Deploying current `main`
therefore provisions the discovery surface automatically (additively,
non-fatally, in the background) against whatever database the service's
`DATABASE_URL` targets. No dashboard change is strictly required for the
schema. The activation gates remain:

1. **Deploy + post-deploy schema verification** (gate): deploy current
   `main` (manual deploy; auto-deploy stays off), then confirm in the boot
   logs that `[autoRelease] … discovery surface installed` appears, and
   verify the schema read-only: `pg_index` rows for
   `business_product_discovery`, `business_product_section_active`,
   `business_profile_eligible` all `indisvalid = true`, and the ten
   `CatalogSectionTaxonomy` seed rows. **Do not guess which Neon branch
   is authoritative** — re-verify the live `DATABASE_URL` target first
   (see the Free-plan section) and do not dispatch any provisioning
   workflow from a non-default branch.
2. **Feature flag** (gate, off during deployment and verification):
   `AZM_MARKETPLACE_DISCOVERY_ENABLED=true` in the service environment.
   The route responds 404 until the flag is set — verify the flag-off 404
   BEFORE enabling, and run the live API smoke suite (200 envelope,
   cursor pagination, category + repeatable `taxonomy` filters, 422 on
   invalid chips, honest empty feed) immediately after.
3. **Real price data** (gate): the price-eligibility gate serves only
   products with a business-confirmed effective `BusinessPrice` GHS row.
   As of 2026-10-15 the production branch has ZERO confirmed rows, so
   the feed would be legitimately EMPTY even with everything else green.
   Do NOT seed prices via the installer or any automation path — real
   confirmed price data must come from business owners through the
   normal price-management flow. Do not enable the flag until genuine
   price data exists (or the owner explicitly accepts an empty feed as
   the interim state).
3. **Consumer** (sequencing, not a blocker): the P2 Mix UI PR swaps the
   frontend gateway composition for `GET /api/discovery/items` behind
   `MixCapability.crossStoreDiscovery` once this PR merges and the flag is on.

Local/CI databases converge via `test.yml` (installer runs after `db push`)
and the release chain; the manual paths above concern only the LIVE service.

## Receive/Request (FinancialOperation + PaymentRequest) provisioning

PR #332 (server-owned payment-request API) is merged on main, but the
Free-plan Render service never ran `npm run release`, and its boot-time
`autoRelease` path does not include the r42 or payment-requests installers —
so the two tables that API requires — `FinancialOperation` (r42
idempotency authority) and `PaymentRequest` (standalone request resource) —
were NOT provisioned by the deploy path and must be verified on the live
branch (the 2026-10-15 preflight showed the service's `DATABASE_URL` targets
the ORIGINAL production Neon branch, not Azaman-New — see the Free-plan
section) before any provisioning decision. Frontend PR #147 is blocked on
exactly this.

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
