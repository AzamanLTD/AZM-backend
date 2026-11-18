# Production Deploy Runbook — Smart Escrow + Business Accounts

## Deploying schema changes

Deploys are MANUAL: the live service has `autoDeploy: false`, so moving `main`
deploys nothing by itself. Today the live Build Command does not run the release
chain (see the ACTUAL table below); once the PROPOSED build command is applied,
a deploy from `main` will run the full chain before the new version receives
traffic.

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

## Deployment state: ACTUAL vs PROPOSED (read this before deploying)

Verified read-only against the Render API on **2026-11-17 12:56 UTC** for service
`AZM-backend` (`srv-da1pvvrncjis73fru9fg`, Frankfurt).

### ACTUAL live configuration (last verified 2026-11-17 12:56 UTC)

| Setting | Live value |
| --- | --- |
| Compute plan | `free` |
| Auto-deploy | off (`autoDeployTrigger: off`) — deploys are manual |
| Linked branch | `main` |
| Build Command | `npm install && npm run build && node infra/install-e2ee-server-blind-overlay.js && node infra/install-inventory-restock-overlay.js && node infra/install-reservation-capacity-overlay.js` |
| Pre-Deploy Command | `npm run release` is CONFIGURED but the Free plan does NOT execute it |
| Start Command | `node index.js` |
| Currently deployed commit | `48c17ab10248` (2026-10-15T16:59:51Z) |
| Approved production database | host `ep-crimson-cell-ab81e3bp.eu-west-2.aws.neon.tech`, port `5432`, database `neondb` |

**What that means today:** the live Build Command installs only three overlays
and the Pre-Deploy step never runs, so **the release chain does not execute on
deploy at all**. Every table the new release needs is therefore NOT provisioned
by deploying this branch. Do not describe the release chain as a live setting:
it is not one.

### PROPOSED configuration (NOT APPLIED — requires an operator change)

| Setting | Proposed value |
| --- | --- |
| Build Command | `npm install && npm run build && npm run release` |
| Pre-Deploy Command | none (the Free plan does not execute one) |
| Deploy trigger | manual only |
| Chain position | the full 31-step release chain (`npm run release`) runs in the Build Command, after `npm run build` and before the new version receives traffic |
| Guard | `npm run release` begins with `infra/verify-release-target.js` |

Nothing in this section is live. `render.yaml` is **proposed** configuration
too: its service name (`azaman-backend`) does not match the live service
(`AZM-backend`), and applying it blindly would propose creating a second service.
Treat that file as documentation of the intended state until an operator changes
the real setting, and never sync it without reading its header.

### Release authorization: one signed release, not a service-wide token

The Build Command's guard checks the Render identity signals — but a local shell
can export every one of them, so those variables are identity, not proof. The
production allow therefore also requires a signature that binds ONE release:

| Bound fact | Where it comes from |
| --- | --- |
| approved service ID | signed payload, compared with `RENDER_SERVICE_ID` |
| canonical branch | signed payload, compared with `RENDER_GIT_BRANCH` |
| **exact deploy commit** | signed payload, compared with `RENDER_GIT_COMMIT` |
| production database identity | signed payload, compared with `DATABASE_URL` |
| issuance time + expiry | signed payload, checked against the clock |

`RENDER_GIT_COMMIT` is the commit SHA of the deploy Render is building; Render
documents it under default environment variables as available at build time and
runtime. That is what makes the binding real at the phase where `npm run release`
runs.

**Operator procedure for one release — six steps, in this order**

Render's own semantics decide the order, because saving an environment variable
and deploying are separate actions:

| Render action | What it does |
| --- | --- |
| **Save only** | Stores the changed environment. Does **not** build or deploy; the running instance keeps its current environment. |
| **Save and deploy** | Stores the change **and** starts a deploy immediately, using the newest commit on the tracked branch. |
| **Save, rebuild and deploy** | Stores the change, then rebuilds and deploys the current commit. |

1. **Select and verify the exact commit.** Decide the SHA to release and confirm
   it is the commit you mean: it is on `main` after your approved merge, its CI
   lanes are green on that SHA, and its tree is the one you reviewed. Convert to
   the full 40-character SHA; that is what the authorization will name.
2. **Mint the authorization on an operator-controlled machine.** The private key
   lives outside the repository, outside CI, outside chat and outside any agent
   workspace; it is never copied into Render.

   ```
   node infra/sign-deploy-authorization.js --key /secure/offline/azm-release-auth.key --commit <full-sha> --ttl-minutes 10
   ```

   The token is printed on stdout, and the signed payload, commit and validity
   window on stderr. One token authorizes one commit; a second release needs its
   own token.
