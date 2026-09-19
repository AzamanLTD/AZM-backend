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

### 2.0 Service-level authority binding (audit r1)

The exported primitive `settleDepositFromInventory` NEVER trusts its caller —
not even the mounted controllers. Inside the same caller-owned transaction,
BEFORE the inventory claim, it re-verifies every caller-supplied value against
the PERSISTED authorities:

- the settled `TransactionHistory` row: `txHash === reference`, `type =
  DEPOSIT_FIAT`, `userId` match, `status = COMPLETED`, `amountUsdc === settledUsdc`
  exactly (the committed 8dp amount);
- the exact persisted `TransactionQuote` (raw-SQL boundary, exact decimal strings —
  never `Number()` projections): `id`, `userId`, `purpose`, `consumedAt != null`,
  `consumedFor = 'deposit'`, persisted `amountGhs`/`rateGhsPerUsdc` exactly equal the
  supplied quote economics, the supplied `quotedUsdc` is REQUIRED (audit r4 —
  `null`/omitted fails closed `MODEL_B_QUOTE_USDC_MISSING` before any database
  read or mutation, for fresh calls AND replays alike), the persisted
  `usdcAmount` equals the supplied `quotedUsdc` EXACTLY at its native 12dp
  authority (audit r3 — a value that differs only at the 9th–12th decimal
  fails closed even when its 8dp projection is unchanged), the persisted
  `usdcAmount` projected once at 8dp HALF_UP equals
  the committed `settledUsdc` (the ledger settlement boundary), and the
  persisted route identity (`selectedRoute`, `routeProviderRail`,
  `routePolicyVersion`) exactly equals the supplied route;
- **Model B requires exact pesewa equality** between the evidenced settled GHS and
  the persisted quote amount (`MODEL_B_SETTLED_GHS_MISMATCH`). The ±0.01 surface
  tolerance is a flag-OFF legacy affordance ONLY — under the Model B regime both
  mounted surfaces enforce exact Decimal equality before any mutation;
- the durable provider evidence: `FiatProviderEvent.provider === provider` and,
  when supplied, `providerRef` exact match — a different provider's or provider
  reference's observation can never vouch for this settlement.

Every mismatch fails closed with zero mutation (proven per-case in suite G, direct
primitive, identical pre/post snapshots). The durable `ModelBSettlement` row
therefore links ONLY these verified persisted identities.

One caller-owned `$transaction` per settlement on both surfaces. Existing P5-C/P5-D
steps are preserved verbatim (out-of-band evidence persistence BEFORE settlement;
quote consume; route-binding assert; exact-pesewa match; CAS claim; projection
increment; P5-D receipt under its own flag). P5-E replaces ONLY the bridge posting.

The PENDING→COMPLETED claim (audit r5) is a **database-enforced conditional
update**, not the controller's earlier `status === 'PENDING'` read: the claim is
`updateMany({ where: { id, status: 'PENDING' }, data: { status: 'COMPLETED', ... } })`
with an exactly-one-affected-row requirement, inside the caller-owned `$transaction`.
A competing failure callback (PENDING→FAILED) that commits between the controller's
pre-read and the claim leaves the conditional update matching zero rows — the
success path then fails closed and the ENTIRE settlement transaction (quote
consumption, credit, ledger, Model B settlement, receipt) rolls back. A terminal
FAILED deposit can never be resurrected to COMPLETED, and a committed settlement
can never be unwound or re-failed: the failure transition is the same conditional
claim (`where: { id, status: 'PENDING' }`), so a late failure callback against a
COMPLETED row affects zero rows. The state-machine authority is the database
predicate itself.

### 2.1 Inventory claim (FIFO — the explicit cost-flow policy)

### 2.1a Inventory acquisition authority (the r1 audit — structural darkness)

Audited finding: **no production-callable inventory acquisition path exists.**
`inventoryService.acquireLot` has zero production callers (tests only); lots can
enter the system today ONLY through test fixtures or direct DB writes. There is
consequently no authoritative acquisition-evidence row, and inventing one (e.g.
caller-attested "corporate purchase" evidence) would be a new financial story —
forbidden (planning §5, audit r1).

The gate that makes this structural rather than flag-dependent:
`InventoryLot.eligibleForModelBSettlement` (Boolean, **default `false`**).

- Model B settlement claims **ONLY eligible lots**; ineligible quantity does not
  even count toward availability. Quantity alone can NEVER fund a real customer
  USDC liability.
- No production code path grants eligibility. Only a future, narrowly scoped,
  evidence-backed acquisition authority (its own wave, its own evidence contract)
  may set it — until then Model B stays dark **by construction**, not by flag
  discipline alone.
- Proven in suite I: acquireLot lots are ineligible by default; an ineligible
  500-USDC lot cannot fund a 7.45-USDC settlement (fail closed, zero mutation);
  the same deposit settles ONLY after an explicit eligibility grant.

**Policy contract (documented here per the planning investigation §5):** consumed
lot quantity is allocated **FIFO by `(createdAt, id)`** across eligible `OPEN`
lots. Rationale:
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
  caller-asserted). The deposit surfaces pass the RETURNED committed event
  row's `dedupKey` (never a re-invented key), and the substrate's
  observation-identity contract (§P.5-D docs §3.3) guarantees the key
  resolves to the observation that actually settled: replay converges only
  on semantic match, a materially different observation under the identity
  is retained as a distinct conflict row and fails closed
  (`LIQUIDITY_CONFLICTING_EVIDENCE` → HTTP 409 + open
  `ReconciliationException`), and the generic webhook's status-scoped
  identity keeps SUCCESS and FAILED observations for the same reference as
  DISTINCT durable rows — a prior FAILED observation can never masquerade as
  SUCCESS evidence, and a legitimate SUCCESS is never handed a FAILED row
  as its replay
