# Custody Execution Boundary (§P.2) — KMS-capable Polygon USDC execution

`services/tatumCustodyExecutionService.js` is the **single canonical external
crypto execution boundary**. Customer withdrawals and deposit sweeps both go
through it. Nothing else in the application constructs Tatum transfer payloads.

## Production safety switches (real signing is DISABLED by default)

Real signing/broadcasting requires ALL of:

```
TATUM_PROVIDER=LIVE
TATUM_KMS_ENABLED=true
TATUM_CRYPTO_EXECUTION_ENABLED=true
```

If any flag is absent: no real broadcast, no fake success, **no fake tx hash**,
and the withdrawal endpoint returns `503 CRYPTO_EXECUTION_NOT_ENABLED`
**before any customer debit**.

There is **no production code path that accepts `fromPrivateKey`** — not from
environment variables, not from request bodies, not from payloads. KMS
`signatureId` is the only signing mechanism, and there is no silent fallback.

## KMS identity configuration

| Variable | Purpose |
|---|---|
| `TATUM_KMS_SIGNATURE_ID` | KMS signatureId controlling customer deposit addresses (mnemonic-based HD wallet; derivation index = `WalletAddress.derivationIndex`, i.e. `user.id` per the §P.1 rule) |
| `TATUM_KMS_CHAIN` | Must be Polygon (default `POLYGON`) |
| `TATUM_KMS_ENVIRONMENT` | `MAINNET` / `TESTNET` — must match the API key's environment |
| `TATUM_KMS_FOUR_EYE_REQUIRED` | Default `true`. Tatum's KMS requires the four-eye principle for mainnet |
| `TATUM_HOT_WALLET_SIGNATURE_ID` | KMS signatureId controlling the master hot wallet |
| `TATUM_HOT_WALLET_INDEX` | Derivation index for the hot wallet signer (default `0`) |
| `TATUM_HOT_WALLET_ADDRESS` | Master hot wallet address (the withdrawal sender + sweep destination) |
| `TATUM_TREASURY_ADDRESS` | Legacy sweep destination; if set, must EQUAL `TATUM_HOT_WALLET_ADDRESS` or execution fails closed |
| `TATUM_KMS_SIGNER_REGISTRY` | JSON array of `{ signatureId, index, address, model }` — the KMS signer registry (see below) |
| `TATUM_KMS_VALIDATOR_ALLOWED_IPS` | Optional comma-separated IP allowlist for the four-eye validator route (unset = open, topology-protected) |

The customer-deposit signer and the master-hot signer are **separately
configured identities**. A signer/address mismatch is a hard
`SIGNER_MISMATCH` failure; an existing customer address is never silently
replaced or re-derived.

## KMS signer registry — what the system proves and does NOT prove

`signatureId -> address` control is verified against **`TATUM_KMS_SIGNER_REGISTRY`**:
a JSON array of entries whose `address` is what the documented, non-destructive
KMS CLI proof `tatum-kms getaddress <signatureId> <index>` prints on the ops
side (against the KMS wallet storage). `model` is `MNEMONIC_INDEXED` (index is
part of the identity) or `PRIVATE_KEY` (index must be absent).

**Honest proof statement:** this service performs a *registry consistency
check*, not a live cryptographic derivation. The cryptographic proof is produced
by `tatum-kms getaddress` against the KMS wallet storage; the application
verifies that ops recorded that proof and that it matches the configured
addresses. An xpub derivation is deliberately NOT used as evidence — an xpub
proves the mnemonic, not that a KMS signatureId controls the address. A missing
or non-matching registry entry is **fail-closed in LIVE mode**: preflight blocks
and `submitExecution` refuses before any provider call.

## Exact Tatum provider contract