3. **Stage the token in Render without starting an unauthorized build.** The
   approved service has auto-deploy off, so use **Save only** when adding
   `AZM_DEPLOY_AUTH_TOKEN`. Nothing is built, and the running instance keeps its
   previous environment until the next deploy. Do not use Save and deploy here:
   that path deploys whatever the branch head is, which may not be the commit you
   signed.
4. **Trigger the deployment of exactly the signed commit.** Start a manual deploy
   of that commit. Render runs the Build Command
   (`npm install && npm run build && npm run release`); because the token is
   available at build time, the guard can compare the signed commit with
   `RENDER_GIT_COMMIT` for *this* build. A mismatch fails the build before any
   installer runs, so no partial DDL is possible.
5. **Verify the release result.** In the build log confirm the guard's
   `RELEASE_TARGET_PRODUCTION` line, the installer summary
   (`installed=true`, `depositClaims`/`witnessClaims`/`quarantined`, `conflicts=0`)
   and a zero exit. In the dashboard confirm the deployed commit is the SHA you
   signed.
6. **Remove the token, and expect the next deploy to need its own.** Delete
   `AZM_DEPLOY_AUTH_TOKEN` and use **Save only**. That stops future builds from
   inheriting it, without triggering a deploy and therefore without running the
   release chain a second time.

**Runtime exposure of the token is real, and bounded.** Render makes environment
variables available at both build time and runtime, so for the lifetime of the
instance built in step 4 the token is in the process environment, and a deploy
that reuses the saved environment would carry it forward. Two things bound the
exposure: the token expires on its own (10 minutes in the command above, 60 at
most), and step 6 removes it from the saved environment so later builds do not
inherit it. It is **not** a build-only secret, and it must never be treated as
one. Because the value expires, a later deploy on the same service must be
authorized with a freshly minted token: a build without one fails closed at the
guard, which is the intended behaviour, not a misconfiguration.

**Replay scope, restated.** A token that is still inside its window can be
replayed, but only for the same service, branch, commit and database. It cannot
authorize a different release. It is not single-use.

**Failure behaviour (fail closed, every case).**

| Condition | Code |
| --- | --- |
| no token | `RELEASE_REFUSED_NO_DEPLOY_AUTHORIZATION` |
| malformed token or bad signature | `RELEASE_REFUSED_INVALID_DEPLOY_AUTHORIZATION` |
| wrong service | `RELEASE_REFUSED_AUTH_SERVICE` |
| wrong branch | `RELEASE_REFUSED_AUTH_BRANCH` |
| wrong or missing commit | `RELEASE_REFUSED_AUTH_COMMIT` |
| wrong database identity | `RELEASE_REFUSED_AUTH_DATABASE` |
| expired | `RELEASE_REFUSED_AUTH_EXPIRED` |
| issued in the future | `RELEASE_REFUSED_AUTH_NOT_YET_VALID` |
| window longer than 60 minutes | `RELEASE_REFUSED_AUTH_WINDOW_TOO_LONG` |

**Replay scope, stated plainly.** This is NOT single-use authorization. There is
no nonce store: a genuine one-use mechanism would need persistent state in the
production database before the guard has decided the target is production, or an
external service the release chain cannot depend on. The residual capability is
that the SAME token can be replayed — but only for the same service, branch,
commit and database, and only until it expires (15 minutes by default, 60 at
most). It cannot authorize any other release. Do not describe it as one-time.

**Trust assumption, not implied.** The signature proves possession of the
operator's private key. It is NOT cryptographic proof that Render started the
process; that cannot be established from inside a process. If the private key
leaks, the guard is defeated, which is why the deploy action keeps independent
operator authorization, the key lives outside the repository and outside any
agent workspace, and rotation is a reviewed change to the public key pinned in
`infra/lib/releaseTargetGuard.js`.

### The release chain is 32 `&&` segments: the guard, then 31 commands

`package.json` `scripts.release` contains 32 `&&` segments — 1 guard
(`infra/verify-release-target.js`) followed by **31 commands** — so any
non-zero exit stops the chain before the next step. The last command is
`infra/verify-authority-boundary.js`; nothing may be appended after it. Every
document in this repository describes the same count and the same ordering.

### Azaman-New is NOT provisioned by this chain

`bootstrap-azaman-new.yml` previously ran `npm run release` against a different
database. The guard now refuses that by design, and the workflow step stops with
an explicit error instead of borrowing production authority. Azaman-New needs its
own separately reviewed provisioning path; the production guard is not broadened
to accommodate it.

