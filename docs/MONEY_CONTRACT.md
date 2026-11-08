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

## 2. GHS is the currency of record

Ghana-facing prices, invoices, orders, tabs, payment requests, fees and the
primary customer experience are stated, read and settled in **GHS**. In those
places the GHS figure is the authoritative figure: it is the amount quoted, the
amount charged and the amount owed. No GHS price is silently restated as a USDC
price, and no Ghana-facing total is presented first in USDC.

There is **no single universal settlement asset behind the ledger**. Each
customer liability settles in its own unit on its own rail (§10):

- the **GHS** liability settles through a GHS mobile-money or bank float, and
- the **USDC** liability settles through USDC custody.

`nativeGhsBalance` is therefore not a shadow of `availableBalance`, and
`availableBalance` is not the "real" balance that GHS merely displays. They are
two liabilities in two units, and the only bridge between them is an explicit,
priced, consented quote (§3, §6), never a display rate and never a silent
reinterpretation of one balance as the other.

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
- **Secondary line:** `usdcEquivalent`, the USDC equivalent of that **same
  headline**, computed with the **same** canonical display rate:
  `usdcEquivalent = headlineGhs / displayRate`. The field keeps its established
  response name. The secondary line and the headline must never be derived from
  different rates, and `usdcEquivalent` is not a re-statement of
  `availableUsdc`.
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
- A **JSON number** remains accepted for existing clients (the shipped Flutter
  vendor dashboard posts a double). The implemented guard is deliberately
  **conservative and conditional**, and this section describes it exactly:
  - a **whole-number** value is accepted at any magnitude the range check
    below allows, because integers stay exactly representable as doubles far
    past this point (up to `2^53`);
  - a **fractional** value is accepted when its magnitude is **below `2^25`
    (33,554,432 USDC)**;
  - a **fractional** value at or above `2^25` is refused with
    `USDC_AMOUNT_STRING_REQUIRED` **before** any `Decimal` is constructed and
    before any financial mutation.
- **Why `2^25`, stated correctly:** for magnitudes in `[2^25, 2^26)` the
  distance between adjacent doubles is `2^-26 ≈ 1.49e-8`, which is **wider than
  one 8-dp step (`1e-8`)**. In that band an 8-dp amount is not necessarily
  representable at all, so `JSON.parse` may hand the handler a neighbouring
  value: `100000000.00000002` arrives as `100000000.00000001`. The digit is
  lost before any handler runs and cannot be recovered by stringifying the
  surviving number, which is why such input is refused rather than converted.
- **This is not `Number.isSafeInteger(value × 10^8)`.** That test is not the
  implemented guard: a product can look integral in floating point while the
  input was already rounded, so the guard keys off the input's own magnitude
  and its integrality, and refuses the ambiguous band outright.
- A non-finite number is refused (`USDC_AMOUNT_INVALID`).
- The same exact `Decimal` value is used for the balance guard, the debit, the
  credit, the ledger posting and the history row. No stage re-parses, rounds or
  re-derives the amount.
- Scale: more than 8 decimal places is refused (`USDC_AMOUNT_PRECISION`)
  rather than rounded. Range: values at or above 10^12 are refused
  (`USDC_AMOUNT_OUT_OF_RANGE`). Zero and negative values are refused
  (`USDC_AMOUNT_INVALID`), and a missing amount is `USDC_AMOUNT_REQUIRED`.

## 6. Settlement precision

GHS payouts settle at **2 decimal places, ROUND_HALF_UP**, from an exact
decimal product. The provider receives a 2-dp decimal **string**. This is an
internal rounding correction, not a provider contract change: the provider's
API is unchanged.

## 7. Authority

- Activation of the fiat-liquidity authority regime remains gated and
  fail-closed. Nothing in this document authorizes activation, a production
  migration, a flag change, or a real-money action.

## 8. Fees and margins

Fees are exact money. A fee is computed, stored and charged as an exact decimal
in the currency it is charged in, and the debit a customer sees is the exact
sum of its parts.

**Platform fees on trades.** `services/feeProfileService.js` resolves the active
`AdminFeeProfile` for a trade context (`ALL`, `VENDOR_TIER`,
`INFLUENCER_REFERRAL`, `HOLIDAY`, `CUSTOM`), highest `priority` first, and falls
back to the priority-`0` system default. It returns `platformFeePct`,
`adminSplitPct`, `vendorSplitPct` and `exitFeePct` together with `profileId`
and `profileName`.

- `matchedProfile` is the **only** reliable signal that a real profile applied.
  A matched profile may legitimately carry `0` in any percentage field, so a
  zero is never read as "no profile" and a `profileId` string is never read as
  "profile applied".
- Fees and splits are derived from the same exact base amount the trade moves;
  they are not recomputed from a previously rounded figure.

