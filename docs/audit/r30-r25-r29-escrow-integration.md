# r25 + r29 Escrow/Lifecycle Integration

Date: 2026-09-22
Scope: reintegrate PR #297 financial concurrency authority onto the r29 reservation lifecycle now on `main`.

## Combined authority model

Funding and reservation terminal operations serialize on the linked `SmartEscrow` row. Booking funding must win `DRAFT -> FUNDED` before any debit, then it must authoritatively establish one of two reservation facts while that escrow claim is held:

- linked `PENDING -> CONFIRMED`, or
- the same linked reservation is already `CONFIRMED`.

A missing, mismatched, cancelled, no-show, checked-in, checked-out, or otherwise incompatible reservation raises `RESERVATION_FUNDING_CONFLICT`. The entire transaction rolls back, including escrow state, balance claims, fee routing, ledger posting, history, and confirmation.

The r29 lifecycle keeps its transaction-aware refund, release, and split-release primitives. Cancellation, check-in, and no-show also claim the escrow before changing reservation state. Therefore funding and terminal lifecycle decisions have one shared serialization boundary.

## r25 financial protections retained

- `escrowService.fundEscrow` uses exact Prisma Decimal quantities.
- Funding is an authoritative `DRAFT -> FUNDED` CAS.
- Available balance is a conditional `>= total` decrement.
- Ledger identity is `ledger:escrow:fund:<escrowId>`.
- A replayed ledger posting aborts the operation.
- Booking funding applies the same state, balance, and replay protections.
- Post-commit notifications remain non-authoritative.

## Cross-lane proofs

`__tests__/r30-r25-r29-funding-lifecycle-integration.test.js` races real PostgreSQL transactions for:

1. booking funding vs customer cancellation,
2. booking funding vs business check-in,
3. booking funding vs no-show economics, and
4. stale funding against a pre-existing terminal reservation.

The proofs reject contradictory durable combinations, cap every ledger/history identity at one, prevent negative locked balances, and verify terminal state cannot be overwritten by stale funding confirmation.

## Local verification on the combined tree

- Focused r25/r29/r30 and booking-integrity gate: 5 suites, 50 tests.
- Cross-lane race suite: 4 tests, five consecutive additional PostgreSQL runs.
- Full battery: 279 suites, 2,419 tests.
- Financial durability (`synchronous_commit=on` before and after): 34 suites, 353 tests.
- Route registry against authoritative `AZM-businessPortal`: PASS, 293 frontend calls matched.
- Prisma validation: PASS.
- Production dependency audit: 0 vulnerabilities.
- Logical backup/restore recovery drill: SUCCESS.
