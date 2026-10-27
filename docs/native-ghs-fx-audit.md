# Native GHS Balance & FX Snapshot — Implementation Audit (FX-Balance Workstream)

Status: implement-and-document (evidence in this branch, not a paper trail)
Scope: `AZM-backend` — schema, ledger, services, routes, middleware, CI/release chain, tests.
Related contract: `docs/CURRENCY_AND_SETTLEMENT_CONTRACT.md` (USDC remains the authoritative settlement unit; this workstream adds a REAL native-GHS balance and honest FX display fallbacks without changing that invariant).

---

## 1. What this workstream does (and does NOT do)

The Home balance card previously showed a single concept: `availableBalance` (USDC), with GHS as a derived display figure. This workstream makes the underlying reality explicit and honest:

1. **Native-GHS wallet** — a REAL GHS balance (`User.nativeGhsBalance`), projected by a genuine ledger liability account (`ghs:user:{id}:liability`, asset GHS). It is not a display conversion of USDC and never a reclassification of USDC funds.
2. **FX saved-rate snapshot** (`FxSavedRate`) — the LAST SUCCESSFULLY VALIDATED external USDC/GHS observation, exposed as a strictly DISPLAY-ONLY fallback when the current canonical rate is missing. Never labelled fresh/current, never transaction authorization.
3. **Balance valuation read model** (`balanceValuationService`) — the authoritative contract every money surface should consume: native GHS, available USDC, combined valuation, locked buckets in their native units, non-cash AZM excluded, rate situation, and the USDC transaction gate.
4. **Server-side transaction gate** (`fxTransactionGateMiddleware`) — FX-dependent transaction routes are refused 503 when no FRESH canonical rate exists. Saved/demo rates never open the gate. The frontend disables nothing by itself.

### Explicitly NOT changed (integration boundaries)

- The established Moolre deposit/withdrawal flows still convert GHS⇄USDC at the rail and settle into the USDC wallet. Their meaning is untouched (§8 documents the follow-up settlement wave for moving REAL native GHS in/out of the new wallet).
- No existing endpoint mutates `nativeGhsBalance`; the ledger-backed service primitives are exercised today by tests, the reconciliation read, and the valuation. Native-GHS routes are a deliberate follow-up, flagged for lead review rather than silently wired.
- 271C transaction authority (`transactionQuoteService.getFreshServerRateGhsPerUsdc`) is the ONE freshness gate; the display fallback is a separate policy (`src/config/fxDisplayPolicy.js`) with a wider but bounded window (default 7 days, range 1h-30d, cannot be switched off via configuration).

---

## 2. Schema changes (field-by-field)

### 2.1 `User.nativeGhsBalance` — `Decimal @default(0.0) @db.Decimal(20, 8)`

| Property | Value | Why it is safe |
|---|---|---|
| Default | `0.0` | Additive: every existing user starts with a genuinely-empty GHS wallet; no data migration, no invented balances. |
| Precision | `Decimal(20,8)` | Same exact-decimal discipline as every other money column; no JS floats in authoritative economics. |
| Floor guard | `CHECK ("nativeGhsBalance" >= 0)` via `infra/install-ghs-wallet-overlay.js` (Prisma cannot express CHECKs) | A negative GHS wallet is a bookkeeping defect; the DB backstops the CAS-guarded debits. |
| Semantics | Projection of `ghs:user:{id}:liability` ledger balance | `ghsWalletReconciliation()` exposes any residual; a mismatch is flagged, never auto-patched. |
| Backward compatibility | New column, never read by legacy code paths | Zero behavior change for existing endpoints/UI until they opt into the valuation block. |

### 2.2 `FxSavedRate` (new table)

| Field | Type / constraint | Why |
|---|---|---|
| `pair` | `@unique`, `CHECK (pair = 'USDC/GHS')` | Exactly one canonical pair may be persisted. The unique index makes the row a singleton snapshot by construction. |
| `rate` | `Decimal(20,8)`, `CHECK (rate > 0)` | Positive finite GHS-per-USDC only. |
| `source` | `String(32)` | Provenance (KOTANI_PAY, FALLBACK_FX, ...). |
| `observedAt` | `DateTime` | The EXTERNAL observation time — display eligibility is evaluated server-side from this field only. |
| `savedAt` | `DateTime` | Persistence time (distinct from observation time). |
| `isDemoSeed` | `Boolean @default(false)`, `CHECK (("isDemoSeed" AND source='DEMO_SEED') OR (NOT "isDemoSeed" AND source<>'DEMO_SEED'))` | A demo row must SAY it is a demo row. Honesty is enforced at the database level. |
| `validation` | `Json?` | Retained validation metadata (canonicality, writer identity). |

