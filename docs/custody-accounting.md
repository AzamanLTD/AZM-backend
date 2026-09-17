# §P.3 — Custody Accounting: Accounts, Movements, Evidence, Proof of Reserves

**Status:** implemented 2026-09-17. Production execution remains gated by §P.2
(`TATUM_PROVIDER=LIVE` + `TATUM_KMS_ENABLED` + `TATUM_CRYPTO_EXECUTION_ENABLED`).
This phase adds custody **accounting** and **evidence**; it does not broadcast
anything and does not move production funds.

## One accounting truth

| Concern | Authoritative structure | §P.3 role |
|---|---|---|
| Deposit address ownership | `WalletAddress` registry (§P.1) | unchanged — the authority custody accounts link to |
| External on-chain execution | `CustodyExecution` (§P.2) | unchanged — settleExecution additionally emits the custody movement **in the same DB transaction** |
| Custody identity | **`CustodyAccount`** (new) | durable custody identities: `USER_DEPOSIT_ADDRESS`, `MASTER_HOT_WALLET` |
| Custody economics | **`CustodyMovement`** (new) | economic/custody accounting identity, evidence-gated |
| Custody evidence | **`CustodyEvidence`** (new) | normalized observations; ONE accepted (ACTIVE) balance observation per account (partial unique index) |
| Reserve reporting | `ProofOfReservesSnapshot` (extended) | new nullable columns; legacy fields keep their shape |

The ledger is NOT duplicated: verified custody movements post balanced
double-entry rows into the existing `JournalEntry` table with **exact**
`Prisma.Decimal` values derived from integer base units (never `parseFloat`),
under deterministic transaction IDs (`CUSTODY-<movementId>`), idempotently.

## Tiers implemented now

- `USER_DEPOSIT_ADDRESS` — §P.1 registry-linked deposit addresses.
- `MASTER_HOT_WALLET` — the configured hot wallet
  (`TATUM_HOT_WALLET_ADDRESS`, must agree with `TATUM_TREASURY_ADDRESS`).

`COLD_LEDGER_RESERVE`, `EXCHANGE_LIQUIDITY`, `PROVIDER_BALANCE`,
`TREASURY_BUFFER`, `IN_TRANSIT` are **future phases** — no operational
mechanism exists for them in §P.3, and none is simulated.

## Evidence contract — two non-interchangeable kinds

1. **Account balance observation** (`TATUM_V3_TOKEN_BALANCE`,
   `GET /v3/blockchain/token/balance/{chain}/{contract}/{address}` →
   `Erc20Balance.balance`, exact smallest-unit string).
   - Valid for the **PoR reserve numerator only**.
   - Proves an address held a quantity at observation time — proves **nothing**
     about any individual transaction.
   - The response carries **no block reference**: freshness is
     `observedAt` + `CUSTODY_EVIDENCE_MAX_AGE_MINUTES` (default 15). Nothing
     claims real-time semantics.
   - A new observation **supersedes** the previous accepted one (old row kept
     `SUPERSEDED` for audit). Out-of-order observations are recorded as
     `REJECTED` and can never silently overwrite a newer accepted value.
     Concurrent observations converge on the partial unique ACTIVE index.

2. **Transaction observation** (`TATUM_V4_TX_BY_HASH`,
   `GET /v4/data/transactions/hash?chain=polygon-mainnet&hash=…` → `TxData[]`).
   - The **only** path by which a webhook-identified deposit becomes a
     `VERIFIED` custody movement. It must establish, together: exact hash,
     `polygon-mainnet`, **native USDC contract** (bridged USDC.e is rejected),
     the customer's deposit address, `incoming` direction, exact quantity
     (exact decimal-string → base units), and the block reference the source
     supplies. A matching-unrelated transaction must not verify.

3. **§P.2 verified chain transfer** (`CUSTODY_EXECUTION_VERIFIED_CHAIN`).
   Sweeps and customer withdrawals settle only on `verifyChainTransfer`
   evidence (§P.2); their custody movements are created **VERIFIED inside the
   settlement transaction** — atomic with the execution completion.

### Deposit lifecycle

```
webhook (HMAC-verified, registry-owner-resolved, §P.1)
  └─ atomic with the credit: CustodyMovement DEPOSIT_IN = CANDIDATE
       (idempotency key deposit:POLYGON:<txHash>)
webhook observation alone verifies NOTHING
  └─ verifyDepositMovement → Tatum v4 tx-by-hash validation
       ├─ success  → VERIFIED + CustodyEvidence(TRANSACTION) + exact journal
       ├─ definitive mismatch (WRONG_CONTRACT/ADDRESS_MISMATCH/AMOUNT_MISMATCH/
       │  NOT_INCOMING/NOT_CONFIRMED) → FAILED + explicit failureReason
       │  (the credit is NOT auto-reversed — that is an auditable ops decision)
       └─ provider unavailable → stays CANDIDATE (retryable, fail-closed)
```

