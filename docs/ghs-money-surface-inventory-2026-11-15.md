# AZAMAN money-surface inventory: what is native GHS and what is not

Generated from `prisma/schema.prisma` at the #405 branch head, by scanning every model
for Decimal money columns whose names imply USDC, plus any `currency` field and any
native GHS column. The point is to stop guessing which surfaces a GHS-only merchant
can use, and to order the remaining conversions by what actually serves them.

## The number that matters

- **39 models** carry USDC money columns.
- **1** has a `currency` column (BusinessOrder).
- **32** have neither a currency tag nor a native GHS field, so their amounts are
  *nominal USDC*: the column name is the only thing that says what the number means.

## Classification

### Native contract (1)

- `BusinessOrder`: 1 USDC field(s) [amountUsdc]; native GHS: amountGhs

### Native GHS, no currency tag (6)

- `GlobalSettings`: 3 USDC field(s) [liveUsdcToUsd, autoPayoutThresholdUsdc, autoPayoutMaxAmountUsdc]; native GHS: liveUsdToGhs
- `ModelBSettlement`: 3 USDC field(s) [quotedRateGhsPerUsdc, quotedUsdc, settledUsdc]; native GHS: quotedGhs, quotedRateGhsPerUsdc, settledGhs, costBasisGhsTotal, costAllocationResidualGhs, marginGhs, providerFeeGhs
- `TransactionHistory`: 2 USDC field(s) [amountUsdc, feeUsdc]; native GHS: amountGhs
- `User`: 2 USDC field(s) [totalVolumeUsdc, totalProfitUsdc]; native GHS: nativeGhsBalance
- `SavingsDeposit`: 1 USDC field(s) [amountUsdc]; native GHS: amountGhs
- `SmartRouteRun`: 1 USDC field(s) [amountUsdc]; native GHS: amountGhs

### Nominal USDC only (32)

- `BusinessInvoice`: 6 USDC field(s) [subtotalUsdc, taxTotalUsdc, tipUsdc, billTotalUsdc, feeUsdc, customerPaidUsdc]; native GHS: -
- `DineInTab`: 4 USDC field(s) [subtotalUsdc, taxTotalUsdc, tipUsdc, grandTotalUsdc]; native GHS: -
- `Reservation`: 4 USDC field(s) [amountUsdc, depositUsdc, noShowPenaltyUsdc, penaltyAmountUsdc]; native GHS: -
- `TransitBooking`: 4 USDC field(s) [amountUsdc, feeUsdc, noShowPenaltyUsdc, penaltyAmountUsdc]; native GHS: -
- `Vault`: 4 USDC field(s) [targetAmountUsdc, currentAmountUsdc, autoRuleAmountUsdc, yieldEarnedUsdc]; native GHS: -
- `DailySnapshot`: 2 USDC field(s) [totalProfitUsdc, totalVolumeUsdc]; native GHS: -
- `DeFiYieldStrategy`: 2 USDC field(s) [minAmountUsdc, maxAmountUsdc]; native GHS: -
- `DineInTabItem`: 2 USDC field(s) [unitPriceUsdc, lineTotalUsdc]; native GHS: -
- `HotelRoom`: 2 USDC field(s) [basePriceUsdc, weekendPriceUsdc]; native GHS: -
- `SharedVault`: 2 USDC field(s) [targetAmountUsdc, currentAmountUsdc]; native GHS: -
- `SmartEscrow`: 2 USDC field(s) [amountUsdc, feeUsdc]; native GHS: -
- `SmartRoute`: 2 USDC field(s) [amountUsdc, totalRoutedUsdc]; native GHS: -
- `AdminProfitLog`: 1 USDC field(s) [amountUsdc]; native GHS: -
- `AzmConversionLog`: 1 USDC field(s) [newUsdcBalance]; native GHS: -
- `BusinessProduct`: 1 USDC field(s) [priceUsdc]; native GHS: -
- `BusinessPromotion`: 1 USDC field(s) [minSpendUsdc]; native GHS: -
- `CargoParcel`: 1 USDC field(s) [priceUsdc]; native GHS: -
- `ColdStorageLog`: 1 USDC field(s) [amountUsdc]; native GHS: -
- `CurrencyConversion`: 1 USDC field(s) [feeUsdc]; native GHS: -
- `FraudAssessment`: 1 USDC field(s) [amountUsdc]; native GHS: -
- `HotelRateOverride`: 1 USDC field(s) [priceUsdc]; native GHS: -
- `OnchainSweep`: 1 USDC field(s) [amountUsdc]; native GHS: -
- `OperationalExpense`: 1 USDC field(s) [costUsdc]; native GHS: -
- `ProfitWithdrawalLog`: 1 USDC field(s) [amountUsdc]; native GHS: -
- `SharedVaultMember`: 1 USDC field(s) [contributedUsdc]; native GHS: -
- `SusuContribution`: 1 USDC field(s) [amountUsdc]; native GHS: -
- `SusuCycle`: 1 USDC field(s) [feeUsdc]; native GHS: -
- `SusuGroup`: 1 USDC field(s) [contributionUsdc]; native GHS: -
- `SusuMember`: 1 USDC field(s) [totalSeizedUsdc]; native GHS: -
- `TransitRouteTemplate`: 1 USDC field(s) [typicalFareUsdc]; native GHS: -
- `TransitTrip`: 1 USDC field(s) [fareUsdc]; native GHS: -
- `VaultDeposit`: 1 USDC field(s) [amountUsdc]; native GHS: -

