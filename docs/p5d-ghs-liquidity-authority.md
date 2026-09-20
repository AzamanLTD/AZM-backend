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
3. **`processFiatWithdrawal` preflight unit mismatch (GHS vs USDC):** the legacy
   `SystemFiatPool` preflight also ran with the authority flag ON — comparing the
   GHS-denominated projection scalar against the USDC withdrawal amount. That is
   meaningless arithmetic: a stale/manipulated pool could false-reject a fully
   GHS-backed withdrawal (pool 0) or false-admit one the authority could not cover
   (pool 1,000,000). Fixed: with the authority ON the scalar preflight is skipped
   entirely — the liquidity decision is the atomic `reserveForPayout()` claim on the
   exact `payoutGhs` (identical `FIAT_POOL_INSUFFICIENT` failure surface); with the
   flag OFF the legacy USDC preflight stays byte-identical. The auto-payout worker's
   authority gate is now a pure operational headroom policy (threshold converted to
   GHS at the live rate), and the post-dispatch gauge no longer subtracts an
   already-reserved payout's GHS a second time (RESERVED → IN_TRANSIT never touches
   `availableGhs`). Both regimes have real-PG regression proofs with a
   stale/manipulated pool and an already-reserved payout.

4. **`payoutBatchWorker` recomputed the provider payout at the CURRENT rate and
   applied the regime globally by flag:** a later rate change silently mutated the
   GHS amount the provider was instructed to pay for an already-reserved
   withdrawal, and every pending row was treated as authority-regime whenever the
   flag was ON. Fixed with the per-row contract: the regime follows the RECORDED
   row — a `FiatLiquidityReservation` for the withdrawal's canonical reference IS
   the authority record, and its exact `amountGhs` (Decimal 2dp, string-derived) is
   the amount passed to `initiateTransfer` and persisted on the outbound
   `FiatProviderEvent`; the live rate is used ONLY for the operational threshold
   conversion and never mutates the economics of an existing reservation. A row
   WITHOUT a reservation predates P5-D and keeps the legacy `SystemFiatPool`
   pool/threshold policy even when the flag is ON — the flag governs only whether
   NEW withdrawals create reservations and never rewrites the meaning of historical
   rows. Authority-reserved processing does not read `SystemFiatPool` at all (the
   legacy pool is read lazily, only for legacy rows, and the batch summary's
   `poolBalance` is documented as the legacy projection gauge, never authoritative
   GHS liquidity). Real-PG regressions prove the rate-drift case (provider receives
   exactly the originally reserved GHS; RESERVED → IN_TRANSIT moves exactly the
   reserved amount; `availableGhs` untouched), the per-row legacy-vs-authority
   split (a drained authority headroom cannot hold a legacy row; a drained legacy
   pool cannot hold a reserved row), and single-reservation / no-second-decrement
   semantics.

---

## 3. The P5-D state machine

### 3.1 `FiatLiquidityReceipt` (inbound GHS evidence)

```
(matched deposit webhook settle tx) ──verified chain──▶ AVAILABLE
(no internal deposit)          ──▶ UNMATCHED ──confirmReconciliationMatch──▶ AVAILABLE
(internal audited USDC liquidation) ──▶ RECEIVED ──confirmTreasuryOpening──▶ AVAILABLE
AVAILABLE ──reverse──▶ REVERSED            (contradictory evidence / clawback, evidence kept)
any ──contradiction──▶ RECONCILIATION_REQUIRED
```

