# §P.5-D — Evidence-Backed GHS Liquidity Authority

**Date:** 2026-09-19 UTC
**Base:** backend `main` `19671d7` (§P.5-C, PR #284; post-merge CI run #1056 green)
**Authority:** `AZM-Planning/progress/2026-09-18_P5_INVENTORY_ROUTE_LIQUIDITY_INVESTIGATION.md` §7/§8
**Scope:** the evidence-backed GHS liquidity state/reconciliation boundary that must exist
before Model B settlement (§P.5-E). NOT Model B, NOT Kotani Model A, NOT inventory
consumption, NOT realized spread/P&L, NOT live signing/broadcast, NOT treasury UI.

---

## 1. Repo-wide GHS liquidity audit (implementation map)

### 1.1 Current GHS representations

| Representation | Kind | Where |
|---|---|---|
| `SystemFiatPool.balance` (singleton, scalar) | Operational scalar — **treated as** available GHS liquidity, but proves nothing | `prisma/schema.prisma` |
| `TransactionHistory` PENDING `WITHDRAWAL_FIAT` rows + `Withdrawal` mirror rows | Reservation projection (USDC-denominated; `payoutGhs` in metadata) | `finance.service.js`, `withdrawalController.js` |
| `clearing:fiat:offramp:usdc` ledger account | USDC-denominated clearing rail posted at withdrawal settlement | `finance.service.js` `completeFiatWithdrawal` |
| `Withdrawal`/`ProviderSettlementAttempt`/`ReconciliationException` | Payout identity + operational reconciliation infra | `infra/install-payout-reconciliation-infra.js` |
| `GlobalSettings.liveRetailRate`/`lastExternalSync` | Rate authority (not liquidity) | oracle/settings |

### 1.2 Current authoritative vs projection data

- **Authoritative today (USDC side):** the P4 liability ledger (`restricted:reserves` →
  `clearing:fiat:offramp:usdc` posts) and `TransactionHistory` CAS claims
  (PENDING→COMPLETED / PENDING→FAILED single-winner).
- **Projection:** `SystemFiatPool.balance` — a scalar that admin dashboards, war-room
  stats, proof-of-reserves and `payoutBatchWorker` read as if it proved GHS custody.
  Its writers are a gte-CAS decrement (`_reserveFiatPool`), a reversal re-credit
  (`reverseFiatWithdrawal`) and `liquidateProfits` top-ups. No inbound-GHS evidence
  exists anywhere: **GHS "arrives" only as a scalar increment invented by admin action.**

### 1.3 All lifecycle entry points (traced in code, not by filename)

1. **Fiat withdrawal reservation:** `financeService.processFiatWithdrawal` — preflight
   pool read, then one tx: `_reserveFiatPool` gte-CAS decrement → user debit → master
   crypto increment → PENDING `TransactionHistory` (positive magnitude, deferred
   economics) → P4 `restricted:reserves` post → `RestrictedObligation`.
2. **Dispatch:** `mtnDisbursementService.initiateTransfer` / `moolreDisbursementService
   .initiateTransfer` from `withdrawalController` (MTN MoMo) and `finance.controller`
   (Moolre MoMo), plus `workers/payoutBatchWorker` auto payouts. Synchronous failure →
   `reverseFiatWithdrawal` (FAILED claim, refund, pool re-credit, P4 reversal post).
3. **Provider settlement:** `fiatSettlementService.settleFiatWithdrawal` →
   `completeFiatWithdrawal` (SUCCESS → COMPLETED, deferred economics realized, P4
   `restricted:reserves`→`clearing:fiat:offramp:usdc` post) or `reverseFiatWithdrawal`
   (FAILED). `withdrawalReconciliationWorker` recovers lost callbacks by provider poll.
4. **Deposit settlement (inbound GHS evidence):** `quoteFiatDepositController.webhook`
   (secret-signed generic rail) and `quoteMoolreDepositController.webhook` (Moolre MoMo
   collection) — both consume the P5-C quote atomically and CAS PENDING→COMPLETED
   before crediting. These are the only real inbound GHS observation points.
5. **Admin top-up:** `financeService.liquidateProfits` — `SystemProfitFees` →
   `SystemFiatPool` transfer with audit event (audited, but not external evidence).

### 1.4 Compatibility surfaces that must remain

- `SystemFiatPool` singleton (readers: `adminController`, `adminProfitBreakdownController`,
  `warRoomController`, `proofOfReserves*`, `payoutBatchWorker`, dashboards).
- All mounted webhook signatures, TH/ledger semantics, P4 restricted-obligation behavior.
- P5-C route identity on quotes/settlement (`selectedRoute`, `provider`, `rail`).

### 1.5 Exact boundaries P5-D owns

The evidence-backed GHS lifecycle: provider event evidence → receipts → available →
reservation → in-transit → paid-out/released, plus reconciliation against provider
evidence. Everything else stays untouched. Realized economics remain settled only by
the existing P4 paths; P5-D records liquidity truth, it does not re-post customer
economics.

---

## 2. Defects fixed on the integration path (pre-existing, provable)

1. **`utils/securityCheck.runDoubleCheck` Decimal-concat/NaN bug:** `sum + tx.amountUsdc`
   coerces Prisma `Decimal` through string `valueOf()`. With 2+ settled rows the reduce
   becomes string concatenation → `NaN` on subtraction, and `NaN > TOLERANCE` is false,
   so the audit **silently passes while disarmed**. Fixed with explicit `Number()`
   conversions (exactness: values are Decimal(20,8), well inside double-integer range;
   `TOLERANCE` remains the float epsilon).
2. **Withdrawal sign convention in `runDoubleCheck`:** both `WITHDRAWAL_FIAT` and
   `WITHDRAWAL_CRYPTO` store `amountUsdc` as a **positive debit magnitude** (the P3
   custody-accounting attestation reads them exactly that way), but the double-check's
   blanket "positive = credit" recomputation counts settled withdrawals as credits.
   Fixed by interpreting withdrawal types as debits. No historical data is rewritten; no
   other reader changes.

---

## 3. The P5-D state machine

### 3.1 `FiatLiquidityReceipt` (inbound GHS evidence)

```
RECEIVED ──confirm──▶ AVAILABLE
RECEIVED ──unmatched──▶ UNMATCHED ──reconcile/match──▶ AVAILABLE | REVERSED
AVAILABLE ──reverse──▶ REVERSED            (contradictory evidence / clawback, evidence kept)
any ──contradiction──▶ RECONCILIATION_REQUIRED
```

- `RECEIVED`: durable evidence recorded; **not** spendable.
- `AVAILABLE`: only via (a) a settled, quote-matched deposit webhook observation
  (Moolre collection success / secret-signed deposit webhook, both of which already
  CAS-claimed the deposit inside the same tx), or (b) explicit confirmation of an
  audited treasury opening (`liquidateProfits` / manual evidence entry).
- `UNMATCHED`: evidence without a matched internal deposit — never available until a
  human/system reconciliation match.
- `REVERSED` / `RECONCILIATION_REQUIRED`: terminal-with-evidence; raw provider events
  are always retained.

### 3.2 `FiatLiquidityReservation` (outbound GHS payout)

```
RESERVED ──dispatch──▶ IN_TRANSIT ──provider SUCCESS──▶ PAID_OUT
RESERVED │ IN_TRANSIT ──provider FAILED / dispatch rejection──▶ RELEASED
RESERVED │ IN_TRANSIT ──lost terminal evidence──▶ RECONCILIATION_REQUIRED
```

- `RESERVED`: funds claimed from available liquidity by a withdrawal reservation
  (gte-CAS; a loser fails closed with `INSUFFICIENT_LIQUIDITY`, exactly the legacy
  `FIAT_POOL_INSUFFICIENT` behavior preserved at the controller contract level).
- `IN_TRANSIT`: provider accepted the payout (post-`initiateTransfer`).
- `PAID_OUT` / `RELEASED`: terminal single-winner claims.
- `RECONCILIATION_REQUIRED`: no terminal provider result or contradictory evidence.

### 3.3 `FiatProviderEvent` (append-only raw evidence)

Every provider observation is appended with its raw payload before/with any state
change. Duplicate economic identities converge; contradictory terminal events are
retained (never rewritten) and raise `ReconciliationException`.

### 3.4 `FiatLiquidityState` (singleton aggregate)

`availableGhs`, `reservedGhs`, `inTransitGhs`, `paidOutGhs` — each transition is a
guarded conditional update in the same transaction as its evidence/state row. The
aggregate is the claimable authority; sums over receipts/reservations are the
reconciliation target.

## 4. SystemFiatPool after P5-D (compatibility boundary)

- It remains, but ONLY as a derived projection: `fiatLiquidityService` updates
  `SystemFiatPool.balance := availableGhs` inside each liquidity transaction
  (`_syncPoolProjection`). No other writer. Readers keep working unchanged.
- New financial logic never reads the pool to prove GHS custody.
- The rollout flag `GlobalSettings.fiatLiquidityAuthorityEnabled` (default `false`)
  gates the wired integration: OFF = legacy `_reserveFiatPool`/re-credit paths;
  ON = the liquidity authority owns reserve/release/settle and the projection is
  deterministic. The evidence layer (receipts/events) is written on both settings
  when the deposit webhooks settle — evidence recording is always safe (no balance
  effects), availability only ever arises from evidence.

## 5. Invariants (each has a real-PG proof)

1. Only evidence creates AVAILABLE liquidity (deposit webhook settlement or audited
   treasury confirmation). No webhook, quote, client request or scalar increment can.
2. Reservation is a single-winner conditional decrement; concurrent withdrawals cannot
   over-reserve; losers fail closed.
3. Every receipt/reservation/settlement has a durable economic identity; replays
   converge to the same result; conflicting reuse fails closed.
4. Contradictory provider evidence is preserved and quarantined, never rewritten.
5. `availableGhs + reservedGhs + inTransitGhs` movement is atomic with state rows.
6. GHS amounts are exact `Decimal(20,2)` (pesewas); no float money in the authority.
7. Reconciliation categories compare the aggregate against evidence sums and write
   `ReconciliationException` rows (existing infra), fail-closed, never auto-repair.
8. P4 liability/restricted-obligation semantics are untouched; P5-D never posts
   customer economics; no quote-only spread/P&L; `pnl:inventory` untouched.
