# The GHS asset behind a USDC-funded shortfall conversion

**Scope:** `feature/native-ghs-withdrawal-leg` @ PR #392. Source-based accounting
investigation for issue #389 / Agent C's concern. **No ledger posting, counter,
account or policy was changed by this report.** It records what the code
currently asserts and the decisions only the owner can make.

## 1. The funding entry, as posted

`processNativeGhsWithdrawal` funds a shortfall by consuming a USDC→GHS quote and
posting one `ASSET_CONVERSION` (`conversion.identity =
withdrawal-ghs-funding:<reference>`):

| line | account | debit | credit |
|---|---|---|---|
| 1 | `user:<id>:liability` (USDC) | shortfall USDC | |
| 2 | `clearing:conversion` (USDC) | | shortfall USDC |
| 3 | `fiat:momo:ghs` (GHS **asset**, normal side DEBIT) | shortfall GHS | |
| 4 | `ghs:user:<id>:liability` (GHS) | | shortfall GHS |

Real rows from the test database (one conversion, shortfall GHS 30.00 at 12.50):

```
withdrawal-ghs-funding:GHST-2bb2d430…  user:358:liability        2.40000000  0
withdrawal-ghs-funding:GHST-2bb2d430…  clearing:conversion        0           2.40000000
withdrawal-ghs-funding:GHST-2bb2d430…  fiat:momo:ghs             30.00000000  0
withdrawal-ghs-funding:GHST-2bb2d430…  ghs:user:358:liability     0          30.00000000
```

## 2. What the postings say happened

- **`fiat:momo:ghs` rises by the full shortfall.** Because it is a debit-normal
  ASSET, line 3 asserts the platform *now holds 30.00 GHS it did not hold
  before*. Aggregate across the database: `fiat:momo:ghs` debits 6,984,739.00
  against credits 521,880.03.
- **The customer's GHS liability rises by the same amount** (line 4), so the
  balance sheet stays balanced: an asset was created and a liability was
  created beside it.
- **The USDC side does not settle.** `clearing:conversion` is credited 349.60
  against 72.00 debited and never receives a §P.5 fiat settlement entry, so the
  conversion leaves a clearing balance that represents "USDC handed over,
  GHS received" — which is the very claim under review.

## 3. Is there a GHS inflow?

**No.** Nothing in the acceptance path posts or observes an external GHS
acquisition: no provider receipt, no treasury transfer, no independently
evidenced fiat inflow. The only GHS-side evidence in the transaction is the
quote (a price and an amount), which is a *pricing* fact, not a *settlement*
fact. The customer's GHS wallet genuinely receives spendable GHS, and the
platform's ledger genuinely records an asset to back it — but that asset is
created by assertion, not by an inflow.

P5-D is *not* automatically inflated by this: `FiatLiquidityState` keeps its own
`availableGhs` / `reservedGhs` counters (currently 99,900.00 / 100.00 in the
test database) and reservations move between them independently of the ledger
asset balance. So the shortfall does not mint P5-D spendable liquidity. The
defect is narrower and still real: **the ledger overstates GHS assets held.**

## 4. The payout posting, and what the reversal changes

Acceptance debits `ghs:user:<id>:liability` and credits `fiat:momo:ghs` for the
full payout (the same pattern as `debitNativeGhs`). Payout therefore *reduces*
the asset it just created, which is the correct direction if the GHS genuinely
existed. On a definitive failure the reversal now (as of `c39924f`) posts the
exact inverse under `withdrawal-ghs-funding-reversal:<reference>`, restoring
USDC and removing the shortfall from both the GHS liability and the projection.

Net effect on `fiat:momo:ghs` across a completed payout is therefore zero, and
across a funded-then-reversed payout also zero. The overstatement only exists
**while a funded payout is in flight, or permanently if a funded payout is
never reversed and never paid** — and it exists in full for every funded payout
that settles successfully, because the GHS that left `fiat:momo:ghs` was never
independently acquired.

## 5. Alternatives, with balanced entries

**(A) The platform really buys GHS — acquisition.** If a treasury/market-making
desk supplies the GHS and is owed the USDC, the entry must carry a supplier leg:

```
DR fiat:momo:ghs                30.00 GHS
CR ghs:supplier:payable         30.00 GHS      (or the USDC payable it settles)
DR user:<id>:liability          2.40 USDC
CR clearing:conversion          2.40 USDC
```
Here line 3 is legitimate because a real GHS inflow happened; the liability to
the supplier is the evidence. Requires a treasury policy, a supplier identity
and a settlement process that do not exist today.

**(B) The GHS is already ours — reallocation.** If treasury GHS already sits in
the fiat pool, the conversion creates no asset; only its *earmarking* changes:

```
DR ghs:treasury:allocated       30.00 GHS
CR ghs:user:<id>:liability      30.00 GHS
DR user:<id>:liability          2.40 USDC
CR clearing:conversion          2.40 USDC
```
`fiat:momo:ghs` is untouched, so the total GHS asset stops growing at
conversion time. This is the cheapest correct option **if** the pool actually
holds the GHS, which nothing in the ledger currently demonstrates: the asset
balance is a single pooled figure with no separation between GHS received from
customers and GHS the platform owns.

**(C) Disclose instead of post.** If neither (A) nor (B) is true, the shortfall
is a liability the platform cannot back, and the honest treatment is to state
that: keep the liability, and record the asset gap explicitly rather than
inflating `fiat:momo:ghs`. This needs an owner decision; it is not implementable
by guessing.

## 6. What is still needed

1. **A decision: (A), (B) or (C).** Each requires a treasury/settlement fact the
   code cannot supply on its own.
2. **A GHS custody source of truth.** Today `fiat:momo:ghs` mixes customer
   deposits and platform conversions in one pooled asset balance.
3. **Settlement evidence for `clearing:conversion`** — it accrues and never
   settles, so the USDC leg of every conversion is provisional.

Until one of these is decided, the shortfall feature **must not be described as
accounting-ready**. Its customer-facing arithmetic is exact and reversible; its
asset-side provenance is not established.