## What this means for a merchant who never touches USDC

A GHS-only merchant is currently expressible in exactly three places: `BusinessOrder`
(the order currency contract), `BusinessPrice.amountExact`, and the native-GHS rows in
`TransactionHistory` / `SavingsDeposit` / `User.nativeGhsBalance` / `SmartRouteRun` /
`ModelBSettlement`. Every other money surface is USDC-nominal.

The sharpest present-tense defect is **dine-in cash**: a Ghana restaurant closing a cash
tab in cedis has those cedis written into `DineInTab.grandTotalUsdc` and then into
`BusinessInvoice.billTotalUsdc`, with no currency anywhere on either row. The amounts are
handled as exact Decimals and the close is idempotent with a durable fingerprint, so the
machinery is sound; what is missing is the currency. Nothing on that path can be fixed by
a display change, and changing it touches the exact-once cash-close contract, so it
deserves its own focused change rather than a slice of a larger one.

## Ordering (each step additive, none needing the previous to ship)

1. **DineInTab + BusinessInvoice currency contract** (class D, Ghana-primary, active
   mislabel): `currency` + native GHS columns, exact 2dp, the same mutual-exclusion rule
   as `BusinessOrder`, and the cash-close path recording cedis as cedis.
2. **SusuContribution** (class D, core cedi product): contributions are cedis in practice
   and `adminRbacController` reports them as a USDC total today.
3. **AdminProfitLog** (class D): platform fees cannot be recorded in GHS at all, so a GHS
   fee has no truthful home. Needed before any GHS fee rail goes live.
4. **Class B tidying**: money rows that already carry native GHS but no currency tag
   (`TransactionHistory`, `SavingsDeposit`, `SmartRouteRun`) need the tag so a reader
   never has to infer intent from which column is populated.
5. **Class D long tail** (vaults, transit, hotel, cargo, reservations): only worth doing
   when a Ghana merchant actually sells in that vertical.

## The constraint that applies to all of it

Production applies schema with `prisma db push`, which creates **no CHECK constraints**.
The mutual-exclusion rule therefore has to be enforced in the service layer, exactly as
`src/lib/businessOrderCurrency.js` does for orders: refuse sub-pesewa strings before
Postgres can coerce them, refuse a `number` instead of coercing it, and raise typed codes
for a row that carries both amounts or neither.