### What runs where (once the proposal is applied)

| Path | Installers | Barrier? |
| --- | --- | --- |
| Build (manual deploy of `main`) | target guard + all 31 release steps | YES — completes before traffic |
| Pre-Deploy | none (Free plan) | n/a |
| Boot (`infra/autoRelease.js`) | its own smaller subset, non-fatal | NO |

**Not provisioned at boot, ever:** `ProviderSettlementWitness` (release step 12),
`ProviderObservationClaim` (step 29), `AppUnlockTotpClaim` (step 30) and
`ActionStepUpGrant` (step 28). These exist only if a release chain ran. The boot
path must not be given them: `server.js` calls `bootTreasury` without awaiting
it and every boot installer failure is non-fatal, so it cannot be the barrier
money paths depend on.

### Release-chain ordering that must not drift

1. `infra/verify-release-target.js` — proves the context: approved Render
   service, canonical branch, no preview, and the exact approved database
   identity. It exits non-zero on anything else, so `&&` stops the chain before
   the first installer.
2. `infra/install-wp-i-settlement-witness.js` (step 12) — creates
   `ProviderSettlementWitness`.
3. `infra/install-provider-observation-claim.js` (step 29) — creates
   `ProviderObservationClaim` and backfills it, so it must follow step 12.
4. `infra/install-app-unlock-totp-claim.js` (step 30).
5. `infra/verify-authority-boundary.js` (step 31) — the final gate; nothing may
   be appended after it.

Schema provisioning activates no authority and starts no provider
reconciliation. It only creates tables, indexes and constraints.

### Operations that stay separate DBA / operator procedures

- **Provider-observation backfill review.** `node
  infra/install-provider-observation-claim.js --dry-run` reports deposits,
  witnesses, skipped observations and historical collisions without writing.
- **Historical cross-path collisions.** The backfill QUARANTINES a reference
  whose money was used on both paths: it writes a claim with no legitimate
  owner, so both economic paths fail closed (`OBSERVATION_QUARANTINED`) until an
  operator resolves the history by hand. The installer never picks a winner.
- **The backfill blocks claim-table writers, so give it a window.** The claim
  overlay runs inside the same transaction as the claim writes, and PostgreSQL
  takes a `ShareLock` for its `CREATE INDEX` statements, which conflicts with the
  `RowExclusiveLock` every `INSERT`/`UPDATE`/`DELETE` takes. Live provider-claim
  traffic waits for the whole backfill. `IF NOT EXISTS` does not help: the lock is
  taken before the existing index can make the statement a no-op, so pre-installing
  the overlay does not remove the window. The installer header records the measured
  behaviour and what a redesign would cost; none is implemented. Schedule it as a
  maintenance-window operation until production wait times have been measured.
- **WP-I provenance role grants.** A least-privilege database role provisioned
  by an operator, never by the application boot path.
- **WP-H / WP-I authority activation.** Explicitly not enabled by any installer.

### Historical statements, corrected (do not follow them)

Dated so they cannot be mistaken for current instructions:

- Before 2026-11-17 this runbook described a chain of 18 installers, a working
  Pre-Deploy Command, and "push to `main` → Render runs `npm run release`". All
  three were wrong for the live Free-plan service: the chain is 31 steps,
  Pre-Deploy does not execute, and deploys are manual.
- The Build Command shown in older copies (three overlay installers) is the
  ACTUAL live value above, not a recommendation.
- Earlier prose claimed boot-time installers gave "the same installers" as the
  release. They do not, and boot is explicitly not a schema barrier.

## Free-plan Render deploy path

The **live azaman-backend Render service is on the Free plan** (verified
read-only against the Render API on 2026-10-15, alongside the release-path
preflight for the Marketplace Mix discovery surface). Its actual execution
paths are:

- **Build Command — ACTUAL (live today):** `npm install && npm run build && node infra/install-e2ee-server-blind-overlay.js && node infra/install-inventory-restock-overlay.js && node infra/install-reservation-capacity-overlay.js`
  — `prisma generate` plus three overlays. It does NOT include the release
  chain, so no release-provisioned table exists because of a deploy.
- **Build Command — PROPOSED (not applied):** `npm install && npm run build && npm run release`
  — the full 31-step chain, once, after the build. Until an operator applies
  this, production schema comes from nothing automatic.
- **Pre-Deploy Command:** configured as `npm run release` but NOT executed on
  the Free plan, so it is dead configuration today and must be removed rather
  than relied on. Release must never run through both build and pre-deploy.
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
  9. treasury lookup — the susu-foundation seed and id-number encryption
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