- `AVAILABLE` is created ONLY by a transition the SERVICE itself verifies
  against durable evidence — a caller's say-so is never sufficient:
  - **Matched deposit** (`recordReceipt` with a relatedTransactionId): the
    service verifies the full durable chain inside the caller transaction —
    a durable INBOUND `FiatProviderEvent` exists, reports a successful
    collection, matches the receipt's provider and amount EXACTLY, and is
    about the deposit's txHash; the `TransactionHistory` row exists, IS a
    `DEPOSIT_FIAT`, IS `COMPLETED` (authoritative settled state, CAS-claimed
    in the same tx), and its P5-C quote is consumed, user-consistent and
    route-consistent. Any gap or contradiction fails closed.
  - **UNMATCHED → AVAILABLE** (`confirmReconciliationMatch`): the match must
    name the matched deposit AND the durable provider observation; the
    service re-verifies the whole chain (event ↔ receipt ↔ deposit) and
    rejects a second receipt claiming the same deposit. Caller-asserted JSON
    never unlocks liquidity.
  - **Treasury opening** (`RECEIVED`, e.g. from `liquidateProfits`): an
    internal USDC liquidation records a NON-AVAILABLE, audited opening only
    — it CANNOT become AVAILABLE from the liquidation itself. ONLY
    `confirmTreasuryOpening` with a durable external GHS funding
    observation (bank/MoMo transfer reference) unlocks it. NO SYNTHETIC GHS.
- `RECEIVED`: durable evidence recorded; **not** spendable.
- `UNMATCHED`: evidence without a matched internal deposit — never available
  until a verified reconciliation match.
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

### 3.3 `FiatProviderEvent` (append-only raw evidence, INBOUND and OUTBOUND)

Every provider observation is appended with its raw payload before/with any state
change — on BOTH directions:

- **INBOUND** (collections/deposits): always carries the collected amount; the
  receipt evidence chain consumes it. Both deposit webhooks record the raw
  observation BEFORE the settle transaction, and a persistence failure is
  FAIL-CLOSED: no customer USDC is credited and no liquidity transition happens
  while the authoritative record of the provider's claim is missing (HTTP 503,
  deposit stays PENDING, provider retries).
- **OUTBOUND** (disbursements): dispatch acceptance (all three dispatch sites:
  manual MTN, manual Moolre, auto-payout worker), provider reference/transaction
  id, intermediate PENDING, terminal SUCCESS/FAILED, and contradictory
  callbacks/polls are ALL retained (a nullable amount models providers that
  report status only). `settleFiatWithdrawal` records the terminal observation
  durably BEFORE any authoritative settlement transition — persistence failure
  fails closed; the reconciliation worker records its poll answers and defers
  settlement when evidence cannot be persisted. `ProviderSettlementAttempt`
  stays as operational history; the authority's raw observations live here.

**Observation identity contract.** ONE `dedupKey` names ONE provider
observation, and the substrate (`recordProviderEvent`) enforces the identity
itself — no caller's say-so is trusted:

- The identity of an observation is its SEMANTIC authority fields —
  `provider`, `rail`, `direction`, `status`, `providerRef`, `amountGhs`,
  `relatedReference`. The raw payload is deliberately NOT identity: providers
  retry the same economic observation with byte-different bodies (timestamps,
  ordering, extra fields), and byte comparison would manufacture
  contradictions out of retries. A semantic duplicate converges to the
  committed row (`replay: true`) — the committed row's semantic claims are
  never rewritten. `providerRef` binds STRICTLY only when PRESENT (audit
  r10): two non-null refs that differ are materially different observations,
  but an ABSENT ref carries no claim — it neither contradicts a committed
  ref nor blocks convergence (the established null-tolerant comparison used
  by the receipt/event checks, and the same fill-in semantics as
  `markReservationInTransit`). Convergence may therefore ENRICH a committed
  null ref with the reference a retry now carries (strictly additive
  durable evidence; `receivedAt`/`status`/`amountGhs` stay exactly as
  committed) and never downgrades a committed ref. The enrichment claim is a
  database-enforced COMPARE-AND-SET on the NULL slot (audit r11): under
  concurrency, exactly ONE different present ref can ever win the slot — a
  concurrent loser converges only onto the winner's ref, or is rejected as
  contradictory evidence and retained under its deterministic conflict
  identity. The enrichment is therefore never last-writer-wins, and the
  durable provider identity is deterministic under real PostgreSQL
  concurrency. This is NOT a weakening
  of provider-reference binding: a PRESENT ref must match exactly —
  committed `PTX-1` vs incoming `PTX-2` is still contradictory evidence.
  Producers of optional refs are real: the generic deposit webhook's
  `providerTxId` has never been a required field, and payout callbacks can
  legitimately arrive before the provider's durable txid exists.
