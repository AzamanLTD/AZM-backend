# r27 Secondary Audit — Reservation Status Authority & Escrow Alignment

Date: 2026-09-22
Scope: reservationRoutes / reservationController analogs of the transit P0s.
Per the r27 brief: authority-model review + findings record only. **No code changes.**

## Findings

### F1. Authority model: CORRECT (no transit-style hole)
`markNoShowReservation` (controllers/reservationController.js, PATCH
`/api/reservations/:reservationId/no-show`) requires a business profile,
tenant-checks the reservation (`businessProfileId === profile.id`), and only
accepts CONFIRMED/CHECKED_IN → NO_SHOW. There is **no customer-settable
no-show path** on reservations. `checkOutReservation` follows the same
business-scoped pattern. The P0-B customer self-no-show hole is transit-only.

### F2. Economic divergence: business-initiated no-show does a bare flip
The reservation no-show worker (`workers/reservationNoShowWorker.sweepNoShowReservations`)
executes the canonical economics: past-due CONFIRMED reservations with a
funded escrow and configured penalty are charged via
`splitReleaseFundedEscrow` (penalty to business, remainder refunded, escrow
RELEASED). `markNoShowReservation` instead performs a plain status flip with
**no escrow resolution at all**:

- If the reservation has a FUNDED escrow and a configured penalty, a
  business-initiated no-show leaves the customer's principal locked in
  escrow, and the reservation leaves the worker's CONFIRMED candidate set —
  the same stranding pattern the transit trip-cancel route had (r27 P0-A),
  but for reservations.
- No penalty fields (`penaltyAmountUsdc`, `penaltyChargedAt`) are written, so
  the customer's money movement diverges from the worker's outcome for an
  identical business fact.

Recommended follow-up: route `markNoShowReservation` through the same
split/no-split branch the r27 transit fix applies (penalty configured + funded
claimable escrow → `splitReleaseFundedEscrow` with `bookingType: 'RESERVATION'`;
no penalty/no escrow → plain flip, mirroring the worker's no-penalty branch).
Not fixed here per the brief's scope instruction.

### F3. Checked-in state: consistent
Reservations legitimately model CHECKED_IN as a status (unlike transit, where
check-in is `checkedInAt` on a CONFIRMED booking), so reservation status
filters do not suffer the transit `CHECKED_IN` enum bug.

## Cross-lane observation (transit, fixed in this PR)
The old transit trip-cancel route's invalid `CHECKED_IN` enum filter plus a
non-existent `transitTripId` column made POST /api/business/transit/trips/:id/cancel
throw on every call (PrismaClientValidationError / P2022) while stranding any
funded escrows. Fixed in r27 via `services/transitTripCancellationService.js`.