Writer contract: `fxRateSnapshotService.saveValidatedRateSnapshot` is called ONLY from the oracle's success path (`oracleService.syncRates`, after the canonical `GlobalSettings` write, strictly failure-isolated) and from the demo seeder. A failed/stale/malformed/noncanonical update is refused and never overwrites a valid saved rate. A demo seed never overwrites a genuine observation; a genuine observation replaces a demo seed.

### 2.3 Overlay installer — `infra/install-ghs-wallet-overlay.js`

Idempotent DDL (all `IF NOT EXISTS` / drop-then-add constraints), mirroring the established overlay pattern. Installs: the `nativeGhsBalance` CHECK, the `FxSavedRate` guards/indexes, and — on disposable test databases (`DATABASE_URL` contains `test`) or with explicit `DEMO_RATE_SEED=1` — the demo seed (1 USDC = GHS 12.03, `isDemoSeed=true`, `source=DEMO_SEED`). Production databases get structures but NO demo seed: the display fallback stays empty until a genuine observation arrives.

Wired into: `package.json` (`install:ghs-wallet` + the `npm run release` chain), `.github/workflows/test.yml`, `.github/workflows/financial-durability.yml`, `.github/workflows/converge-original-prod-branch.yml`.

---

## 3. Balance-valuation contract — `src/services/balanceValuationService.js`

Read model consumed by `/api/users/balance` (additive `valuation` block; legacy fields untouched and still authoritative). READ-ONLY by construction: no service function mutates balances; an FX revaluation changes only the DISPLAY value of the available-USDC component.

    availableGhsValue       = nativeGhsAvailable + (availableUsdc * displayRateGhsPerUsdc)
    availableUsdcEquivalent = availableGhsValue / displayRateGhsPerUsdc

Response fields (every Decimal financial quantity serialized as BOTH exact string `*Exact` and a JS number projection for presentation):

| Field | Meaning |
|---|---|
| `nativeGhsAvailable` | REAL GHS owed to the customer. |
| `availableUsdc` | REAL liquid USDC held. |
| `usdcEquivalent` | The DISPLAY valuation of the whole available GHS value expressed in USDC. NOT the quantity of USDC held. `null` when it cannot be valued (never fabricated). |
| `availableGhsValue` | Combined display valuation; `null` under `PARTIAL_FX_UNAVAILABLE`. |
| `rateStatus` | `CURRENT` (fresh canonical) / `SAVED_FALLBACK` (last validated observation, display-only) / `DEMO_FALLBACK` (demo seed, display-only) / `UNAVAILABLE`. |
| `valuationStatus` | `CURRENT` / `SAVED_FALLBACK` / `DEMO_FALLBACK` / `NATIVE_GHS_ONLY` / `PARTIAL_FX_UNAVAILABLE`. |
| `currentRate`, `savedRate` | The two concepts stay SEPARATE — a saved rate is never labelled current/fresh. |
| `usdcTransactionGateOpen` | `true` ONLY when `rateStatus === CURRENT`. The honest mirror of the same server-side authority the transaction routes enforce; the frontend disables nothing by itself. |
| `locked` | `escrowUsdc`, `disputesUsdc`, `vaultsUsdc` (vault status ACTIVE/COMPLETED), `committedSusuUsdc` (PAID contributions in COLLECTING/COLLECTING_GRACE cycles), `savingsGhs` (ACTIVE/PAUSED goals), `vendorUnallocatedUsdc`. Each in its NATIVE unit — never summed across currencies. |
| `nonCash.azmPoints` | Loyalty points — excluded from every monetary total. |

Honesty rules (proven by tests):

- No rate + available USDC > 0 → the combined total is NOT reported as complete (`PARTIAL_FX_UNAVAILABLE`; `availableGhsValue`/`usdcEquivalent` null). Native GHS alone is never presented as the full valued aggregate.
- No rate + available USDC == 0 → the native GHS amount IS the complete total (`NATIVE_GHS_ONLY`) — FX is genuinely not needed.

---

## 4. Transaction gate — `middleware/fxTransactionGateMiddleware.js`

