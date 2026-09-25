# r41 — DB-Boundary Authority Final Audit

Round r41 closed the final-audit findings on escrow terminal states, business-OS
finance, and the AZM economy. All fixes merged via PR #308 (merge commit
`e4be740`). This document records what was proven and the exact proof-count
math, so any "N/N green" claim is reproducible from repository evidence.

## Proof suites

| Suite | Kind | Top-level tests (at PR #308) |
|---|---|---|
| `__tests__/r41-escrow-terminal-authority.pg.test.js` | real PostgreSQL | 8 |
| `__tests__/r41-business-os-authority.pg.test.js` | real PostgreSQL | 15 |
| `__tests__/r41-azm-economy-authority.pg.test.js` | real PostgreSQL | 14 |
| `__tests__/r41-payout-parking-authority.unit.test.js` | unit (mocked tx) | 6 |
| `__tests__/r40-restock-fingerprint-v2.pg.test.js` | real PostgreSQL | 4 |
| `__tests__/r40-restock-intent-authority.pg.test.js` | real PostgreSQL | 18 |

## The exact "65/65" calculation

The PR #308 gate run was a SINGLE serial focused run of the six suites above.
Jest reported `Test Suites: 6 passed, Tests: 65 passed`:

```
r41-escrow-terminal-authority     8
r41-business-os-authority        15
r41-azm-economy-authority        14
r41-payout-parking-authority     6
                                  -- (r41 subtotal: 43 top-level tests)
r40-restock-fingerprint-v2        4
r40-restock-intent-authority    18
                                  -- (r40 restock neighbors: 22)
TOTAL                            65
```

"65/65" therefore means: **65 top-level test cases across the 6-suite focused
gate (all four r41 suites plus the two r40 restock suites re-run as neighbors in
the same serial gate), all passing.** It does NOT mean 65 distinct r41 test
cases — the r41 suites themselves contained 43 top-level tests at PR #308 time.
Stress rounds inside a test (loops that repeat an interleave) count as ONE
top-level Jest test each, and were never counted individually.

Reproduce: run the six suites serially against a disposable PostgreSQL
(`TEST_DATABASE_URL`), e.g.
`npx jest --runInBand --forceExit "__tests__/r41-escrow-terminal-authority.pg.test.js" "__tests__/r41-business-os-authority.pg.test.js" "__tests__/r41-azm-economy-authority.pg.test.js" "__tests__/r41-payout-parking-authority.unit.test.js" "__tests__/r40-restock-fingerprint-v2.pg.test.js" "__tests__/r40-restock-intent-authority.pg.test.js"`
and compare `Tests: N passed` against the per-suite counts above.

## Audit follow-up (post-#308, this branch)

1. **Durability lane.** The three PG-backed r41 suites were added to the
   explicit suite list in `.github/workflows/financial-durability.yml`
   (production `synchronous_commit=on` rehearsal). The payout-parking suite is
   unit-only (mocked tx) and stays in the main battery lane.
2. **Transit lock order.** `cancelTransitBooking` previously claimed the
   TransitBooking row first and only touched the escrow afterwards, while the
   no-show sweep, escrow funding, split-release, and business no-show all take
   the escrow row FIRST then the booking — an AB-BA deadlock pair. Cancellation
   now (a) re-reads the escrow link inside the transaction (the stale pre-read
   could be a null escrowId and strand a funded escrow on a CANCELLED booking)
   and (b) takes the escrow row lock FIRST via `SELECT ... FOR UPDATE`, making
   every competing lifecycle operation serialize through the same escrow
   authority. No deadlock catching; the cycle is structurally impossible now.
   Proofs C8/C9/C10 drive the real service paths through gated interleaves in
   both directions plus an un-gated repeated race: exactly one lifecycle
   winner, exactly one refund, honest reporting on both sides.
3. **Auction stale-writer proofs.** B1 now constructs the deterministic
   window-closes-under-a-parked-bid interleave via lock-queue ordering (closer
   queues first, the real `placeBid` second): the parked bid wakes to committed
   truth and fails closed; settlement then owns the row; AZM burned exactly
   once. B3 proves the real `withdrawBid` path in both interleavings (window
   closes mid-flight → fail closed; settlement commits while the withdraw is
   parked → converges to the next window) — the WON/LOST settlement audit rows
   can never be deleted; no direct `deleteMany` fallback in the proof.
4. **Invoice B2.** Converted from a sequential send→void into a real gated
   row-lock interleave: the send queues first, the void second with a stale
   DRAFT pre-read; the void's claim re-evaluates against the committed SENT
   row. DRAFT→SENT, DRAFT|SENT→VOIDED, PAID-never-voided, duplicate
   convergence, and ownership invariants are covered by B1–B5.

## Invariant summary (all proven on real PostgreSQL)

- Escrow terminal states are single-authority: no stale writer can resurrect
  REFUNDED/RELEASED/EXPIRED.
- Transit no-show/cancellation: exactly one lifecycle winner, no double refund,
  no stale NO_SHOW over a committed cancellation (and vice versa), dispute
  custody untouched, DRAFT escrow expires, economics atomic with the booking
  transition, any economic failure rolls back the whole transition.
- Auctions: settlement owns the authoritative auction row; stale bids fail
  closed against committed truth; WON/LOST audit rows are never rewritten or
  deleted; AZM never burned or refunded twice.
- Invoices: DRAFT→SENT only; DRAFT|SENT→VOIDED only; PAID can never be
  overwritten; duplicate same-target operations converge; ownership enforced.

## Follow-up 2 (PR #309, review batch 2) — transit funding authority + observed-gate determinism

### The fund-after-cancellation race (economic authority gap)

`fundBookingEscrow` previously confirmed the TRANSIT booking with a best-effort
tail `updateMany({ where: { id, status: 'PENDING' } })` that never failed on a
terminal booking. Interleaving:

1. a cancellation acquires the escrow lock first and commits
   `TransitBooking=CANCELLED` while the escrow stays DRAFT (NO_FUNDS — no money
   moved);
2. the previously queued funding acquires the escrow and claims DRAFT→FUNDED;
3. it debits the payer, locks the principal, posts ledger/fees/history;
4. its tail `PENDING→CONFIRMED` matches zero rows (the booking is CANCELLED);
5. the funding transaction still COMMITS — a stranded-funds FUNDED escrow on a
   CANCELLED booking.

### Fix — escrow-linked booking is authoritative inside the funding transaction

- `fundBookingEscrow` (TRANSIT + bookingId) now calls
  `_claimTransitBookingForFundingTx` immediately after the escrow claim,
  BEFORE any economic mutation: the escrow-LINKED booking is re-read inside the
  transaction; the caller-supplied bookingId must match the linkage; PENDING is
  confirmed atomically in the same transaction; CONFIRMED/IN_PROGRESS converge
  without rewriting; CANCELLED/NO_SHOW/COMPLETED and mismatched linkage raise
  `TRANSIT_FUNDING_CONFLICT` and roll back the escrow claim with the whole
  transaction. The escrow-first → booking lock order is preserved.
- `createBookingEscrow` (TRANSIT) now links only into the legal pre-terminal
  set `PENDING|CONFIRMED|IN_PROGRESS` (previously `{ id, escrowId: null }`), so
  a create/link racing a cancellation can never attach a fresh fundable escrow
  to a terminal booking. The IN_PROGRESS test/setup contract is preserved.

### New proofs — `__tests__/r41-transit-funding-cancellation-authority.pg.test.js`

- **A** cancel-vs-fund, cancellation wins: funding wakes to committed CANCELLED
  truth, fails closed, escrow claim rolls back, zero economic side effects
  (balance, ledger, history, fees untouched).
- **B** cancel-vs-fund, funding wins: funding confirms PENDING and commits
  economics; the queued cancellation then wins the legitimate second step —
  CANCELLED + REFUNDED, exactly one debit and one refund.
- **C1/C2** create/link-vs-cancel, both interleavings: the losing create rolls
  back the whole ticket+escrow aggregate (no orphans); the leftover DRAFT
  escrow on a terminal booking is UNFUNDABLE.
- **D1–D3** linkage mismatch, CONFIRMED/IN_PROGRESS convergence, atomic
  PENDING confirmation.

### Observed-gate determinism (no sleep-established queue positions)

All gated race proofs (new suite plus C8/C9, invoice B2, auction B1/B3) now
synchronize on OBSERVED PostgreSQL lock state: a `waitForBlocked` helper polls
`pg_stat_activity` (`wait_event_type='Lock'`, query-text needle) until the
expected blocking relationship exists before releasing each gate. Timers are
bounded safety timeouts only — no sleep establishes a queue position. Pool
sizes in the proof clients were raised (`connection_limit=16`) so gated
interleaves cannot starve before reaching the database.

## Follow-up 3 (PR #309, third-pass review) — linkage-pinned claims close the create/link READ COMMITTED races

### The create/link-vs-cancel reverse race (READ COMMITTED, EvalPlanQual)

The second-pass fix pinned the funding path but left the booking CAS predicates
linkage-blind. Concrete interleave:

1. `createBookingEscrow` (TRANSIT) creates ticket + DRAFT escrow and holds the
   booking row with its uncommitted `escrowId` link;
2. a cancellation's in-transaction link read observes `escrowId = null`
   (the link is not committed), takes NO escrow lock, and its booking CAS
   queues behind the create's link UPDATE;
3. the create/link COMMITS (`escrowId = E`, still PENDING);
4. PostgreSQL legally re-evaluates the blocked CAS's WHERE against the NEW
   committed row version — `status` still matches, so the old status-only
   predicate WON the booking while the cancellation carried a stale
   JavaScript `escrowId = null`;
5. CANCELLED booking with a silently unreported, still-attached escrow.

The no-show sweep had the same linkage-blind booking claim (a stale-null read
could strand a FUNDED escrow on a NO_SHOW booking when funding committed
in the window), plus a rollback defect: a claim loss AFTER this transaction's
escrow economics was a `return { action: 'CLAIM_LOST' }` — which COMMITS the
refund/split/expire without the NO_SHOW transition.

### The structural fix — the pinned linkage is part of the CAS identity

- **Cancellation** (`cancelTransitBooking`): the pinned `escrowId` (from the
  in-transaction link read) is part of the booking CAS predicate
  (`{ id, status in CANCELLABLE, escrowId: pinned }`). Under EvalPlanQual
  re-evaluation a raced link (null → E) FAILS the predicate. On a
  linkage-raced loss the claim holds NOTHING (a failed re-evaluation releases
  the row; the pinned-null variant never took an escrow lock), so a bounded
  re-pin loop re-reads the link, locks the escrow FIRST, and claims again.
  Because linkage is strictly one-way (the create/link path requires
  `escrowId: null`), the CAS WINNER's pinned escrowId is provably the FINAL
  linkage. Escrow-first lock order preserved; deadlock-free by construction:
  while the escrow row is held, no competing lifecycle writer can hold the
  booking row (they all need the escrow first).
- **No-show sweep** (`sweepNoShowTransitBookings`): the same linkage-pinned
  claim (`escrowId: pinnedEscrowId` in the NO_SHOW CAS). A linkage-raced loss
  (only reachable from a pinned-null read, which executes no economics)
  reports `RETRY_LINKAGE` and the per-booking loop reprocesses once through
  the fresh escrow-first authority. A non-linkage claim loss AFTER escrow
  economics now THROWS (`SWEEP_CLAIM_LOST_ROLLED_BACK`) so the whole
  transaction rolls back — the racing actor (check-in, cancellation,
  completion) owns the booking and its escrow truth; the rolled-back sweep
  reports the same honest `CLAIM_LOST` no-op, not a phantom error.

### Proofs — `r41-transit-funding-cancellation-authority.pg.test.js`

- **C2a** (new) — the exact READ COMMITTED interleave: the gate holds the
  booking row; the REAL create/link parks at its link UPDATE (observed, count
  1); the REAL cancellation queues at position 2 with its stale null link
  read (observed, count 2); the gate releases, the link commits, the parked
  CAS wakes and re-evaluates. Verified to FAIL against the un-pinned (buggy)
  CAS: the cancellation's re-pin loop loses the first claim on the raced
  linkage, re-pins escrow-first, wins the booking, and honestly resolves the
  raced DRAFT escrow (NO_FUNDS). Asserts terminal state, final linkage,
  unfundability of the DRAFT escrow (real funding fails
  `TRANSIT_FUNDING_CONFLICT`), zero economics (balances, ledger, history),
  exactly one non-orphan ticket, no orphan escrows.
- **C2b** (new) — the legitimate create-first interleave through concurrent
  service calls: the REAL create/link is gated mid-transaction at its link
  UPDATE and then commits; a REAL cancellation and REAL funding then race
  concurrently on the linked escrow (observed escrow-lock queue, cancel at
  position 1, funding at position 2). The cancellation wins the escrow-first
  authority (CANCELLED + NO_FUNDS); the funding wakes to committed terminal
  truth and fails closed with zero economics.
- C1 (cancel-wins-first whole-aggregate rollback) unchanged and green.

### Durability lane

`r41-transit-funding-cancellation-authority.pg.test.js` is now in the explicit
financial-durability suite list (production commit mode
`synchronous_commit=on`, guarded before and after the run) alongside the other
three r41 PG suites. It appears exactly once in the workflow; the main battery
runs it via its normal pattern — no duplication, no semantic change to the
existing suite list.