- USDC precision contract (audit r6, documented deliberately): the quote row
  `TransactionQuote.usdcAmount` (numeric(30,12)) is the CANONICAL native-12dp
  source of truth and is never widened, rounded or restated there; the
  settlement snapshot `ModelBSettlement.quotedUsdc` (Decimal(20,8)) is the
  DELIBERATE 8dp ledger-scale projection of that canonical value — the same
  HALF_UP projection the committed `TransactionHistory.amountUsdc` carries.
  The settlement primitive binds the SUPPLIED `quotedUsdc` to the persisted
  quote at its native 12dp authority (exact Decimal equality, audit r3) and
  separately requires the 8dp projection to equal the committed
  `settledUsdc`; the 8dp snapshot on the settlement row is therefore an
  intentional ledger-scale record, not a silent schema narrowing, and must
  NOT be widened unless the contract itself changes to require the
  settlement row to preserve 12dp.
- settled economics: `settledGhs` (2dp exact), `settledUsdc` (8dp exact)
- inventory cost basis: `lotAllocations` JSON — per consumed lot: `{lotId,
  acquisitionKey, quantity, lotCostBasisGhs, lotQuantityOriginal, costShareGhs`
  (the recorded 8dp share), `shareResidualGhs` (the TRUE 12dp residual),
  `remainingAfter}` — plus `costBasisGhsTotal`, the EXACT sum of the RECORDED 8dp
  shares (the record and its total can never disagree)
- allocation exactness: a fully-consumed lot's `costShareGhs` is its `costBasisGhs`
  EXACTLY (no arithmetic); only a partially-consumed tail lot is prorated
  (`basis × q / original`, projected ONCE at 8dp HALF_UP) and the TRUE sub-8dp
  residual (`shareExact − costShare8`, never re-rounded to 8dp) is recorded
  explicitly in `costAllocationResidualGhs` (Decimal(20,12), the residual precision)
  and per-allocation `shareResidualGhs`. Auditable identity: `costShareGhs +
  shareResidualGhs == shareExact` exactly whenever the residual is representable at
  12dp (proven in suite J with the engineered 9-decimal residual −0.000000005).
  The exact rational inputs
  (`basis`, `original`, `q`) are all durable, so the allocation is auditable to
  the ledger's own precision with nothing hidden.
- customer spread: `marginGhs = settledGhs − costBasisGhsTotal` (exact Decimal
  subtraction, GHS-denominated — never restated in USDC)
- provider cost/fee: `providerFeeGhs` — **NULL-ONLY in this slice** (audit r6).
  P5-E has no provider-fee evidence authority: the durable evidence model
  (`FiatProviderEvent`) carries no fee field, and the mounted settlement paths
  never supply one. A non-null caller-supplied fee is therefore UNEVIDENCED BY
  CONSTRUCTION — the primitive rejects it `MODEL_B_PROVIDER_FEE_UNEVIDENCED`
  before any database read, the inventory claim and every financial mutation.
  No fee is ever derived from `FiatProviderEvent.raw`, parsed from provider
  JSON, or inferred from settlement arithmetic — that would manufacture a new
  authority contract inside P5-E. The field is part of the replay fingerprint
  (null-only today; a row carrying a non-null fee — which no supported path
  can create — conflicts on replay instead of silently matching). P5-E records
  `providerFeeGhs = null` until a dedicated, provider-bound, durable
  provider-fee evidence authority exists.
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
- **Conflicting reuse (audit r2 — replay authority binding):** the replay
  evaluation runs AFTER the full authority binding (persisted
  `TransactionHistory`, exact persisted `TransactionQuote`, durable provider
  evidence). The `ModelBSettlement` row is then replay-verified on `reference`
  across EVERY caller-supplied field — `transactionHistoryId`, `userId`,
  `quoteId`, `quotedGhs`, `quotedRateGhsPerUsdc`, `quotedUsdc`, `settledGhs`,
  `settledUsdc`, `selectedRoute`, `routeProviderRail`, `routePolicyVersion`,
  `provider`, `providerRef`, `evidenceDedupKey` — any mismatch fails closed
  `MODEL_B_SETTLEMENT_CONFLICT`. The existing-settlement lookup can never bypass
  authority validation: a wrong-field replay fails at the binding or the
  committed-row comparison, deterministically, with zero mutation. The ledger
  conversion identity is exactly-once across postings
  (`LEDGER_CONVERSION_IDENTITY_CONFLICT`); consumption keys are exactly-once
  with conflict-fail (`P5-B`); the quote is consume-once; the receipt dedup key
  is exactly-once. An exact same-authority replay returns the committed
  settlement with `replayed=true` and no inventory consumption, no duplicate
  settlement, and no additional ledger rows. A replay never consumes inventory
  twice or recognizes economics twice.

## 4. Failure semantics (all proven with zero partial financial mutation)

Evidence: missing durable provider observation, mismatched provider identity or
providerRef, mismatched GHS amount (Model B: ANY pesewa difference; the ±0.01 gate
survives only flag-OFF), wrong quote identity/economics/route (service-level
binding), wrong TransactionHistory identity/amount, stale/expired or unconsumed
quote, contradictory provider outcome. Inventory: insufficient
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
