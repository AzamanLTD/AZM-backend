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

## Existing trip-cancellation test coverage (brief item: tautology check)
Searched the full battery for any test exercising the trip-cancel route or the
transit NO_SHOW path. Result: **no pre-existing test touches either path.**
`transit-trip-crud.test.js` and `transitOpsService.business-scope.test.js`
have no cancel coverage; `phase2` asserts only that route files are mounted;
`penalty-policy-outcome.test.js` uses "trip cancelled" as a reason string
only. So there were no tautological tests to fix — the defect class shipped
because the route had **zero** test coverage, which is also why the
PrismaClientValidationError on every call was never caught. The two r27 suites
close that gap with real-PostgreSQL proofs.

---

## r28 / P0-C — legacy transit booking cancellation funnelled into one transactional authority

Review of PR #299 found a second P0 in the same transit financial surface.
Closed on the same branch; scope kept to the transit cancellation surface.

### Defects found and fixed
1. **PATCH /api/transit/bookings/:id/status handled CANCELLED as a bare status
   update.** It refunded nothing, released no seats, restored no capacity —
   a funded escrow stayed locked while the API reported success. The route now
   delegates CANCELLED to the canonical cancellation service and never mutates
   a booking to CANCELLED directly.
2. **cancelTransitBooking was a two-phase false-success pattern.** It cancelled
   the booking + freed seats in one transaction, then ran refundBookingEscrow
   AFTER the commit, catching and logging refund errors while still returning
   success:true. The refund (and seat/capacity work) now run in the SAME
   transaction as the booking claim; any refund/ledger failure rolls back the
   entire operation and the caller gets an honest error.
3. **Two contradictory cancellation contracts.** The controller's transition
   table admitted IN_PROGRESS -> CANCELLED while the service only cancelled
   PENDING/CONFIRMED. Unified: the authoritative cancellable set is
   PENDING | CONFIRMED. IN_PROGRESS rides resolve through completion or
   dispute, never cancellation.
4. **P0-B race: splitReleaseFundedEscrow's final transit booking update was
   unguarded.** A racing cancellation that won the booking's economic claim
   could be overwritten to NO_SHOW. The booking update is now a CAS on the
   authoritative no-show pre-state (CONFIRMED); if the claim loses, the WHOLE
   split rolls back (escrow restored, no penalty/refund, no ledger posting) and
   the cancellation's economics stand.
5. **TransitBookingExpiryWorker leaked capacity.** It deleted stale PENDING
   bookings' seat rows but never restored trip.availableSeats, permanently
   losing sellable capacity. The worker now funnels through the canonical
   service, which releases seats AND restores capacity atomically.

### Entry points now funnelling through the canonical core
- PATCH /api/transit/bookings/:id/status (status=CANCELLED)
- DELETE /api/marketplace/transit/bookings/:id (inherited the fix)
- TransitBookingExpiryWorker stale-PENDING sweep

### Recorded for the next audit lane (NOT touched here — scope discipline)
- services/businessOS/transitOpsService.js cancelTripWithRefund is DEAD CODE
  (no callers; the Business OS route uses the r27 cancelTripWithRefunds
  service). If it were ever routed it would PrismaClientValidationError on the
  non-existent CHECKED_IN booking status / transitTripId column, the same
  defect class r27 fixed. Recommend deleting it in the next Business OS
  authorization/state audit.
- The reservation branch of splitReleaseFundedEscrow keeps the same
  unguarded booking-update shape the transit branch had. The reservation
  no-show economic divergence is already recorded in this document; the
  reservation secondary lane owns it.

### Proofs
__tests__/r28-transit-legacy-cancellation.test.js — 13 real-PostgreSQL proofs
(C1-C13), 3 consecutive green runs --runInBand. Covers: customer/owner funded
cancellations, exact balance restore, exactly-once ledger/history, idempotent
re-cancel, injected-ledger-failure full rollback + clean retry, concurrent
cancel-vs-cancel, concurrent cancel-vs-no-show split convergence, both split
CAS-guard shapes, cross-business rejection, unified IN_PROGRESS contract,
disputed custody, already-finalized escrow, expiry-worker capacity restore.
