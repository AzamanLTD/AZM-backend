# Azaman Money Contract

**Status:** normative. Owner decision D1 resolved 2026-11-08.
**Supersedes:** the headline and balance-valuation rules in
[`CURRENCY_AND_SETTLEMENT_CONTRACT.md`](./CURRENCY_AND_SETTLEMENT_CONTRACT.md)
and the headline section of [`native-ghs-fx-audit.md`](./native-ghs-fx-audit.md).
Where those documents disagree with this one, this one governs.

This contract states what a customer is owed, what a screen may claim, and
where an estimate stops being money.

## 1. Two real liabilities

The GHS wallet and the USDC wallet are **two separate real customer
liabilities**, held and settled in their own units.

- `nativeGhsAvailable` is a stored GHS balance. It is a liability in GHS.
- `availableUsdc` is a stored USDC balance. It is a liability in USDC.

Neither is a view of the other. No stored balance is ever rewritten because a
rate changed, and no presentation layer may collapse the two into one
authoritative figure. Every movement still debits and credits one asset and
one asset only.

## 2. GHS-first experience

Ghana-facing prices, balances and the primary customer experience are
**GHS-first**: the number a customer reads first, and the number a price is
stated in, is GHS. USDC remains the settlement asset behind the ledger; being
GHS-first on screen does not make GHS the unit of account.

## 3. Balance headline — selected mode `COMBINED_ESTIMATE`

Two modes are supported. **`COMBINED_ESTIMATE` is the selected mode.**

| Mode | Front face | Status |
| --- | --- | --- |
| `COMBINED_ESTIMATE` | combined available-value estimate in GHS | **selected** |
| `NATIVE_ONLY` | native GHS available, alone | supported alternative, not selected |

The selected mode behaves as follows.

- **Front headline:**
  `headlineGhs = nativeGhsAvailable + availableUsdc × displayRate`.
  It is one GHS figure describing the customer's total available value.
- **Secondary line:** the USDC equivalent of that **same headline**, computed
  with the **same** canonical display rate:
  `headlineUsdc = headlineGhs / displayRate`. The secondary line and the
  headline must never be derived from different rates, and the secondary line
  is not a re-statement of `availableUsdc`.
- **Estimate marker:** `headlineIsEstimate` is true **whenever available USDC
  is non-zero**, because only then does an indicative rate contribute to the
  number. With `availableUsdc = 0` the headline is exactly the stored native
  GHS balance and is **not** marked as an estimate. A headline is never marked
  as an estimate merely because the mode is `COMBINED_ESTIMATE`.
- **Back of the card:** the actual `nativeGhsAvailable` and `availableUsdc`
  holdings, each in its own unit, plus savings, escrow, disputes and every
  other locked breakdown **in its own unit**. The back face is where the two
  liabilities are shown separately; the front face is the only place they are
  combined.
- **Locked funds are excluded from the front-face available headline.**
  Savings, escrow, dispute and pending buckets contribute nothing to
  `headlineGhs`. They are reported on the back face only.
- **A display-rate change changes valuation and nothing else.** No ledger
  entry, transaction, balance, notification, limit, or eligibility decision
  may depend on the display rate. Rate movement is not a financial event.
- **No usable display rate:** the headline falls back to
  `nativeGhsAvailable` **only**, and the response reports
  **`PARTIAL_FX_UNAVAILABLE`**. The USDC contribution is never invented, never
  estimated from a stale or demo rate, and never silently set to zero in a way
  that reads as "your USDC is worth nothing".
- **`spendableGhsNow` excludes the indicative GHS valuation of USDC.**
  `spendableGhsNow` is the amount a customer can spend in GHS right now, so it
  is the native GHS available figure (minus anything locked). Valuing USDC at
  an indicative rate does **not** make it spendable GHS: spending the USDC
  portion requires a **separately priced, confirmed quote** whose rate is
  locked for that transaction. An estimate is not a quote, and a headline is
  not a balance.

### 3.1 What a client must not do

- Must not present `headlineGhs` as a spendable or withdrawable amount.
- Must not present the combined estimate without the estimate marker when
  `availableUsdc > 0`.
- Must not compute the headline from a rate other than the canonical display
  rate returned alongside it.
- Must not fall back to a saved or demo rate to keep a combined headline
  alive. A missing rate degrades to native GHS with
  `PARTIAL_FX_UNAVAILABLE`; it never degrades to a fabricated number.

## 4. Money representations

- Decimal strings are the authoritative representation of money on the wire
  and in the database. `NUMERIC` columns are exact; a JSON number is not.
- A JSON number carries double precision. It cannot represent every 8-dp USDC
  value, and precision lost during JSON parsing cannot be recovered by
  converting the result to a string. Amounts that need more precision than a
  double can hold **must** be sent as decimal strings, and the API must refuse
  rather than round (see §5).
- Responses expose `{ exact, value }`: `exact` is the decimal string, `value`
  is a presentation projection.

## 5. USDC amount input on `POST /api/wallet/internal-transfer`

- A **decimal string** is the authoritative input and is parsed exactly.
- A **JSON number** remains accepted for existing clients, but only when the
  value is exactly representable at 8 decimal places
  (`Number.isSafeInteger(value × 10^8)`). Otherwise the request is refused
  with `USDC_AMOUNT_STRING_REQUIRED` and no financial mutation occurs.
- The same exact `Decimal` value is used for the balance guard, the debit, the
  credit, the ledger posting and the history row. No stage re-parses, rounds or
  re-derives the amount.
- Scale: more than 8 decimal places is refused (`USDC_AMOUNT_PRECISION`)
  rather than rounded. Range: values at or above 10^12 are refused
  (`USDC_AMOUNT_OUT_OF_RANGE`).

## 6. Settlement precision

GHS payouts settle at **2 decimal places, ROUND_HALF_UP**, from an exact
decimal product. The provider receives a 2-dp decimal **string**. This is an
internal rounding correction, not a provider contract change: the provider's
API is unchanged.

## 7. Authority

- Activation of the fiat-liquidity authority regime remains gated and
  fail-closed. Nothing in this document authorizes activation, a production
  migration, a flag change, or a real-money action.
