# Transaction Continuation Contract (Backend F)

**PR:** AzamanLTD/AZM-backend — `feat/transaction-continuation`
**Base:** current `main` (`0edefa1`) — independent of #367–#369 and #370–#374.

## Audit result (committed before any endpoint was built)

Every payment rail was inventoried for session-interruption recovery:

| Flow | Persisted recoverable state | Re-observation before this PR |
|---|---|---|
| Moolre MoMo fiat deposit (`POST /api/quotes`) | atomic `TransactionHistory` PENDING row + quote + full metadata (amounts, rate, quote expiry, payer, provider rails) | only by scanning the broad history list |
| OTP deposit confirm (`POST /api/deposit/fiat/initiate/moolre/otp`) | same transaction row, status transitions server-side | same |
| Crypto / webhook deposits (`POST /api/deposit/webhook/tatum`, `/api/finance/webhook/deposit`) | provider-driven status on the same ledger rows | history list |
| P2P trade / escrow lifecycle | trade state machine rows | trade endpoints (fully recoverable) |
| Manual + SmartRoute withdrawals | PENDING `TransactionHistory` rows | history list |
| Internal transfers | synchronous COMPLETED rows | history list |
| Provider settlement | Moolre webhooks, event-idempotent (`event:moolre-collection:<ref>`) | server-side only |

**Gap found:** the deposit rails exposed only mutations (initiate/OTP) and
webhooks — after the app died mid-deposit there was NO single,
ownership-checked way to re-observe that ONE in-flight transaction with
its continuation payload. The user's only route was inferring from the
broad ledger list, which never returns the payment-instruction metadata.

**No gap found:** trade/escrow, withdrawal and transfer flows are all
recoverable from their persisted state machines via existing endpoints;
the status enum (`PENDING | COMPLETED | FAILED | FROZEN_DISPUTE`) is
stable and additive changes were not needed. No intermediate state is
invented by this PR.

## New endpoint (the only code change)

### `GET /api/deposit/fiat/status/:transactionId` (Bearer required)

Idempotent, READ-ONLY re-observation of ONE fiat deposit. Never mutates
the transaction, quote, balances or provider state; never regenerates
quotes, references or rates — it returns ONLY persisted data.

| Case | Status | Body |
|---|---|---|
| Found (owner) | `200` | `{ success: true, transaction: { id, type, status, amountUsdc, createdAt, settledAt }, continuation: { provider, network, amountGhs, amountGhsExact, quoteId, quoteExpiresAt, rateAtInitiation, payerPhoneMasked, providerRef } }` |
| Unknown id / not owner / not a `DEPOSIT_FIAT` row | `404` | `{ success: false, message: "Not found." }` (no existence leak) |
| No token | `401` | protect response |

- `status` is the honest ledger enum value: `PENDING` (still payable /
  awaiting webhook), `COMPLETED` (settled; `settledAt` set), `FAILED`
  (provider-reported failure — start a new quote), `FROZEN_DISPUTE`
  (handled by the dispute flow, not this endpoint).
- `payerPhoneMasked` is `233****567`-style; raw MSISDNs are never
  returned (same masking convention as the deposit history).
- `settledAt` is null until `COMPLETED`.

## Payment-direction flow + payload taxonomy (documented for the frontend)

`TransactionHistory.type` (direction taxonomy, unchanged, stable):

- IN: `DEPOSIT_FIAT`, `DEPOSIT_CRYPTO`, `SUSU_PAYOUT`, `VAULT_RELEASE`, `TRADE_PAYOUT`
- OUT: `WITHDRAWAL_FIAT`, `WITHDRAWAL_CRYPTO`, `SUSU_CONTRIBUTION`, `VAULT_DEPOSIT`
- INTERNAL: `INTERNAL_TRANSFER`, `SMART_ROUTE_RUN`

`GET /api/finance/transactions` accepts `filter=IN|OUT|INTERNAL` and
`status=PENDING|COMPLETED|FAILED|FROZEN_DISPUTE` — the general
recovery-by-polling surface; this PR's endpoint is the single-transaction
complement for the deposit flow.

Continuation payload (`metadata` on deposit rows): `{ provider, network,
amountGhs, amountGhsExact, quoteId, quoteAmountUsdc,
quoteAmountUsdcExact, quoteExpiresAt, rateAtInitiation, rateSource,
rateAsOf, ratePair, settlementCurrency, displayCurrency, selectedRoute,
routeProviderRail, routePolicyVersion, payerPhone }` — documented as the
frontend's authority for rendering an interrupted deposit.

## Test authority

`__tests__/deposit-continuation.test.js` — 7/7 real-PostgreSQL tests over
the mounted route stack with canonical JWTs: pending re-observation with
full continuation payload, honest COMPLETED settlement, ownership 404
(indistinguishable from absence), scope-honest 404 on non-deposit rows,
401 boundary, read-only stability across repeated polls (row, metadata,
providerRef, balances unchanged), PII masking. Seed-scoped cleanup; no
global truncation.
