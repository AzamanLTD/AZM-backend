# §P.5-E — Model B Settlement / Inventory Cost-Basis Realization

**Date:** 2026-09-19 UTC
**Base:** backend `main` `baaa4e2` (§P.5-D, PR #285; exact-head CI #1060 green)
**Authority:** `AZM-Planning/progress/2026-09-18_P5_INVENTORY_ROUTE_LIQUIDITY_INVESTIGATION.md` §4/§5/§8 (P5-E)
**Scope:** the authoritative settlement that links an evidence-backed GHS customer
payment to real USDC inventory consumption, the customer USDC liability, and realized
economics. Model B ONLY — NOT Kotani Model A, NOT exchange arbitrage, NOT treasury
four-eyes controls, NOT PoR UI, NOT unrelated cleanup.

---

## 1. Audit findings (current merged state, all traced in code)

The two mounted deposit settlement surfaces — `quoteFiatDepositController.webhook`
(secret-signed generic rail) and `moolreQuoteDepositController.webhook` (Moolre HMAC
collection) — settle a fiat deposit today as:

```
PENDING→COMPLETED CAS claim
consumeTransactionQuote (P5-C, route-bound, TTL, consume-once)
settled GHS matched against the quote (±0.01, exact pesewas)
User.availableBalance += quote.usdcAmount
ledger: D clearing:conversion / C user:{id}:liability            ← the temporary bridge
flag ON: fiatLiquidity.recordReceipt (P5-D evidence → AVAILABLE GHS)
```

`clearing:conversion` is therefore the accumulated USDC credited to customers from
fiat-settled deposits WITHOUT a modelled source: no GHS asset accounting, no
inventory consumption, no cost basis, no realized economics. It is a temporary §P.4
clearing state by design ("debit-side accumulation of fiat-settled conversions
pending §P.5") and `ledgerReconciliationService.reconcileClearingConversion` proves
it equals exactly its own P4-era postings.

`InventoryLot`/`InventoryLotConsumption` (P5-B) are the ONLY inventory authority:
immutable acquisition (`acquisitionKey` unique, replay/conflict semantics), atomic
`consumeLot()` claim (`updateMany({status OPEN, remaining >= q})` — concurrent racers
cannot double-allocate), consumption records allocation ONLY (no ledger posting, no
P&L) with `ledgerTxnId` reserved "set by P5-E settlement". `costBasisGhs` is the exact
GHS paid for the whole lot; `acquisitionRate` is provenance.

`ledgerService.post()` (P5-A) enforces: single-asset postings; GHS/USDC never
numerically balanced; `ASSET_CONVERSION` as the only explicit cross-asset mechanism
with durable exactly-once `{identity, rate, quoteReference}`; exact-decimal quantities;
per-asset leg balance.

The exact missing authority: **no settlement today consumes inventory, so the
customer's USDC is not backed by any real acquired position; the GHS the customer
paid never enters the GHS ledger books; no realized cost basis or spread exists.**

## 2. The P5-E accounting model (Model B settlement, flag ON)

One caller-owned `$transaction` per settlement on both surfaces. Existing P5-C/P5-D
steps are preserved verbatim (out-of-band evidence persistence BEFORE settlement;
quote consume; route-binding assert; exact-pesewa match; CAS claim; projection
increment; P5-D receipt under its own flag). P5-E replaces ONLY the bridge posting.

### 2.1 Inventory claim (FIFO — the explicit cost-flow policy)

**Policy contract (documented here per the planning investigation §5):** consumed
lot quantity is allocated **FIFO by `(createdAt, id)`** across `OPEN` lots. Rationale:
FIFO realizes the oldest acquisition cost first — the conservative, conventional
default for currency-like inventory on an immutable-lot substrate (no revaluation,
no LIFO jurisdiction complications, no average-cost recomputation under concurrency);
`(createdAt, id)` ordering is fully deterministic for replay and audit. This is the
smallest explicit policy needed for this slice; any change is a separate, separately
tested contract.

- Single-lot consumption, multi-lot fulfillment and the partially-consumed tail lot
  all fall out of the same deterministic loop.
- Insufficient total OPEN remaining → `MODEL_B_INVENTORY_INSUFFICIENT`, the whole
  settlement transaction rolls back: **zero customer credit, zero consumption, zero
  ledger rows, deposit stays PENDING, quote stays unconsumed** (retryable).
- Concurrency: claims go through the P5-B atomic substrate (`consumeLot`); a loser
  fails closed and its enclosing transaction rolls back untouched.
- Replay: `consumptionKey = p5e:modelb:{reference}:lot:{lotId}` is exactly-once;
  `purpose = 'MODEL_B_SETTLEMENT'`, `sourceReference = reference`.
- Quantity conservation is inherited from P5-B: `Σ remaining + Σ consumed == Σ acquired`.

### 2.2 Ledger postings (denomination-honest, explainable line-by-line)

For settled GHS `S` (exact pesewas), settled USDC `Q` (the committed
`TransactionHistory.amountUsdc`, Decimal(20,8)), quote rate `R` (exact 8dp):

**Posting 1 — `ASSET_CONVERSION`** (idempotencyKey `ledger:modelb:conversion:{reference}`,
conversion `{identity: p5e:modelb:{reference}, rate: R, quoteReference: quoteId}`) —
the exchange: treasury's inventory USDC is exchanged for the customer's GHS.

```
GHS leg (balances in GHS):
  D fiat:momo:ghs        S   — the customer's evidenced GHS payment lands as a platform GHS asset
  C equity:treasury:ghs  S   — attributed to treasury GHS equity (the proceeds)
USDC leg (balances in USDC):
  D expense:cogs:usdc    Q   — realized cost of the inventory delivered (exact quantity)
  C inventory:usdc:lots  Q   — the inventory asset is released exactly by the claimed quantity
```

**Posting 2 — `DEPOSIT`** (idempotencyKey `ledger:modelb:deposit:{reference}`) — the
customer's wallet claim, funded by the treasury USDC stake the lot acquisition created
(P5-B posts `D inventory:usdc:lots / C equity:treasury` at acquisition; this is that
stake being drawn):

```
  D equity:treasury      Q   — the treasury stake that funded the lot
  C user:{id}:liability  Q   — customer liability increases exactly by the settled amount
```

No line equates GHS with USDC numerically; each asset balances exactly within its own
leg; the cross-asset linkage lives ONLY in the durable conversion identity + rate +
quote reference. `equity:treasury` USDC nets to zero for a fully-sold lot, exactly
mirroring the P5-B acquisition counterpart. The `User.availableBalance` increment
(still `quote.usdcAmount`, landing on the same 8dp value as `amountUsdc`) keeps the
P4 ledger-equals-projection invariant.

**New catalog account:** `expense:cogs:usdc` (`EXPENSE`, normal `DEBIT`, `USDC`,
network `null`) — the realized cost of inventory delivered at settlement. It is a
minimal catalog extension in the P5-A chart tradition (`equity:treasury:ghs` was
added as catalog-only by P5-A the same way). `pnl:inventory` stays UNTOUCHED:
recognizing the GHS-denominated margin in the ledger would require either synthetic
GHS cost flows at acquisition (forbidden: the acquisition GHS payment predates the
ledger perimeter and has no GHS evidence row) or a rate-based USDC restatement of
the margin (numeric convenience, forbidden). The margin is realized as exact durable
data below. This boundary is deliberate and documented.

### 2.3 Realized economics (durable record, no quote-only P&L)

New table `ModelBSettlement` (unique `reference` — the durable economic identity):

- quote identity: `quoteId`, `quotedGhs`, `quotedRateGhsPerUsdc`, `quotedUsdc`
- route identity: `selectedRoute`, `routeProviderRail`, `routePolicyVersion`
- provider evidence: `provider`, `providerRef`, `evidenceDedupKey` (the
  `FiatProviderEvent.dedupKey` of the durable INBOUND observation — verified, not
  caller-asserted)
- settled economics: `settledGhs` (2dp exact), `settledUsdc` (8dp exact)
- inventory cost basis: `lotAllocations` JSON — per consumed lot: `{lotId,
  acquisitionKey, quantity, lotCostBasisGhs, lotQuantityOriginal, costShareGhs,
  remainingAfter}` — plus `costBasisGhsTotal`
- allocation exactness: a fully-consumed lot's `costShareGhs` is its `costBasisGhs`
  EXACTLY (no arithmetic); only a partially-consumed tail lot is prorated
  (`basis × q / original`, Decimal HALF_UP at 8dp) and any sub-8dp residual is
  recorded explicitly in `costAllocationResidualGhs`. The exact rational inputs
  (`basis`, `original`, `q`) are all durable, so the allocation is auditable to
  the ledger's own precision with nothing hidden.
- customer spread: `marginGhs = settledGhs − costBasisGhsTotal` (exact Decimal
  subtraction, GHS-denominated — never restated in USDC)
- provider cost/fee: `providerFeeGhs` — NULL unless actually evidenced
- linkage: `conversionIdentity` (unique), `conversionLedgerTxnId`,
  `depositLedgerTxnId`, `transactionHistoryId`, `userId`

Every figure derives from the actual settled evidence and the actually-claimed lots —
a quote alone realizes nothing.

### 2.4 `clearing:conversion` transition (closing the temporary state)

- New settlements under the P5-E regime **never post to `clearing:conversion`**.
- The existing balance (P4-era settlements) is **left untouched as an explicit,
  reconcilable legacy position**: migrating it would require inventing GHS/inventory
  evidence for historical deposits that does not exist (synthetic GHS / synthetic
  inventory are forbidden, and production financial-data correction is out of
  scope). `reconcileClearingConversion` continues to hold exactly, because its
  expectation is the account's own journal entries — which new settlements no
  longer touch.
- Removal/reclassification of the residual balance is a future, separately
  authorized remediation with its own evidence contract.

### 2.5 Rollout regime

New `GlobalSettings.modelBSettlementEnabled` (`Boolean @default(false)`), read the
same way as the P5-D flag. **OFF (default): byte-identical legacy bridge** — the
current `clearing:conversion` posting, no inventory requirement, no GHS ledger leg.
**ON: the Model B path above.** This mirrors the P5-D recorded-row rollout
discipline: authority ships dark, production data is untouched, and both regimes
are proven side by side. The two flags are independent: P5-D governs liquidity
truth (receipts/state/projection), P5-E governs settlement economics.

Note on the GHS ledger perimeter: `fiat:momo:ghs` now accumulates INBOUND settled
customer GHS (this slice). OUTBOUND payout GHS remains intentionally unmodelled in
`clearing:fiat:offramp:usdc` until its own wave — the asymmetry is documented, not
hidden.

## 3. Identity, replay and conflict semantics

- **Duplicate provider callback / duplicate settlement request:** the deposit's
  `COMPLETED` short-circuit returns the already-committed outcome (existing); a
  mid-transaction failure rolls back atomically and the provider retries.
- **Conflicting reuse:** the `ModelBSettlement` row is replay-verified on `reference`
  (any mismatch of the economic fingerprint fails closed
  `MODEL_B_SETTLEMENT_CONFLICT`); the ledger conversion identity is exactly-once
  across postings (`LEDGER_CONVERSION_IDENTITY_CONFLICT`); consumption keys are
  exactly-once with conflict-fail (`P5-B`); the quote is consume-once; the receipt
  dedup key is exactly-once. A replay never consumes inventory twice or recognizes
  economics twice.

## 4. Failure semantics (all proven with zero partial financial mutation)

Evidence: missing durable provider observation, mismatched GHS amount (beyond the
existing ±0.01 pesewa gate), wrong quote identity, wrong route/provider surface,
stale/expired quote, contradictory provider outcome. Inventory: insufficient
remaining. Identity: conflicting settlement reuse. Every failure throws inside the
caller-owned transaction — nothing commits.

## 5. Real-PostgreSQL proof requirements

Dedicated suite `p5e-model-b-settlement.test.js` covering: core settlement (exact
credit-once, ledger == projection, exact inventory decrement, exact cost capture,
exact realized record), inventory policy (insufficient fails closed, concurrency
cannot double-consume, deterministic multi-lot FIFO, replay consumes nothing,
conflicting identity fails closed), evidence failures (each with zero-mutation
proofs), economics (quoted vs settled vs cost basis vs realized spread, explicitly
separated), regime coverage (flag OFF bridge byte-compat, flag ON/OFF independence
vs the liquidity flag), and the extended P5-B invariant (ledger inventory balance ==
Σ remaining after consumption). Full clean serial battery, prisma validate,
route-check, dependency audit and the database recovery drill gate the slice.

## 6. Planning deliverables

`AZM-Planning/CURRENT_STATE.md`, `ACTIVE_LOOP.md`, `EXECUTION_LEDGER.json` and
`progress/2026-09-18_P5_INVENTORY_ROUTE_LIQUIDITY_INVESTIGATION.md` record the chosen
accounting model (clearing:conversion treatment, FIFO cost flow, GHS asset
accounting, customer liability funding, conversion identity, realized spread), the
rollout flag, and the verification evidence.
