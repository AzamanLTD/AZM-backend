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
| `TATUM_XPUB` | HD wallet xpub — used by the non-destructive signer/address preflight (`signatureId + index -> expected address`), which must equal the registry address |

The customer-deposit signer and the master-hot signer are **separately
configured identities**. A signer/address mismatch is a hard
`SIGNER_MISMATCH` failure; an existing customer address is never silently
replaced or re-derived.

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
   `TATUM_KMS_SIGNATURE_ID=<deposit hd signatureId>`, `TATUM_XPUB=<matching xpub>`,
   `TATUM_KMS_ENVIRONMENT=TESTNET`, `TATUM_KMS_CHAIN=POLYGON`,
   `TATUM_HOT_WALLET_SIGNATURE_ID=<hot signatureId>`, `TATUM_HOT_WALLET_ADDRESS=<address>`.
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
