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

## Settlement scale and rounding (authority: `services/settlementScale.js`)

Cross-border and shared-vault money paths settle at explicit, currency-appropriate scales:

- **USDC (the base/settlement unit) settles at 8 decimal places** — the scale of every `Decimal(20, 8)` ledger column (`User.availableBalance`, `SusuContribution.amountUsdc`, `CrossBorderFxSnapshot.*`, wallet balances).
- **Fiat wallet currencies (GHS, NGN, KES, USD, EUR, GBP, ZAR) settle at minor-unit precision (2 decimal places).** Scale is chosen per currency symbol; it is never assumed uniform.
- **Rounding mode is `ROUND_HALF_UP`**, chosen explicitly as the terminal settlement mode. No other rounding mode may appear on a cross-border money path.
- **Computed conversions are quantized exactly once, at the settlement boundary** — the fee-adjusted rate first settles to the rate column's own scale (8 dp, so the persisted snapshot rate is bit-for-bit the rate applied), then the conversion product settles at the destination currency's scale. The SAME settled Decimal is then what the database row persists, the wallet moves, the ledger posts and the API response serializes. Nothing downstream recomputes or re-rounds.
- **User-supplied amounts are never silently rounded.** A request carrying more precision than the currency's settlement scale (e.g. `10.000000001` GHS, `0.000000001` USDC) is refused with `400 AMOUNT_PRECISION_EXCEEDED` — the caller is told the amount cannot settle rather than discovering a rounded debit post-hoc. Only computed amounts are rounded, once.
- **Amounts beyond the `Decimal(20, 8)` storage envelope** (13+ integer digits, e.g. `1e409`) are refused at parse time with `400 INVALID_AMOUNT`, never at the database write.
- **Wire representation is fixed decimal notation** (`toWireString`) — `0.00000001`, never `1e-8`. Exact decimal strings are authoritative on every money response.
- **Threshold comparisons on money are exact-Decimal** (the shared-vault completion flip compares `Decimal(20, 8)` values directly; two balances that differ can be the SAME JS double).

The cross-border Susu contribution/payout legs and the shared-vault deposit/completion/cancel-refund legs are the mounted implementations of this contract; `__tests__/settlement-scale.test.js` pins the policy and `__tests__/payout-cancel-single-winner.test.js` pins the mounted behavior (awkward-amount regressions: 17-significant-digit rates, 8-dp deposits, exact-threshold completion, dust payouts, 20-significant-digit refunds).