**Native-GHS payout fees.** A payout's fee is part of the customer's debit, so
it must be known exactly *before* the debit is taken:

- MoMo payouts: `GHS_NATIVE_FEE_POLICY` (`ZERO_FEE_V1`), `feeGhs = '0.00'`: the current
  Moolre MoMo contract charges no payout fee, so the recipient receives
  exactly `amountGhs`.
- Bank payouts: `BANK_PAYOUT_FEE_GHS`, parsed as an exact `Decimal`. An
  **absent** value and a **non-zero** value both fail closed, with different
  codes so nobody "fixes" a policy gap by zeroing the number they were asked to
  check: `BANK_FEE_POLICY_UNEVIDENCED` (no fee has been agreed, so the exact
  amount the recipient receives cannot be promised) and
  `BANK_FEE_POLICY_UNAPPROVED` (a non-zero fee is configured but the refund
  policy for it is not approved. A failed payout is
  reversed for the recipient amount only, so charging a fee the reversal does
  not return would leave the customer short exactly when they can least afford
  it). Both refuse with `503` and **nothing is debited**.
- `totalDebitGhs = recipientGhs + feeGhs`, both exact `Decimal`s at 2 dp. A
  quote that cannot state the exact debit is not minted;
  `POST /api/withdraw/bank/quote` refuses rather than estimating, and the
  payout route `POST /api/withdraw/bank` re-derives the same policy before it
  debits anything.

**Margins.** There is no implicit margin in this system. A spread is never
taken by quietly moving the rate a customer is quoted: the FX rate is the
canonical market rate (§3), and any revenue on a conversion is an explicit,
configured fee that appears as its own line. A rate that "includes margin"
would make the quote un-auditable against the market and is out of scope by
design.

## 9. Authentication layers

Every money route passes a layered gate series, and the order is part of the
contract because a check that runs after a claim cannot un-spend a claim.

1. **Authentication**: `protect` verifies a valid JWT and identifies the
   caller. Identity is taken from the token, never from the request body.
2. **Account state**: `protectActive` (ban guard) keeps a banned or restricted
   account read-only where that is allowed and unable to move money.
3. **Authorization**: role, permission and scope checks (`adminOnly`,
   `requireEffectivePermission`, `adminAccess`, `adminBusinessScope`,
   `platformAccess`). A permission is evaluated server-side on every request;
   the client hides controls for usability, not as a security boundary.
4. **Step-up**: `require2FA` on the sensitive money routes. It is enforced
   **before** the idempotency claim, so a request that fails 2FA cannot consume
   a key or leave a claim behind (pinned by
   `__tests__/native-ghs-withdrawal.test.js`).
5. **Policy gates**: business-scope gates (`kybGate` on business-facing writes
   such as ad posts and dine-in tabs) and `requireFreshFxRate` on FX-dependent
   money routes. Each fails closed with a typed refusal (`503` for a missing
   fresh rate) **before** any claim, debit or provider call.
6. **Abuse controls**: rate limiting (`financialLimiter`, mounted on
   `/api/wallet`, `/api/withdraw`, `/api/trades` and `/api/bank-beneficiaries`
   in `src/routes/index.js`) and `accountLockout`, both ahead of the handler.
7. **Idempotency claim**: `idempotency({ failurePolicy, releaseOn4xx })`
   claims the key, and the claim is committed inside the same transaction as
   the money movement. A releasing mount with no anchored, transaction-guarded
   proof fails the build (§11, `src/idempotency/releaseEvidence.js`).
8. **The operation transaction**: the only place balances move.

A layer may be stricter than these defaults; none may be removed. Authentication
answers *who*, authorization answers *may they*, step-up answers *can they
prove it right now*, policy gates answer *is this transaction allowed today*,
and idempotency answers *has this exact request already happened*.

## 10. Providers and settlement

Each liability settles on its real rail, through the service that actually
implements it. There is no notional single settlement asset.

