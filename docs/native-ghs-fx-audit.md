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

`requireFreshFxRate({ when })`:

- Delegates to the ONE canonical freshness authority (271C): `getFreshServerRateGhsPerUsdc` — fail-closed on NULL/future/stale `lastExternalSync` or unusable rate value, recomputed AT REQUEST TIME.
- Refuses 503 with `success=false`, stable `code` (`RATE_STALE`/`RATE_UNAVAILABLE`), `retryable=true`, `usdcTransactionGate:'CLOSED'`, and the honest `savedRateIsDisplayOnly:true` hint. No client retry storm can turn a stale oracle green.
- Mounted BEFORE `idempotency` and before any controller: a refused request never claims an idempotency key, never moves money, never dispatches to a provider. Controllers' own internal gates re-validate inside the financial transaction for defense in depth.
- `when` predicate scopes the gate to a request's GENUINE FX dependence — USDC-native paths stay enabled, per the shared contract.

### 4.1 Gate scope (evidence-based route inventory)

The codebase itself states the boundary (`controllers/tradeController.js`): *"P2P trades use flat USDC fee, no GHS oracle math. The oracle rate (liveUsdToGhs) is ONLY for the internal MoMo deposit/withdrawal rail."* Verified by grep audit of every transaction route:

| Route | FX-dependent? | Gated? |
|---|---|---|
| `POST /api/withdraw/fiat` | YES — USDC debit vs GHS payout via Moolre at the canonical rate | **YES — unconditional** |
| `POST /api/wallet/withdraw` (MoMo phone destination) | YES — GHS payout path | **YES — conditional** (`when: isMomoPayoutDestination`, mirroring the controller's payoutMethod detection; Binance IDs (8-12 digits), TRC20/BEP20 destinations stay enabled) |
| `POST /api/wallet/withdraw` (crypto/Binance destination) | NO — USDC-native | No (stays enabled) |
| `POST /api/withdraw/crypto` | NO — on-chain USDC; only external feed is the MATIC/USDC gas oracle | No (stays enabled) |
| Deposit quotes (`/api/deposit/fiat/initiate`, moolre, otp) | YES | Already gated internally (verified: `quoteFiatDepositController.js:127` maps `RateUnavailableError` to 503) |
| Savings deposits | YES | Already gated internally (verified: `savingsController.js` at 3 sites) |
| P2P trades (`/initiate`, `/accept`) | NO — USDC escrow, flat USDC fee (code comment above) | No |
| Wallet `/internal-transfer` | NO — USDC-to-USDC vendor-pool movement | No |
| AZM-to-USDC conversion | NO — internal platform rate (profit-pool health), not the external FX feed | No |
| Storefront checkout/order, dine-in pay, reservations, chat money-accept | NO — all USDC-native amounts (no GHS rate reads in any of those code paths — grep-verified) | No |

Any future FX-dependent route MUST mount the gate; the test suite pins the currently-gated routes.

---

## 5. Oracle API — additive `savedRate` block (`GET /api/oracle/rates`)

The canonical response (current rate, source, freshness fields) is byte-identical. Added: `savedRate` — the display-only fallback metadata from `fxRateSnapshotService.getSavedRateForDisplay` (`rateExact`, `source`, `observedAt`, `isDemoSeed`, `eligibleForDisplayFallback`), or `null`. It is never labelled fresh/current. A failure reading it degrades to `null` and never breaks the canonical rates read.

## 6. Balance API — additive `valuation` block (`GET /api/users/balance`)

Legacy fields (`availableBalance`, `totalBalance`, `currency:'USDC'`, ...) untouched and still authoritative. Added: `valuation` (the full contract in §3), `valuationStatus`, and — on a valuation failure only — `valuationError`. Honest degradation: the legacy balance fields remain available; a valuation failure is never hidden as a fabricated zero/complete valuation.

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

## 10. Why it is safe to merge

1. **Additive only**: no existing field, route, response, or money movement changes meaning. Legacy balance/oracle clients are byte-compatible.
2. **USDC settlement invariant preserved**: USDC remains the authoritative settlement unit; GHS adds a real distinct balance, it does not reclassify anything.
3. **Fail-closed everywhere**: no fresh canonical rate → FX-dependent routes 503 BEFORE any claim/money/provider; display falls back honestly (saved → demo → honest unavailability) and never fabricates.
4. **Demo artifacts can never leak into production**: DB CHECKs + install gating + read gating + explicit labelling (§7).
5. **Exact-decimal discipline**: Prisma Decimals end-to-end; JS numbers only at the presentation boundary (dual-serialized `*Exact`).
6. **Ledger-backed, reconcilable**: nativeGhsBalance is a projection of a real double-entry liability account with an exposed reconciliation read; residuals are flagged, never auto-patched.
7. **Full evidence**: 4 new suites against real PostgreSQL + the complete existing gate (run with `--runInBand`, see r25 lesson) in CI before merge.