- A materially different payload under an already-committed identity is
  CONTRADICTORY EVIDENCE: it is retained as a DISTINCT durable row under a
  deterministic conflict identity (`<dedupKey>:CONFLICT:<fingerprint>`, so
  exact retries of the contradictory payload converge to that row) and the
  call FAILS CLOSED with a typed `LIQUIDITY_CONFLICTING_EVIDENCE` error —
  the caller can never proceed as though the new payload were the committed
  observation. Both rows stay queryable for ops; nothing collapses silently.
  The operational flagging is GUARANTEED honest (audit r10): surfaces may
  only report the contradiction "flagged for reconciliation" after the
  `ReconciliationException` write actually committed — if that write fails,
  the retained evidence is NOT rolled back and the surface answers
  fail-closed (500, `CONTRADICTION_RETAINED_FLAGGING_FAILED`) instead of the
  flagged 409, so a retry of the same callback re-attempts the flagging.
- Surfaces derive the identity from fields actually present in the
  callback, never invented. The generic deposit webhook uses a status-scoped
  identity (`event:fiat-deposit:<reference>:<status>`), where `<status>` is
  the ONE authoritative interpretation of the callback's raw status field
  (audit r10): omitted, `SUCCESS` and `SUCCESSFUL` (case-insensitive) are the
  supported success representations and all normalize to the `SUCCESSFUL`
  evidence status; `FAILED` (case-insensitive) is the supported failure
  representation; ANY other token (unknown aliases, whitespace-padded
  strings) is durably retained as evidence under its own status-scoped
  identity but is NEVER interpreted as a lifecycle decision — the deposit
  stays PENDING and the call fails closed with 422. The same interpretation
  drives evidence identity AND lifecycle, so no raw representation can be
  durably recorded as one status and then acted on as another. Deposit
  webhook amounts are parsed through `toExactGhsDecimal` at the boundary —
  never through JS Number (audit r10): sub-pesewa input is rejected
  fail-closed instead of silently collapsing through a float, and the
  ±0.01 flag-OFF legacy tolerance is exact decimal arithmetic (uniformly
  one-pesewa-inclusive at every magnitude). Example: a SUCCESS and a
  FAILED observation for the same reference are DISTINCT durable rows, and a
  late contradictory callback against a terminal deposit is still recorded
  (evidence first, state second) while the settlement economics stay
  untouched. Moolre's settlement surface records only successful P01
  collections, so its identity is `event:moolre-collection:<externalref>`
  with a constant status dimension. Outbound identities are status-scoped
  where a reference can legitimately carry more than one observation
  (`event:payout-outbound:<provider>:<reference>:<status>`); a payout
  dispatch reference names exactly one dispatch (`event:payout-dispatch:<provider>:<reference>`).
- Deposit webhooks record the observation BEFORE any state decision — a
  contradictory late callback against a COMPLETED/FAILED deposit stays
  durably visible instead of vanishing behind an early return. This
  "evidence before state checks" begins once the surface has enough
  authoritative identity to CONSTRUCT the observation.
- Generic callbacks can derive a status-scoped observation identity
  directly from the callback's own fields. Moolre's callback cannot: its
  payload ({ txstatus, payer, amount, externalref, ... }) does not carry
  the initiation response's durable providerRef, so a Moolre observation is
  only identifiable once that reference exists on the initiation record.
  The durable Moolre providerRef is therefore an observation-identity
  PREREQUISITE, not a generic state check: an early P01 callback that
  arrives before the initiation path has stamped
  `TransactionHistory.providerRef` fails closed with 409 and creates NO
  provider event (recording it with providerRef = NULL would commit the
  identity first and make the provider's later legitimate retry — same
  dedupKey, now carrying the stamped reference — fail as contradictory
  evidence, permanently blocking settlement). Once the reference exists,
  the observation is recorded before any state decision and settlement
  proceeds; the deposit stays PENDING and retryable until then.