Existing webhook credits are **not** retroactively "proven" by the existence of
a movement row: until verification succeeds they contribute to the USDC flow
classification (X) but **zero** to the evidence-linked subset (Y).
`buildDepositCandidatesFromHistory` (ops helper, not automatic) can build
candidates for historical `DEPOSIT_CRYPTO` rows whose identity (owner's ACTIVE
registry address, txHash, credited amount) is derivable from authoritative
rows — candidates still require the same transaction evidence validation.

## Denomination-honest liability report

`User.availableBalance` is a **mixed historical pool** (fiat-funded credits,
crypto deposits, AZM conversions, internal flows). It is never reinterpreted
wholesale as USDC. The report separates:

- **X `usdcLiabilityTotal`** — USDC-denominated customer obligation, net
  external flows from authoritative rows:
  credits `DEPOSIT_CRYPTO`(COMPLETED) + `DEPOSIT_FIAT`(COMPLETED — the
  quote paths settle in USDC: `amountUsdc`, `settlementCurrency: 'USDC'`)
  − debits `WITHDRAWAL_CRYPTO`(COMPLETED, net+fee) +
  `WITHDRAWAL_FIAT`(COMPLETED, net+fee).
  **Fiat-funded USDC-settled claims are NOT silently excluded.**
- **Y `evidenceLinkedLiabilityTotal`** — transaction-evidence-verified deposit
  movements − evidence-gated `WITHDRAWAL_CRYPTO` net payouts.
- **Z `unclassifiedExposure`** — mixed-pool liability total − X, floored at 0.
  Z > 0 means the pool contains claims the classification cannot explain
  (AZM conversions, adjustments, historical anomalies). **Z is never dropped
  from the denominator**: it forces `liabilityAttestation: INCOMPLETE` and
  `isFullyBacked: false`.
- **A `eligibleReserveTotal`** — the exact sum of fresh accepted balance
  evidence over eligible accounts. `SystemMasterCrypto` /
  `SystemHotWallet` synthetic singletons contribute **zero** authoritative
  reserve assets; they are exposed only as clearly-labeled legacy display
  values.

Coverage: `A/X` (total USDC obligation) and `A/Y` (evidence-linked subset) are
both reported. `isFullyBacked` requires `A ≥ X` **and** `Z = 0` **and** every
eligible account having fresh accepted evidence.

### Restricted obligations

The invariant target is `REAL USDC ASSETS ≥ ALL CUSTOMER USDC LIABILITIES +
RESTRICTED OBLIGATIONS`. Restricted obligations (platform fee holdings,
reserve buffers) have **no authoritative persisted semantics yet** — the
boundary is explicit (`restrictedObligationsTotal: null`,
`restrictedObligationsAvailable: false`), never invented as zero. Closing it
is §P.4+ work; §P.3 exposes the gap cleanly rather than bridging it
synthetically.

## Fail-closed rules

- No accepted fresh evidence → snapshot records `EVIDENCE_UNAVAILABLE` and is
  **not** fully backed. The previous reserve is never presented as current.
- Unclassified exposure (Z>0) → attestation `INCOMPLETE`, `isFullyBacked: false`.
- A registry-retired deposit address cannot re-enter the reserve set
  (accounts are re-validated against the §P.1 registry at snapshot time and
  marked `RETIRED` when the registry says so).
- Evidence rows whose observed semantics do not bind to the requested
  address/contract/network are rejected, recorded, and never aggregated.
- `verifyUser` Merkle proofs over the four balance fields are unchanged:
  existing per-user commitments remain valid.

## Explicit scope boundaries (pre-existing, flagged for §P.4+)

- The legacy `POST /api/finance/webhook/deposit` crypto-deposit path still
  credits from a body-supplied `userId` (same class §P.1 closed for the Tatum
  webhook) — its rows are counted in X but can never reach Y.
- The legacy manual `Withdrawal` queue (`walletController.requestWithdrawal`)
  debits the mixed pool off-platform without chain-evidenced
  `TransactionHistory` rows — outside the X/Y net-flow classification, and
  surfaced by Z.
- Realized network gas economics (MATIC-denominated) are a later phase — no
  journal entry is posted from estimates.

## Operations

- `node infra/install-custody-accounting-overlay.js` — idempotent boot
  installer (tables, partial unique indexes, additive enum values, nullable
  snapshot columns). Mirrored by
  `prisma/migrations/20260917180000_custody_accounting/migration.sql`.
- CI applies it after `prisma db push` (see `.github/workflows/test.yml`).
- `POST /api/proof-of-reserves/refresh` (admin) — unchanged surface, new
  semantics; `GET /api/proof-of-reserves` exposes the additive fields;
  `GET /api/journal/integrity` surfaces the attestation/evidence status.