- Token transfer: `POST /v3/blockchain/token/transaction` (the current
  fungible-token endpoint, schema `ChainTransferEthErc20KMS`):
  `{ chain: "MATIC", to, contractAddress, amount: <exact decimal string>,
  digits: 6, signatureId, index? }` — `index` only when the signature ID is
  mnemonic-based; `from` is NOT part of the provider request (Tatum derives the
  signer from the KMS identity) and no private-key material exists anywhere.
- Response semantics: a KMS-signed submission returns `{ signatureId }` where
  that `signatureId` is the **internal Tatum ID of the prepared pending
  transaction** (OpenAPI `SignatureId` schema) — persisted as
  `CustodyExecution.tatumPendingId`. There is **no txId in this response**; a
  blockchain hash exists only after the KMS daemon signs and broadcasts.
- Pending lifecycle (documented Tatum endpoints):
  `GET /v3/kms/pending/{chain}` (list), `GET /v3/kms/{id}` (detail — txId once
  signed), `PUT /v3/kms/{id}/{txId}` (complete with the REAL blockchain tx id),
  `DELETE /v3/kms/{id}` (cancel). There is no `/v3/kms/approve/{id}` endpoint.
- Amounts: `amount` in the provider request is the **decimal token quantity**
  as an exact string (`baseUnitsToDecimalString`; `100123456` base units ->
  `"100.123456"`). Base units are never sent as the quantity, and the quantity
  never passes through JS floating point.

## Four-eye principle (Tatum externalUrl validation contract)

Four-eye is **mandatory on MAINNET** (`TATUM_KMS_ENVIRONMENT=MAINNET` with
four-eye disabled blocks live execution entirely). The mechanism is Tatum's
documented external validation contract, NOT a Tatum REST approval call:

1. Before submission, the application records its durable exact-match approval
   (`approveKmsRequest`) — the *internal* authorization of the intended
   transfer.
2. The KMS daemon is started with `tatum-kms daemon --externalUrl=<our URL>`.
   When it fetches a pending transaction to sign, it performs a plain
   `HTTP GET <externalUrl>/api/internal/custody/kms/validate/<pendingId>`
   and signs **only on 2xx**.
3. The validator (`routes/kmsFourEyeRoutes.js` → `validateKmsPendingRequest`)
   returns 2xx only when the pending id maps to a durable execution that is
   APPROVED, not terminal, of an authorized kind, on the canonical network and
   native-USDC contract, with the exact authorized sender/recipient/amount and a
   registry-verified signer identity. Everything else (unknown, denied,
   mismatched, stale) is a non-2xx refusal, so KMS must not sign.
4. The endpoint is intentionally **not** behind normal admin authentication —
   the KMS daemon performs a bare GET and cannot present our JWT. Protection is
   the deployment topology (internal network/VPN) plus the optional
   `TATUM_KMS_VALIDATOR_ALLOWED_IPS`. It is read-only: it cannot approve
   anything, mutate money, or expose secrets.

## Submission single-winner (CAS) and crash semantics

`RESERVING/REQUESTED --conditional-update--> SUBMITTED` is an atomic
single-winner claim: only the process whose conditional update moved the row may
call the provider; a lost race converges on the existing execution and never
produces a second external submission. A crash after the claim leaves the row
`SUBMITTED` with no `tatumPendingId` — intentionally ambiguous: retries throw
`UNKNOWN_OUTCOME` and only reconciliation (which must determine whether Tatum
ever created a pending transaction, e.g. via `GET /v3/kms/pending/MATIC`) may
resolve it. No automatic resubmission ever happens.

## Settlement authority

`COMPLETED` is legal **only after verified chain evidence**. `settleExecution`
accepts a proof object only when it carries the internal verified-evidence brand
minted by `verifyChainTransfer` (the authoritative verification path — tx hash
shape, successful receipt, Polygon, native-USDC contract, ERC-20 Transfer
event, exact sender/recipient/base units); a bare object cannot forge it, and
without a valid proof `settleExecution` performs the same verification itself
and refuses to complete otherwise. A tx hash alone — even a well-formed one —
never settles an execution.

