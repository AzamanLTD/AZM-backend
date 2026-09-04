# Azaman Currency & Settlement Contract

This document records the current production invariant for the Ghana launch.

## Currency roles

- **USDC** is the authoritative financial and settlement unit of account.
- **GHS** is the Ghana-local presentation/fiat payout equivalent.
- GHS values shown in clients are derived from the server-authoritative oracle snapshot.
- A displayed GHS value must never be accepted as the authoritative ledger amount.
- The Flutter app and Business Portal should consume `/api/oracle/rates` for the same current USDC→GHS presentation rate.

## Oracle

`GET /api/oracle/rates` returns a canonical snapshot with:

- `pair = USDC/GHS`
- `settlementCurrency = USDC`
- `displayCurrency = GHS`
- `liveRetailRate` = current user-facing GHS per USDC
- `rateSource` = provider used for the current snapshot
- `lastSync` = last successful server oracle sync
- `refreshIntervalSeconds = 600`

Kotani Pay is preferred when configured. When Kotani is unavailable, the fallback USD/GHS quote is combined with the current USDC/USD market price rather than assuming USDC is exactly one dollar.

## Fiat withdrawal lifecycle

1. The customer requests a GHS payout amount derived from the current USDC/GHS rate.
2. Inside a single database transaction, the platform atomically reserves the required GHS liquidity from `SystemFiatPool` and debits the customer's USDC balance by the withdrawal amount plus applicable USDC fee.
3. The customer's `TransactionHistory` record is created as `PENDING`.
4. The controller dispatches the GHS payout through the configured MoMo settlement rail.
5. Only provider-confirmed success may transition the canonical transaction to a settled/completed state.
6. A provider failure may reverse only a still-`PENDING` reservation. A late failure callback must not claw back a payout already marked `COMPLETED`.

## Idempotency and concurrency

- Fiat pool reservation is conditional on sufficient balance in the same transaction as the customer debit.
- Customer USDC debit is conditional on sufficient available balance in the same transaction.
- Duplicate crypto deposit webhooks are fenced by `TransactionHistory.txHash` inside the transaction, with the database unique constraint as the final race fence.
- Existing legacy `USD_GHS` rate-alert records remain triggerable; newly created alerts use `USDC_GHS`.

## Legacy multi-currency wallets

The `/api/multi-currency` subsystem remains a compatibility surface for older wallet functionality. It is not the authoritative USDC ledger. Its conversion transactions must remain isolated from the canonical USDC/GHS settlement path.