Contradictory evidence raised on a deposit surface is additionally flagged
`ReconciliationException (CONTRADICTORY_PROVIDER_EVIDENCE)` and answered
HTTP 409; a genuinely distinct later observation (different status ⇒ its
own identity) is never blocked by an earlier contradictory one. A failure in
post-dispatch bookkeeping (evidence/IN_TRANSIT after the provider accepted a
payout) NEVER auto-refunds the dispatched cash — that would double-spend;
it is flagged for manual review instead.

### 3.4 `FiatLiquidityState` (singleton aggregate) + the reconciliation hold

`availableGhs`, `reservedGhs`, `inTransitGhs`, `paidOutGhs`,
`reconciliationHeldGhs` — each transition is a guarded conditional update in the
same transaction as its evidence/state row. The aggregate is the claimable
authority; sums over receipts/reservations are the reconciliation target.

`reconciliationHeldGhs` is the quarantine bucket. When contradictory provider
evidence quarantines a reservation, its disputed amount moves to hold so it is
counted but NEVER spendable:

- prior `RESERVED` → `reservedGhs −→ reconciliationHeldGhs`
- prior `IN_TRANSIT` → `inTransitGhs −→ reconciliationHeldGhs`
- prior `RELEASED` + contradictory SUCCESS → `availableGhs −→ reconciliationHeldGhs`
  (guarded: if the released funds were already consumed by later payouts, the move
  is impossible; `CONTRADICTORY_RELEASE_ALREADY_SPENT` flags the potential
  over-spend loudly instead of hiding it)
- prior `PAID_OUT` + contradictory FAILED → no move (already non-spendable); the
  contradiction is quarantined and flagged.

Conservation identity (all buckets, each checked against evidence sums by
`reconcile()`):

```
evidence-backed AVAILABLE receipts
  = available + reserved + inTransit + reconciliationHeld + paidOut
```

`payoutBatchWorker`'s liquidity regime follows the RECORDED row, never the
current flag. A reservation-backed row dispatches EXACTLY the reserved
`amountGhs` (a later rate change can never mutate the provider payout) and its
gate is the operational headroom policy — GHS compared with GHS, its
USDC-configured threshold converted at the live rate with exact pesewa
arithmetic — while `SystemFiatPool` is never read for it and the reservation is
never re-claimed (RESERVED → IN_TRANSIT moves exactly the reserved amount).
A row without a reservation keeps the legacy USDC pool/threshold policy even
when the flag is ON; the flag only decides whether NEW withdrawals create
reservations.

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

1. Only VERIFIED evidence creates AVAILABLE liquidity. The service itself verifies
   the durable chain (provider event ↔ receipt ↔ settled deposit ↔ consumed quote);
   a forged or mismatched relatedTransactionId, a caller-asserted "reconciliation
   match", an absent provider event, an amount mismatch, or a wrong transaction
   type/state all fail closed with no liquidity effect. No webhook, quote, client
   request or scalar increment can create availability.
2. NO SYNTHETIC GHS: an internal USDC liquidation (`liquidateProfits`) never creates
   spendable GHS — it records a NON-AVAILABLE audited treasury opening that requires
   a durable external GHS funding observation (`confirmTreasuryOpening`) to unlock.
3. Reservation is a single-winner conditional decrement; concurrent withdrawals cannot
   over-reserve; losers fail closed. The auto-payout worker never double-reserves a
   withdrawal already reserved by `processFiatWithdrawal`.
4. Every receipt/reservation/settlement has a durable economic identity; replays
   converge to the same result; conflicting reuse fails closed.
5. Contradictory provider evidence is preserved and quarantined, never rewritten —
   and the disputed amount moves into the reconciliation hold so it is counted but
   never spendable again (including released-then-contradicted payouts: the returned
   amount leaves availability and enters hold; a second payout cannot consume it).
6. Evidence persistence is part of the authority boundary, not best-effort logging:
   an inbound observation that cannot be durably recorded blocks the deposit
   settlement (fail closed); an outbound terminal observation that cannot be durably
   recorded blocks the payout settlement transition.