## Non-destructive preflight

`custodyExecutionService.preflight(prisma)` (also exposed to admins at
`GET /api/admin/custody/preflight[?walletAddressId=...]`) verifies:
missing API key, missing KMS signature ids, missing signer mode, signer/address
mismatch, wrong network/environment, unsupported token identity, missing
master-hot address, treasury/hot-wallet disagreement, and KMS-disabled-while-
live-requested. It broadcasts nothing and exposes no secrets.

## Canonical asset

Native Polygon USDC only: contract `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359`,
6 decimals. Bridged USDC.e (`0x2791bca1f2de4661ed88a30c99a7a9449aa84174`) is a
distinct asset and is never substituted. Authoritative amounts are **exact
integer base units** (`toBaseUnits`), never floats.

## Asynchronous execution lifecycle

```
REQUESTED → RESERVING → SUBMITTED → SIGNING → BROADCAST → CONFIRMING → COMPLETED
                └──────────── any in-flight state ────────────→ FAILED | RECONCILIATION_REQUIRED
```

KMS signing is asynchronous: the application submits an unsigned transfer, Tatum
holds the pending request, the KMS daemon signs locally and broadcasts, and
confirmation is observed separately. Therefore:

- An HTTP timeout is **NOT** "broadcast failed" → `RECONCILIATION_REQUIRED`.
- `PROVIDER_REJECTED` (4xx) is the only definitive synchronous failure and the
  only path that auto-refunds a customer withdrawal — atomically with the
  execution's FAILED transition (exactly-once).
- The tx hash only enters the record from real provider/chain evidence
  (`isValidTxHash`-validated), is unique in `CustodyExecution`, and settlement
  additionally verifies **transfer semantics** on chain (contract, sender,
  recipient, exact base units, successful receipt). A successful *unrelated*
  transaction never settles a withdrawal or sweep.
- `reconcilePendingExecutions` (called each sweep-worker tick) advances
  SIGNING/BROADCAST executions via real evidence. Settlement is idempotent.

## Testnet capability (NOT exercised by CI)

CI and the local suite run against **deterministic fake providers** — a mocked
green test does NOT mark the provider integration "real". To perform a genuine
testnet execution with KMS:

1. Create a Tatum testnet API key and a KMS wallet (generate a signatureId for
   the mnemonic HD wallet); run a Tatum KMS daemon against the testnet
   environment with four-eye approval enabled.
2. Configure: `TATUM_PROVIDER=LIVE`, `TATUM_API_KEY=<testnet key>`,
   `TATUM_KMS_ENABLED=true`, `TATUM_CRYPTO_EXECUTION_ENABLED=true`,
   `TATUM_KMS_SIGNATURE_ID=<deposit hd signatureId>`,
   `TATUM_KMS_ENVIRONMENT=TESTNET`, `TATUM_KMS_CHAIN=POLYGON`,
   `TATUM_HOT_WALLET_SIGNATURE_ID=<hot signatureId>`, `TATUM_HOT_WALLET_ADDRESS=<address>`,
   and a `TATUM_KMS_SIGNER_REGISTRY` whose entries come from
   `tatum-kms getaddress <signatureId> <index>` output run on the KMS host.
   Start the daemon with `--externalUrl` pointing at this service so the
   four-eye validator can gate signing.
3. Fund a deposit address with testnet USDC (native contract) and let the sweep
   worker run, or perform a customer withdrawal, then observe
   `CustodyExecution` progress REQUESTED → … → COMPLETED with a real tx hash and
   verified chain evidence.

No testnet secrets are committed to this repository.

## Scope boundary

This slice makes external custody execution REAL and KMS-capable while leaving
it disabled. The formal custody-account/movement accounting model
(CustodyAccount / CustodyMovement / inventory lots / Proof-of-Reserves
redesign) is deliberately deferred to §P.3, which will attach these execution
records to that model.
## r22 — Custody execution recovery + terminal convergence (2026-09-21)