| Liability / flow | Rail | Implementation |
| --- | --- | --- |
| GHS in (collection) | Moolre mobile money | `services/moolreCollectionService.js` |
| GHS out (MoMo payout) | Moolre disbursement | `services/moolreDisbursementService.js` |
| GHS out (bank payout) | Moolre bank payout | `services/moolreBankPayoutService.js` (#391 adapter contract) |
| GHS out (legacy dispatch) | configured fiat provider | `workers/payoutBatchWorker.js` |
| GHS ledger | `fiat:momo:ghs` provider float against `ghs:user:{id}:liability` | `src/services/nativeGhsWithdrawalService.js`, `services/ledgerService.js` |
| USDC out (custody / chain) | USDC custody and on-chain dispatch | `controllers/walletController.js`, withdrawal rails |
| USDC ledger | `user:{id}:liability` | `services/ledgerService.js` |

**Provider amounts.** The amount that crosses the provider boundary is an exact
2-dp decimal **string** (§6). The string is what is sent, what is stored, what
the mock ledger records and what a provider echo is normalised back into; a
provider response is wrapped in `Decimal` before it is compared or recorded.
`amountGhsValue` is the explicitly named numeric presentation projection and is
never authoritative.

**Provider status.** Moolre reports a numeric `txstatus` (`0` pending, `1`
success, `2` failed) and a separate envelope `status`; the mapping to
`PENDING | SUCCESSFUL | FAILED` is explicit and never inferred from truthiness.
A polled amount is normalised through `Decimal` before it is returned.

**Ownership and evidence.** A dispatch that has reached a provider is owned
durably (`services/payoutProviderOwnership.js`) and progresses
`RESERVED → IN_TRANSIT` atomically, so a retry cannot double-dispatch and a
crash cannot orphan a live transfer. Provider attempts are recorded
(`services/providerSettlementAttemptService.js`) and outbound settlement
evidence binds the reference, amount and status to the attempt that produced it.

**Settlement modes.** Model-B settlement and native-GHS settlement are separate
flags, both default **false**, and neither is enabled by this contract.

## 11. Rollout and safety

- **Every financial switch defaults off.** `autoPayoutEnabled`,
  `fiatLiquidityAuthorityEnabled`, `modelBSettlementEnabled`,
  `nativeGhsSettlementEnabled` and `nativeGhsWithdrawalEnabled` are all
  `@default(false)`, in the schema, in the migrations and in the overlay
  installers, and every reader fails closed. No seed, installer or migration
  writes a flag to `true`.
- **Schema changes are additive and idempotent.** Overlay installers use
  `IF NOT EXISTS` / drop-then-add and are run in a fixed order by the single
  `release` script; a re-provisioned database and a migrated one converge. The
  `nativeGhsSettlementEnabled` column is `NOT NULL DEFAULT false` and its
  migration is a no-op on re-application.
- **Fail closed, never guess.** No usable rate → FX-dependent routes `503`
  (`PARTIAL_FX_UNAVAILABLE` on reads). No approved fee policy → the payout
  rail refuses `503` with nothing debited. No authority latch → the GHS payout
  refuses rather than falling back to a USDC-denominated pool that cannot
  denominate it.
- **CI is the gate, not a formality.** The `financial-durability` lane runs
  against PostgreSQL in production commit mode and enforces the database
  identity guard; the main battery runs the full suite, the route registry, the
  production dependency audit, schema push plus every installer, and the
  backup/restore drill. A route that declares a releasing idempotency policy
  without anchored, transaction-guarded evidence fails the build.
- **Nothing here is activation.** This document authorizes no production
  migration, no flag change, no deployment and no real-money action.

## 12. Non-goals

Explicitly **not** decided, implemented or implied here:

- **The authority-latch redesign.** No table, trigger or migration is added
  for it; the design is unapproved and the current behaviour stays fail-closed.
- **Business export streaming.** The export route's row and size ceiling is a
  streaming-design task. No row cap and no silent truncation is added by this
  contract.
- **Renaming the balance read model's emitted fields.** `GET /api/users/balance`
  still emits its established primitives (`nativeGhsAvailable`,
  `availableUsdc`, `displayRate`, `usdcEquivalent`) and reports a missing rate
  as `FX_UNAVAILABLE`. The combined headline composes exactly from those
  primitives, so aligning the emitted names (`headlineGhs`,
  `headlineIsEstimate`, `PARTIAL_FX_UNAVAILABLE`) is a follow-up with its own
  tests, not a silent redefinition.
- **A consolidated single-currency view of customer money.** The two
  liabilities are never summed into one authoritative balance, and
  `usdcEquivalent` is never treated as a holding.
- **Rewriting stored balances on a rate change.** Revaluation is display only.
- **AZM points as money.** Loyalty points are excluded from every monetary
  total and are never redeemable against a liability by this contract.
- **Provider contract changes.** The 2-dp settlement precision correction is
  internal; no provider API, credential or endpoint changes as a result, and
  no provider fee or spread is introduced.
- **Activating anything.** No production migration, no flag activation, no
  deployment, no secret change, no real-money operation.

## 13. Change control

This document is normative for money surfaces. A change to it is a change to
behaviour and must land with:

1. the code change it describes (or an explicit "documentation only" note),
2. regression tests that fail without the change,
3. the exact head SHA and the CI runs that exercised it, and
4. a reviewable diff that does not silently redefine an established field name.

Where an implementation is narrower or wider than a general statement here, the
narrower, more conservative behaviour is the real contract and must be written
down in the section that governs it (§5 is the worked example: the implemented
guard is a conservative magnitude cutoff, not a per-value representability
test).
