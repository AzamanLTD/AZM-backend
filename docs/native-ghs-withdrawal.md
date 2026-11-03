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

## Compatibility

Legacy USDC-denominated fiat/crypto/MoMo withdrawals are untouched: with the flag OFF these
routes are byte-identical, and no old `TransactionHistory`/`Withdrawal` row is rewritten. A
separate cutover contract is still required before any USDC-denominated caller is migrated.
