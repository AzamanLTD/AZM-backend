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