7. `availableGhs + reservedGhs + inTransitGhs + reconciliationHeldGhs` movement is
   atomic with state rows, and reconciliation conservation covers ALL buckets.
8. GHS amounts are exact `Decimal(20,2)` (pesewas); no float money in the authority.
9. Reconciliation categories compare the aggregate against evidence sums and write
   `ReconciliationException` rows (existing infra), fail-closed, never auto-repair.
10. P4 liability/restricted-obligation semantics are untouched; P5-D never posts
   customer economics; no quote-only spread/P&L; `pnl:inventory` untouched.

## 6. Receipt ownership & replay identity (audit r14)

The r14 audit hardened the authority's idempotency boundary under GENUINE
PostgreSQL concurrency. All of it is proven by
`__tests__/p5r14-receipt-race-identity.test.js` (real PG, Prisma never mocked,
deliberate interlocked transactions that hold the winner open past its write so
the loser genuinely blocks on the uncommitted row/index entry).

### 6.1 §A — the ownership claim is ONE atomic guarded INSERT

`recordReceipt` owns its dedupKey with
`INSERT ... ON CONFLICT (dedupKey) DO NOTHING RETURNING ...`:

- The creator branch runs ONLY on `RETURNING` non-empty; it is the ONLY code
  that performs the liquidity increment. Exactly one increment per identity,
  by construction, under any interleaving.
- A concurrent duplicate NEVER surfaces Prisma P2002 (which would abort the
  loser's whole PostgreSQL transaction): `ON CONFLICT DO NOTHING` blocks until
  the concurrent winner commits or rolls back, then returns zero rows. The
  loser re-reads the authoritative row INSIDE the same still-valid
  transaction and converges with `{ replay: true, raced: true }` and ZERO
  mutation.

### 6.2 §B — ONE dedupKey names ONE receipt (full replay identity)

A replay must match the FULL semantic economics, not just the key. The
identity is asserted from DURABLE receipt columns — provider, rail,
amountGhs (compared as exact `Decimal(20,2)`-canonical strings, never Prisma
Decimal object identity), route, reference, eventDedupKey, relatedTransactionId
— PLUS the economic class (matched vs unmatched vs treasury). Any differing
replay throws `LIQUIDITY_CONFLICTING_EVIDENCE` with the differing fields named,
and mutates nothing. `providerRef` is enrichment-only: NULL→present is a
database-enforced compare-and-set (a racing pair of DIFFERENT present refs has
exactly one winner; the loser fails closed), a present ref is immutable and is
never downgraded.

### 6.3 §L — quote substitution is closed (with the r13 audit)

`verifyDepositEvidenceChain` requires the receipt to name the deposit's OWN
quote (the `TransactionHistory.metadata.quoteId` binding), and a matched
receipt cannot be recorded — or REPLAYED — under a different quote id. A
same-user TWIN quote with identical economics can never satisfy the chain:
existence/consumption/user/route checks alone prove nothing about WHICH quote
the deposit was initiated with.

### 6.4 §M — payout identity is never last-writer-wins

`markReservationInTransit` and `settleReservation` write the payout
providerRef only through a compare-and-set on the NULL slot: a racing pair
with different refs has exactly one winner; the loser fails closed (or, on a
terminal row, is quarantined `RECONCILIATION_REQUIRED`). Same-ref replays
converge side-effect free.

### 6.5 Migration & harness notes

- The P5-D migration is replay-safe (guarded `IF NOT EXISTS` /
  `IF NOT EXISTS (SELECT ... FROM pg_constraint)` everywhere), matching the
  overlay installer's convergent style.
- Harness integrity (§S of the audit): deposit-initiation helpers in the
  p5d/p5e/r10/r12/r13 suites used to "find the just-created deposit" via
  `findFirst(orderBy: { id: 'desc' })` — but `TransactionHistory.id` is a
  UUID, so that ordering is a lexical coin-flip that returned the WRONG row
  ~50% of runs when a user had two PENDING deposits (it made the r13
  binding suite's two-deposit test flaky). All helpers now bind to the 201
  body's `data.reference` (`findUnique` by txHash) — deterministic.