`requireFreshFxRate()` — route-specific, fail-closed on every mount:

- Delegates to the ONE canonical freshness authority (271C): `getFreshServerRateGhsPerUsdc` — fail-closed on NULL/future/stale `lastExternalSync` or unusable rate value, recomputed AT REQUEST TIME.
- Refuses 503 with `success=false`, stable `code` (`RATE_STALE`/`RATE_UNAVAILABLE`), `retryable=true`, `usdcTransactionGate:'CLOSED'`, and the honest `savedRateIsDisplayOnly:true` hint. No client retry storm can turn a stale oracle green.
- Mount ORDERING contract (pinned by tests): authentication / ban guard / required 2FA run BEFORE the gate; the gate runs BEFORE `idempotency` and before any controller. An unauthenticated request gets the auth verdict (401) and never learns the gate's state; a refused request never claims an idempotency key, never moves money, never dispatches to a provider. Controllers' own internal gates re-validate inside the financial transaction for defense in depth.
- SCOPING (AZM-Planning #75): the gate is mounted on FX-DEPENDENT authorizations only — routes whose authorization needs GHS conversion, a GHS-valued limit, or an executable GHS quote (see §4.1). There is no arbitrary runtime lambda; the ONLY conditional form is the reviewed, built-in `requireFreshFxRate({ when: 'MOMO_PAYOUT_DESTINATION' })` destination predicate (a closed enum — unknown scopes throw at mount time). USDC-native same-asset routes simply do not mount the gate; every such route is classified with evidence in the §4.1 inventory.

### 4.1 Gate scope — ROUTE-SPECIFIC (FX-dependent authorizations only; AZM-Planning #75)

**Rework of the earlier universal scope.** The universal policy ("every new
USDC-enabled transaction authorization is refused while the canonical rate is
stale, including flows whose own math computes no GHS conversion") conflated
two availability concepts and is RETIRED. The route-specific contract is now
shipped: **a fresh canonical GHS/USDC rate is required exactly when an
authorization needs (a) GHS conversion, (b) a GHS-valued limit, or (c) a
route-specific executable quote.** USDC-native SAME-ASSET actions are NOT
gated: their availability is independent of whether the combined GHS display
valuation can be refreshed. A combined-balance display outage must not
refuse a USDC-to-USDC transfer.

**Gated — FX-dependent authorizations (evidence-based classification):**

| Route | Why the authorization needs a fresh rate |
|---|---|
| `POST /api/withdraw/fiat` | GHS MoMo payout quoted at authorization (`rateGhsPerUsdc` at quote time) — executable GHS quote. |
| `POST /api/wallet/withdraw` | **Destination-conditional**: MoMo phone destinations dispatch a GHS payout (needs the executable quote); crypto/Binance/TRC20 destinations are same-asset USDC dispatch and pass through. The predicate is a reviewed, built-in scope (`requireFreshFxRate({ when: 'MOMO_PAYOUT_DESTINATION' })`) — not an arbitrary lambda. |
| Savings goals `deposit`, `withdraw` | USDC⇄GHS goal conversion quoted at authorization (`quoteGhsPerUsdc`; `RateUnavailableError` → 503 internally too — defense in depth). |
| `POST /api/cross-border-susu/contribute` | Local→base currency conversion at a fresh pair observation (executable quote). |
| Smart-route executor `WITHDRAW_MOMO` | Fail-closed at the executor seam before any reservation/debit/provider intent; crash-RESUME of an existing reservation is intentionally NOT re-gated. |
| Deposit quotes (fiat initiate/moolre/otp) | Already gated internally (`quoteFiatDepositController.js:127` maps `RateUnavailableError` → 503). |

**NOT gated — USDC-native same-asset authorizations (each classified under the same rules):**

| Route | Classification evidence |
|---|---|
| `POST /api/friends/transfer/send` | USDC peer transfer (`amount` debited from `availableBalance`, credited to recipient) — same-asset; no GHS conversion, limit, or quote anywhere in the path. Inventory entry: correctly NOT gated (it never mounted the gate). |
| `POST /api/conversations/:id/messages/:id/accept-money` | Accepts a USDC money-request ticket: `ticket.amount` USDC debit/credit, no rate read in the service. |
| `POST /api/escrow/fund` | Funds escrow with the deal's `amountUsdc`; no rate read. |
| `POST /api/trades/initiate`, `/accept` | Phase F2: flat USDC fee, no GHS oracle math (USDC↔USD 1:1 parity minus platform fee; oracle rate is only for the internal MoMo rail). |
| `POST /api/p2p/ping/accept` | Moves `topUpAmount` USDC to unallocated; no rate read. |
| `POST /api/order-book/orders` | Orders reserve `priceUsdc`; no rate read. |
| `POST /api/round-up/process` | Rounds up USDC spend into a USDC savings bucket; no conversion. |
| `POST /api/storefront/:id/checkout`, `/order` | USDC-priced items (`unitPriceUsdc`); no GHS math in the flow. |
| `POST /api/dine-in/tabs/:id/pay` | Tab totals are USDC (`billTotalUsdc`, `tipUsdc`, `feeUsdc`); no rate read. |
| `POST /api/vaults/:id/deposit`, `/break`; `POST /api/shared-vaults/:id/deposit` | USDC vaults (`amountUsdc`); no rate read. |
| `POST /api/wallet/internal-transfer` | Same-asset USDC peer move. |
| `POST /api/withdraw/crypto` | USDC dispatch to an external wallet. |
| `POST /api/azm-convert` | Converts at the INTERNAL policy rate (`BASE_RATE` × profit-pool health factor) — not the canonical GHS/USDC oracle. |
| `POST /api/smart-routes/:id/run-now` | Manual execution is action-classified at the executor seam (above), not by a route-level gate. INTERNAL_TRANSFER and VAULT_DEPOSIT executor legs are same-asset and execute without a rate check. |
| Smart-route executors `INTERNAL_TRANSFER`, `VAULT_DEPOSIT` | Same-asset USDC moves — no executor-seam rate assert (reworked). |

**Intentionally NOT gated — settlement protection.** Lifecycle/settlement routes (trades decline, escrow satisfy/cancel, refunds, expiries, reconciliation convergence) finalize or reverse ALREADY-AUTHORIZED operations. A rate refusal can never block settlement. `requireFreshFxRate()` is mounted only on authorization entry points. Documented exceptions:

| Route | Classification | Integrity requirement |
|---|---|---|
| `DELETE /api/shared-vaults/:id` (owner cancels, refunds all contributors) | **Reversal of already-authorized deposits** — deliberately available during an FX outage (users must be able to exit a shared vault when the oracle is down). NOT a new authorization, so NOT gated. | The cancellation/refund must be SINGLE-WINNER: guarded `status: ACTIVE → CANCELLED` claim + transaction-consistent member refunds in ONE transaction (proven in the financial-integrity PR). |
| `POST /api/cross-border-susu/payout` | **NOT covered by this gate.** It converts the base-currency payout into the recipient's chosen target currency at payout-time rates via the multi-currency `FxRate` table — a NEW FX conversion at execution time, not settlement of a persisted USDC/GHS quote. | Explicit eligible-state claim + funding proof + payout-pair rate honesty (proven in the financial-integrity PR). |
| `POST /api/wallet/deposit/initialize` | **NOT a live provider payment path.** Reference/instructions generation only. | Real provider integration remains open work. |

**Valuation reconciliation (`valuation.usdcTransactionGateOpen`).** One boolean must not imply identical availability for every USDC-native action. `usdcTransactionGateOpen` remains the honest mirror of the fresh-rate authority but is now documented as governing FX-DEPENDENT authorizations ONLY. The additive sibling `usdcNativeActionsAvailable: true` states that same-asset USDC actions are available regardless of the oracle state (they never consult it). Frontends must not derive USDC-native button availability from the FX-dependent boolean.

Any future route whose authorization adds a GHS conversion, GHS-valued limit, or executable GHS quote MUST mount the gate; `__tests__/route-specific-fx-authorization-gate.test.js` pins the gated set (stale → 503 CLOSED), the USDC-native availability rule (never a gate refusal on same-asset routes), the MoMo-destination conditional, the idempotency non-claim, the saved-rate display-only rule, the auth-before-gate ordering (401 never 503 for unauthenticated callers), the per-mount stack order (auth/ban/2FA → gate → idempotency), and the executor behavior (WITHDRAW_MOMO fail-closed; same-asset legs available; crash-resume never re-gated).

### 4.2 Settlement scale on the gated money paths (cross-border + shared vault)

The gate decides WHETHER a conversion may execute; the settlement-scale
policy decides WHAT the conversion produces. `services/settlementScale.js`
is the single settlement authority (full contract in
`docs/CURRENCY_AND_SETTLEMENT_CONTRACT.md` §Settlement scale and rounding):

- USDC settles at 8 dp; fiat wallet currencies at 2 dp — per currency, never
  assumed uniform. Rounding is ROUND_HALF_UP, and nothing else may round on
  these paths.
- Computed conversions quantize ONCE at the settlement boundary: the
  fee-adjusted effective rate settles to the snapshot rate column's scale
  (8 dp) BEFORE multiplying, so the persisted rate is bit-for-bit the rate
  applied; the conversion product then settles at the destination
  currency's scale. The SAME settled Decimal is persisted, moved and
  serialized — the response can never show a number the database did not
  store (previously the unquantized product went to a `Decimal(20, 8)`
  column and PostgreSQL silently rounded the write).
- User-supplied amounts are refused (never rounded) when they carry more
  precision than the currency's settlement scale: `400
  AMOUNT_PRECISION_EXCEEDED`. Amounts beyond the storage envelope
  (`1e409`) are refused at parse time.
- The shared-vault completion threshold compares exact Decimals (two
  differing `Decimal(20, 8)` values can be the same JS double); the cancel
  refund moves the EXACT persisted contribution (a `parseFloat` of a
  20-significant-digit row moved `12345678901.12345695` instead of the
  deposited `12345678901.12345678`).
- Wire serialization is fixed notation (`0.00000001`, never `1e-8`).

Cross-border Susu reads its conversion rate from the persisted
`FxRate` observation as an EXACT Decimal — the previous
`parseFloat(row.toString())` round-trip demoted the observation to a JS
double before the money math ran. Rate freshness discipline (30-minute
observation age, fail-closed `RATE_UNAVAILABLE`/`RATE_STALE`, no demo
fallback) is unchanged.

**Owner decisions (approved 2026-10-27, implemented in follow-up PRs on
top of this one — this document records the decision, the implementation
lives in its own reviewable PRs):**
1. An explicit, validated `destinationType` field on payout requests
   (enum MOMO | BINANCE_PAY_ID | TRC20 | ERC20 | BEP20) closes the
   8-12-digit numeric-window ambiguity between MoMo numbers and Binance
   Pay IDs. Numeric destinations are NEVER silently digit-length-guessed:
   without the type they are refused `400 DESTINATION_TYPE_REQUIRED`; a
   type contradicting the format is refused `400 DESTINATION_TYPE_MISMATCH`.
   The FX gate, the saved-destinations surface and the payout dispatcher
   share the one resolution contract; unambiguous TRC20/EVM formats remain
   callable without a type for existing clients.
2. A dust-threshold policy for cross-border payouts: a payout that would
   settle to `0.00` in the payout currency is refused outright with
   `PAYOUT_SETTLES_TO_ZERO` BEFORE the user's balance is debited or any
   provider dispatch. No provider minimum (e.g. an assumed GHS 1) is
   encoded without verified, applicable provider documentation.

---

## 5. Oracle API — additive `savedRate` block (`GET /api/oracle/rates`)

The canonical response (current rate, source, freshness fields) is byte-identical. Added: `savedRate` — the display-only fallback metadata from `fxRateSnapshotService.getSavedRateForDisplay` (`rateExact`, `source`, `observedAt`, `isDemoSeed`, `eligibleForDisplayFallback`), or `null`. It is never labelled fresh/current. A failure reading it degrades to `null` and never breaks the canonical rates read.

## 6. Balance API — additive `valuation` block (`GET /api/users/balance`)

Legacy fields (`availableBalance`, `totalBalance`, `currency:'USDC'`, ...) untouched and still authoritative. Added: `valuation` (the full contract in §3), `valuationStatus`, and — on a valuation failure only — `valuationError`. Honest degradation: the legacy balance fields remain available; a valuation failure is never hidden as a fabricated zero/complete valuation.

**Legacy `totalBalance` defect (found by the route-level contract test, fixed here).** The legacy controller computed `user.availableBalance + user.vendorUnallocatedBalance` on two Prisma `Decimal` values. JS coerces objects via `valueOf`, and decimal.js returns a plain string there, so `+` STRING-CONCATENATED: a user with `100` available and `300` unallocated received `"100300"`; a user with `100` available and `0` unallocated received `"1000"`. Fixed to true Decimal addition (`.plus()`), serialized consistently with every other Decimal money field in the envelope. Same fix applied to the two other occurrences in `profileController.js` (dashboard `totalBalance`, hologram `balances.total`). This is the one legacy response value corrected by this PR: it was arithmetically wrong, not a semantics change.

## 7. Demo gating (every demo artifact)

| Artifact | Gate |
|---|---|
| Demo rate value 12.03 | `src/config/demoRateSeed.js` — one constant, test-pinned |
| Demo seed row | `isDemoSeed=true`, `source=DEMO_SEED`, DB CHECK-enforced; never overwrites a genuine observation |
| Demo seed INSTALL | `install-ghs-wallet-overlay.js` seeds ONLY when `DATABASE_URL` contains `test` OR `DEMO_RATE_SEED` is explicitly truthy; production logs that it is NOT seeded |
| Demo seed READ | `getSavedRateForDisplay` returns null for demo rows unless `demoModeRateSeedEnabled()` (explicit demo/test env markers); production never displays a demo rate |
| Demo labelling | `rateStatus=DEMO_FALLBACK` / `valuationStatus=DEMO_FALLBACK` flow to every consumer; the UI must say "demo rate" whenever it consumes a DEMO_FALLBACK rate |

## 8. Moolre integration boundary (deliberate, for lead review)

`nativeGhsWalletService` provides the audited primitives (`creditNativeGhs`, `debitNativeGhs`, `ghsWalletReconciliation`): caller-owned-transaction ledger postings against `fiat:momo:ghs` (the GHS custody asset) and `ghs:user:{id}:liability`, idempotency-key dedup, CAS overdraft refusal, exact decimals, projection+posting in one transaction. The settlement wave that routes REAL native GHS through them (e.g. a "keep funds in GHS" toggle on Moolre deposits, native-GHS withdrawals) is intentionally NOT wired in this PR: it changes the meaning of live money flows and needs its own product decision + provider reconciliation review. Nothing here is dead code — the primitives are exercised by the test battery and the reconciliation read model.

## 9. Test battery (real PostgreSQL, Prisma never mocked)

- `__tests__/fx-rate-snapshot.test.js` — validated-only persistence; demo honesty (never overwrites genuine; genuine replaces demo); server-side boundary-exact display eligibility; demo visibility env-gating.
- `__tests__/native-ghs-wallet.test.js` — balanced double entry (custody vs liability); projection equals ledger; CAS overdraft refusal (no ledger residue); idempotency-key duplicate refusal; exact-decimal arithmetic; reconciliation residual zero.
- `__tests__/balance-valuation.test.js` — every valuationStatus branch; locked buckets in native units; AZM excluded; gate closed on SAVED/DEMO/UNAVAILABLE; `PARTIAL_FX_UNAVAILABLE` honesty (no fabricated totals).
- `__tests__/fx-transaction-gate.test.js` — 503 fail-closed on stale/unavailable; fresh passes; MoMo-conditional scoping on `/api/wallet/withdraw`; gate ordered before the idempotency claim.
- `__tests__/balance-route-contract.test.js` — ROUTE-LEVEL pin of the real route (`GET /api/users/balance`), envelope, `{exact, value}` money serialization, equivalent-vs-held distinction, every rate/valuation status variant over HTTP, saved/demo fallback never opening the transaction gate, the honest 404, the `VALUATION_UNAVAILABLE` degradation envelope, and the corrected `totalBalance` arithmetic.

## 10. Why it is safe to merge

1. **Additive only**: no existing field, route, response, or money movement changes meaning. Legacy balance/oracle clients are byte-compatible.
2. **USDC settlement invariant preserved**: USDC remains the authoritative settlement unit; GHS adds a real distinct balance, it does not reclassify anything.
3. **Fail-closed everywhere**: no fresh canonical rate → FX-dependent routes 503 BEFORE any claim/money/provider; display falls back honestly (saved → demo → honest unavailability) and never fabricates.
4. **Demo artifacts can never leak into production**: DB CHECKs + install gating + read gating + explicit labelling (§7).
5. **Exact-decimal discipline**: Prisma Decimals end-to-end; JS numbers only at the presentation boundary (dual-serialized `*Exact`).
6. **Ledger-backed, reconcilable**: nativeGhsBalance is a projection of a real double-entry liability account with an exposed reconciliation read; residuals are flagged, never auto-patched.
7. **Full evidence**: 4 new suites against real PostgreSQL + the complete existing gate (run with `--runInBand`, see r25 lesson) in CI before merge.
