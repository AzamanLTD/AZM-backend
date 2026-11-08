# Native-GHS withdrawal leg and BANK payouts (issue #389, Agent A)

Status: implemented behind `GlobalSettings.nativeGhsWithdrawalEnabled` (default **OFF**).
Nothing here activates until the owner rules; no merge/deploy/production action is taken by this branch.

## Two genuine customer liabilities

| | Native GHS | USDC |
|---|---|---|
| Field | `User.nativeGhsBalance` | `User.availableBalance` |
| Denomination | GHS, exact 2dp (pesewa) | USDC, exact 8dp |
| Ledger liability | `ghs:user:{id}:liability` (GHS) | `user:{id}:liability` (USDC) |
| Settlement asset | `fiat:momo:ghs` (provider GHS float) | custody / provider USDC |
| Headline | native GHS only | shown as its own balance |

Neither balance is ever reinterpreted as the other. A GHS payout debits GHS; it never reads
`availableBalance`. A USDC quote is only used when the customer explicitly funds a GHS
shortfall.

## No FX for a GHS-only payout

`POST /api/withdraw/ghs` carries **no** fresh-FX gate. The amount is the payout: `amountGhs`
is parsed exact-to-pesewa (`GHS_AMOUNT_PRECISION` on over-precision, `0.00` refused — the
dust guard analog of #380). The only place a rate appears is an explicit, consented
USDC→GHS shortfall conversion.

## Funding plan and shortfall formula

`ghsFundingPlanner.planGhsPayoutFunding({ amountGhs, feeGhs, availableNativeGhs })`:

```
requiredGhs   = amountGhs + feeGhs            (fee policy v1: ZERO, itemised explicitly)
shortfallGhs  = max(0, requiredGhs - availableNativeGhs)
mode          = shortfallGhs === 0 ? GHS_ONLY : QUOTE_REQUIRED
```

`QUOTE_REQUIRED` never mutates. The executable quote is minted through the ONE canonical quote
authority (`purpose: 'withdrawal'`, inside the existing CHECK constraint) with an opaque
`quoteIdentity` token; it is fresh-rate gated, owner-scoped, expiring and **one-time**.
On execution the quote is consumed inside the money transaction and the USDC debit is the
quote's own 12dp quotient rounded **once** to the 8dp ledger authority.

Display rate vs executable quote: a saved/demo rate is display-only and can never open the gate
or price a conversion.

## Economic leg (one transaction)

1. *(optional, consented)* `ASSET_CONVERSION` funding of exactly the shortfall:
   USDC `D user:{id}:liability / C clearing:conversion`, GHS `D fiat:momo:ghs / C ghs:user:{id}:liability`
   + projection increment, all in the same transaction.
2. Native GHS debit of the full payout through the existing wallet authority (CAS floor):
   `D ghs:user:{id}:liability / C fiat:momo:ghs`.
3. Canonical `TransactionHistory` (`WITHDRAWAL_FIAT`, `amountUsdc = 0`, `amountGhs`, `settlementCurrency = GHS_NATIVE`)
   and the `Withdrawal` reconciliation mirror (`amountGhs`, `settlementCurrency`, `payoutMethod`).
4. P5-D liquidity claim `fiatLiquidity.reserveForPayout` on the exact GHS — one atomic
   reservation boundary, no second float. The P5-D authority is **required**: the legacy
   `SystemFiatPool` is a USDC scalar and cannot denominate a GHS payout (fail-closed).
5. `FinancialOperation` claim committed inside the same transaction; the 202 body is the
   deterministic accepted fact set, true before any provider I/O.

## Dispatch, failure and reconciliation

- Dispatch claim is the canonical single-winner `Withdrawal PENDING → DISPATCHING` (the same
  competitor as admin reject and the worker claim), then `initiateTransfer({ amountGhs })`
  with the exact GHS — the provider identity comes from dispatch facts, never a guess.
- Provider rejection with no accepted bytes: once-only reversal (raw jsonb CAS stamp) re-credits
  the exact GHS, re-credits any funded USDC, releases the reservation, and marks both rows FAILED.
- Unknown/post-dispatch outcomes stay held and reconcile against the original reference.
- `reconcileNativeGhsWithdrawals` flags a GHS-native row missing its ledger posting or
  reservation as a reconciliation exception **without** mutating balances.

## BANK payouts and saved beneficiaries

`POST /api/withdraw/bank` takes an explicit typed **BANK** destination (`beneficiaryId`) — the
rail is never inferred. The provider call is delegated to the injected `moolreBankPayoutPort`
(Agent B's adapter, owned elsewhere and not edited here). When that port is not bound the route
refuses `503 BANK_PAYOUT_CAPABILITY_UNAVAILABLE` with **zero mutation**. Everything else —
operation identity, 2FA, funding/quote, reservation, state machine, reversal, reconciliation —
is the same authority as the MoMo leg; it is not a second withdrawal engine.

Saved beneficiaries (`/api/bank-beneficiaries`) store the account number only as a versioned
AES-256-GCM envelope (`enc:v1:`, `keyId` per row for rotation) plus an HMAC-SHA256 fingerprint
under a **distinct** key (`BANK_BENEFICIARY_HMAC_KEY`). Uniqueness and lookup use the
fingerprint; ciphertext is never a lookup key. API shapes are masked-tail only and plaintext is
never returned, logged or persisted. Decryption happens only at the payout boundary for the
owner's own row.

## Headline contract (resolved, not deferred)

The valuation question raised during inventory — #369's consolidated headline versus Planning #78's
native-GHS-only headline — is **decided and already implemented upstream** in this branch's base:
`src/services/balanceValuationService.js` (commit `9909fe2`, "ghs headline is the native balance only")
and `controllers/profileController.js` build the headline from `nativeGhsAvailable` only.

`usdcEquivalent` is the *estimate of that GHS headline in USDC* — display only. It is never added to the
headline, never a second balance, and a missing or stale rate leaves the headline valid while the estimate
goes `null` (`FX_UNAVAILABLE`). Regression: `__tests__/balance-valuation.test.js` (11/11 on this head),
which asserts that a rate change moves only the estimate and never the headline.

This branch adds no competing headline logic; the payout leg simply spends the same native-GHS balance the
headline already reflects.

## Compatibility

Legacy USDC-denominated fiat/crypto/MoMo withdrawals are untouched: with the flag OFF these
routes are byte-identical, and no old `TransactionHistory`/`Withdrawal` row is rewritten. A
separate cutover contract is still required before any USDC-denominated caller is migrated.

## GHS settlement precision and the rounding correction

GHS payouts settle at **2 decimal places, ROUND_HALF_UP**, computed from an
exact decimal product of the USDC amount and the canonical rate. The provider
receives that figure as a 2-dp decimal **string**; nothing on the outbound path
round-trips it through a JavaScript number.

This is an internal rounding correction, not a provider contract change. The
provider API, its amount field and its units are untouched; only the arithmetic
that produces the figure changed. Before the correction the product was rounded
as a binary double, which under-paid a pesewa on verified pairs:

| USDC | Rate (GHS/USDC) | Exact | Previously paid |
| --- | --- | --- | --- |
| 0.35 | 12.3 | 4.31 | 4.30 |
| 0.15 | 12.3 | 1.85 | 1.84 |
| 0.02 | 12.25 | 0.25 | 0.24 |
| 0.30 | 12.35 | 3.71 | 3.70 |
| 0.42 | 12.25 | 5.15 | 5.14 |

Every money comparison that decides whether a payout is dispatched or held
(withdrawal amount, auto-approve maximum, operational pool threshold, legacy
pool balance and remaining pool after a dispatch) is made in `Prisma.Decimal`,
so a configured limit is never crossed by binary rounding.
