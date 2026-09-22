# r29 Reservation Lifecycle Economic Authority

Date: 2026-09-22
Scope: reservation confirmation, cancellation, check-in, check-out, no-show, escrow custody, and races.

## Authority model

`services/reservationLifecycleService.js` is the single transactional boundary
for the lifecycle facts that carry state or economic authority:

- business confirmation: `PENDING -> CONFIRMED` through an atomic tenant-scoped CAS
- customer cancellation: `PENDING|CONFIRMED -> CANCELLED_CUSTOMER`
- business check-in: `CONFIRMED -> CHECKED_IN`
- business/worker no-show: overdue, unchecked-in `CONFIRMED -> NO_SHOW`
- business check-out: `CHECKED_IN -> CHECKED_OUT` through an atomic CAS

Every funded terminal path claims escrow custody first and the reservation state second
inside one PostgreSQL transaction. All three operations use that same order.
A losing state CAS aborts the escrow claim, balances, ledger posting, and
TransactionHistory together. No caller may commit status first and settle later.

## Economics

| Operation | Escrow state | Outcome |
|---|---|---|
| cancellation | FUNDED/IN_PROGRESS/PENDING_SETTLEMENT | full principal refund; escrow REFUNDED |
| check-in | FUNDED/IN_PROGRESS/PENDING_SETTLEMENT | full principal to business; escrow SETTLED |
| no-show, configured penalty | FUNDED/IN_PROGRESS/PENDING_SETTLEMENT | canonical capped penalty/refund split; escrow RELEASED |
| no-show, no penalty | FUNDED/IN_PROGRESS/PENDING_SETTLEMENT | full principal refund; escrow REFUNDED |
| any terminal operation | no escrow | legitimate state-only transition |
| any terminal operation | DRAFT | DRAFT becomes EXPIRED in the same transaction, preventing later funding |
| cancellation/no-show | already REFUNDED or EXPIRED | state convergence without a second money mutation |
| check-in | already SETTLED or EXPIRED | state convergence without a second money mutation |
| any operation | DISPUTED/ADMIN_REVIEW | no mutation; funds remain in dispute custody and caller receives a distinct conflict |
| incompatible finalized economy | SETTLED/RELEASED/REFUNDED as applicable | fail closed; no stale status rewrite |

The existing `cancellationPolicy` field is descriptive text and has no executable
fee/penalty semantics anywhere in the live reservation implementation. r29 does
not invent a cancellation charge. It therefore preserves the existing canonical
`refundBookingEscrow` full-principal cancellation contract.

## Entry points unified

- `reservationController.confirmReservation`
- `reservationController.cancelReservation`
- `reservationController.checkInReservation`
- `reservationController.markNoShowReservation`
- `reservationController.checkOutReservation`
- `qrCheckInService.verifyAndCheckIn`
- marketplace direct check-in compatibility path
- `reservationNoShowWorker.sweepNoShowReservations`

QR and direct compatibility paths now propagate settlement failures instead of
logging them and returning false success. The no-show worker now also processes
unescrowed overdue reservations and no-penalty funded reservations through the
same authority.

## Additional defect found

`fundBookingEscrow` performed a post-commit Reservation lookup with invalid
Prisma fields (`user` and `reservationTime`). Funding had already committed,
but the lookup threw and returned an apparent failure. It now uses the real
`customer` relation and `startDatetime`. Terminal reservations are also barred
from acquiring a new DRAFT escrow.

## Intentional lifecycle boundaries

- Manual and worker NO_SHOW both require `endDatetime < now` and no prior check-in. The same predicate is repeated in the terminal CAS, so a concurrent reschedule cannot trigger premature economics.
- Confirmation is a tenant-scoped `PENDING -> CONFIRMED` CAS. A stale business request cannot resurrect a cancelled or otherwise advanced reservation, and only the CAS winner emits `reservation.confirmed`.
- NO_SHOW competes with check-in from CONFIRMED. A CHECKED_IN reservation cannot
  later be rewritten to NO_SHOW. This matches the worker's business fact and
  makes check-in-vs-no-show a single-winner race.
- CHECKED_OUT remains a non-financial transition from CHECKED_IN. Its escrow was
  already SETTLED atomically at check-in, so no second economic mutation belongs
  there.
- Walk-in creation starts directly in CHECKED_IN with no booking escrow. It is a
  front-desk sale flow, not a transition of a pre-funded reservation, and remains
  intentionally outside the competing lifecycle claim.
- Trust-score updates remain post-commit and non-authoritative. Their failure
  cannot alter or misreport the committed escrow lifecycle result.

## Proofs

`__tests__/r29-reservation-lifecycle-authority.test.js` contains 29 real
PostgreSQL proofs covering exact balances, escrow terminal states, exactly-once
ledger/history, retries, injected history/ledger rollback, tenant boundaries,
QR convergence, disputed custody, terminal escrow linkage, and these races:

- cancellation vs cancellation
- check-in vs check-in
- cancellation vs no-show
- check-in vs no-show
- no-show vs no-show
- confirmation vs cancellation
- confirmation vs escrow creation/funding
- confirmation vs confirmation

It also proves premature owner NO_SHOW rejection with zero state/economic mutation,
post-window owner penalty/refund behavior exactly once, later worker eligibility after
an early rejection, stale confirmation rejection, and cross-business zero mutation.

The suite is included in `.github/workflows/financial-durability.yml`, where it
runs with `synchronous_commit=on`.