Every economically meaningful `CustodyExecution` state now has an explicit,
durable recovery owner (exported as `STATE_MACHINE` in
`tatumCustodyExecutionService.js`). A crash between two durable steps can
never silently strand customer funds:

| State | Recovery owner | What it does |
|---|---|---|
| `RESERVING` (stale, PENDING/DENIED) | `custodyRecoveryService.recoverReservingExecutions` | no submission CAS was claimed → no provider I/O can have happened: FAILED + exactly-once refund (withdrawals) / FAILED (sweeps) |
| `RESERVING` (stale, APPROVED) | same | RE-ENTERS the canonical `submitExecution()` boundary on the durable identity — single-winner CAS means exactly one submission |
| `SUBMITTED` (crash-after-claim) | `custodyRecoveryService.recoverSubmittedExecutions` | resolves with Tatum's pending-KMS contract (`GET /v3/kms/pending/MATIC` → `{id, chain, hashes[], serializedTransaction, index?, txId?}`); binds ONLY on exact chain + KMS signature identity + decoded ERC-20 transfer semantics; NEVER a blind retry |
| `SUBMITTED` + pendingId | same | `GET /v3/kms/{id}` → converge to SIGNING or BROADCAST |
| `RECONCILIATION_REQUIRED` (UNKNOWN_OUTCOME) | `custodyRecoveryService.convergeReconciliationRequired` | recurring pending-scan: binds when evidence appears, stays quarantined while it does not |
| `RECONCILIATION_REQUIRED` (CHAIN_REVERTED) | same | definitive revert: FAILED + exactly-once refund, atomic; revert txHash preserved as evidence |
| `RECONCILIATION_REQUIRED` (CHAIN_MISMATCH / contradictory) | human | durable evidence on the row; the four-eye validator refuses to sign; no retry, no refund |
| `SIGNING` / `BROADCAST` | `reconcilePendingExecutions` (unchanged) | KMS poll → chain-receipt verification → branded-proof settlement |

**Honest limits, documented rather than guessed:**

- Absence from the KMS pending list does NOT prove no broadcast — completed
  pendings leave the list. A crash-after-claim with no admissible match is
  quarantined with evidence, never auto-refunded.
- A pending whose serialized payload does not decode is UNUSABLE evidence —
  never treated as a match or a mismatch.
- `realizedNetworkCostBaseUnits` is never fabricated from the estimate; the
  reverted-receipt gas (MATIC, paid by the hot wallet operator) is an operating
  cost (P1 follow-up recorded in the r22 report).

**Settlement convergence guards (`settleExecution`):** the linked
`TransactionHistory` completion is an exact-one CAS that atomically converges
the REAL chain tx hash into the customer-facing record; a missing or FAILED
linked record quarantines the settlement (COMPLETED-without-record divergence
is impossible). The `OnchainSweep` audit row is checked-CAS but audit-only — it
can never block the money path.

**Denial race hardening (`denyKmsRequest`):** cancel-first; a proven cancel
fails the execution from pre-broadcast states with the exactly-once refund; an
unprovable cancel quarantines; a denial after BROADCAST is recorded but cannot
un-broadcast — chain evidence remains the settlement authority.
`approveKmsRequest` refuses executions that already carry broadcast evidence.

**Cadence:** the dedicated `custodyRecoveryWorker` runs every 60s through the
existing BullMQ scheduler abstraction (distributed mode or Redis-off
single-instance fallback). Every recovery transition is a conditional
single-winner CAS; the refund paths share the controller's ledger idempotency
key family (`ledger:withdrawal:crypto:refund:<executionId>`), so duplicate
passes and concurrent workers converge on exactly one refund.

Ops tunables: `TATUM_CUSTODY_RESERVING_STALE_MINUTES` (default 10),
`TATUM_CUSTODY_SUBMITTED_GRACE_MINUTES` (default 2).

