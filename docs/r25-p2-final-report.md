# r25 — Financial Concurrency Authority: Claim Before Money (P0) — Final Report

**Date:** 2026-09-22 · **Scope:** money-path claim discipline (audit + fix), the "six unguarded balance mutations" axis

## 1. Executive summary

The Claude review flagged six endpoints whose balance mutation was an
unconditional `decrement` guarded only by a prior read. One correction
matters: the production release chain installs `User_availableBalance_nonneg`
as a database CHECK, so a **negative availableBalance can never commit** — the
defect was never "negative balances"; it was that these endpoints relied on a
constraint violation after a stale read instead of making the balance claim
itself atomic and deterministic. r25 restructures every one of them so the
durable state claim (exact-lifecycle CAS on the row) and the exact-quantity
balance claim (conditional decrement) come BEFORE any economic mutation, and an
exact ledger replay observed inside a just-won claim is contradictory
evidence that aborts.

Writing the concurrency suite found **two additional P0s the static review
missed entirely** — both on `walletController.requestWithdrawal`, both broken
in production on main, both invisible to CI because no test had ever
exercised the controller (see §2 W1/W2).

- **Regression suites:**
  - `__tests__/r25-financial-concurrency-authority.test.js` — 9 proofs against real PostgreSQL, each racing two genuinely parallel operations (Promise.all) and asserting exact final quantities
  - `__tests__/r25-ledger-replay-refusal.unit.test.js` — 2 proofs (replay-in-claimed-operation aborts; non-replayed posting proceeds)
- **Stability:** the concurrency suite passed 4 consecutive full runs (race outcomes are deterministic by durable identity, not by timing luck)
- **Full gate:** see §5

## 2. Defects confirmed and repaired

| ID | Defect | Repair |
|---|---|---|
| D1 | `escrowService.fundEscrow` — funding claim and balance debit were separate non-atomic steps (double-fund window; thin-budget race relied on the post-hoc CHECK) | Exact-lifecycle CAS (DRAFT→FUNDED, same payer) claims the escrow FIRST; conditional `updateMany({ gte })` decrements; either loss rolls back everything. Proven: same-escrow race (exactly one winner, money once) and thin-budget two-escrow race (one winner, loser orphans nothing) |
| D1b | A ledger replay inside a just-claimed escrow fund was silently tolerated | `posting.replayed` inside a won claim throws `LEDGER_REPLAY_IN_CLAIMED_OPERATION` — a durable identity that already committed is never allowed to permit a second economic mutation |
| D2 | `bookingEscrowService.fundBookingEscrow` — same pattern as D1 on the booking rail | Same claim-first structure + replay refusal; same-escrow race proven (loser gets `ESCROW_ALREADY_FUNDED`, money exactly once) |
| D3 | `peerTransferController.fulfillTransferRequest` — balance check was a read-then-blind-decrement | Atomic conditional decrement; losing the claim throws INSUFFICIENT_FUNDS and rolls the PENDING→COMPLETED status claim back too — the request stays PENDING and is legitimately retryable. Proven: same-transfer race (one executes, one is the idempotent replay) and two-transfers-thin-budget race |
| D4 | `savingsController.deposit` — goal row read BEFORE the money transaction; streak/completion derived from a stale snapshot (two concurrent deposits both wrote streakCount=1 — a silently lost update) | `SELECT … FOR UPDATE` inside the transaction locks the goal row; every deposit-dependent value (streak, longest, missed, completion) derives from the locked authoritative row; balance claim is a conditional decrement. Proven: the lost-update regression (two concurrent deposits → streak 2, exact sums) and the thin-budget full-rollback race |
| D5 | `withdrawalController` crypto-withdrawal debit — same read-then-decrement pattern | Atomic conditional claim (INSUFFICIENT_BALANCE, full rollback) |
| D6 | `POST /api/chat/transfer` (legacy in-chat transfer) had a constructor bug: every live call 500-ed before reaching handler logic | Route unmounted, `chatTransferController.js` deleted; the canonical rail is the peer-transfer controller. Deposit-route/controller doc notes updated to match |
| W1 (P0, found BY the suite) | `walletController.js` module header was corrupted on main: an earlier automated edit had spliced the module requires INSIDE the opening doc comment, so `Prisma`, `logger`, `ledger`, `restrictedObligations` and `_exact` were all UNDEFINED at runtime — `requestWithdrawal` threw "Prisma is not defined" before responding, in production | Header repaired; second splice removed from `getPolygonDepositAddress`'s catch block |
| W2 (P0, found BY the suite) | `tx.withdrawal.create({ … platformFeeUsdc … })` — the Withdrawal model has no `platformFeeUsdc` column, so the create threw "Unknown argument" on EVERY request after the balance claim had already won: the endpoint never successfully created a single row | Invalid argument removed; the platform fee remains durably recorded in SystemProfitFees + AdminProfitLog (`crypto_pfee_*`) and the `equity:treasury` ledger line |

### The correction to the review, precisely

The CHECK constraint is a real invariant, and it stays — but it is a
**backstop, not the guard**. The pre-r25 code made the CHECK the arbiter of a
race: the loser of two racing debits died inside Prisma with an opaque 40P01-
class constraint failure, with whatever side effects had already run in the
transaction relying on rollback semantics nobody had proven. r25 makes the
claim itself the arbiter: the loser loses a single-row conditional update,
gets a typed error code, and the transaction rolls back deterministically.
The CHECK now never fires on these paths.

## 3. Honest limits (documented, not guessed)

- The concurrency suite proves two-racer interleavings on each path. Deeper
  fan-out (3+ racers) follows the same durable-identity argument and is not
  separately enumerated.
- The MOMO/Binance/TRC20 "Address Detective" classification logic in
  requestWithdrawal is untouched: a 10-digit phone number is classified
  BINANCE_ID by the existing rules. The tests pin the fee-shape they need
  (zero gas) rather than re-litigating the detective.
- Savings `FOR UPDATE` serializes concurrent deposits on one goal; a long
  chain of deposits on the SAME goal contends. That is the correct
  trade-off: correctness of the streak ledger over theoretical throughput.
- cryptoWithdrawal's claim is unit-covered in shape but not raced against
  real custody gates in this suite (custody races are r23's territory).

## 4. Concurrency suite coverage map

| § | Path | Race | Proven invariant |
|---|---|---|---|
| 1 | escrowService.fundEscrow | same escrow ×2 | exactly one winner; balances exact; one history row; one ESCROW_LOCK ledger posting |
| 2 | escrowService.fundEscrow | two escrows, one thin budget | one winner (INSUFFICIENT_BALANCE typed); loser orphans zero rows |
| 3 | bookingEscrowService.fundBookingEscrow | same escrow ×2 | ESCROW_ALREADY_FUNDED for the loser; money exactly once |
| 4 | peerTransferController.fulfill | same transfer ×2 | one executes; the other is the idempotent replay; money once |
| 5 | peerTransferController.fulfill | two transfers, one budget | one COMPLETED; loser stays PENDING (retryable); balances exact |
| 6 | walletController.requestWithdrawal | two withdrawals, one budget | exactly one Withdrawal row; balance exact; never negative |
| 7 | savingsController.deposit | same goal ×2 | streak 2 / exact sums — the lost update is impossible |
| 8 | savingsController.deposit | two deposits, one budget | full rollback: one deposit row, one history row, exact balances |
| 9 | routes/chatRoutes | static | /transfer unmounted; chatTransferController unresolvable |
