# r34 — Route Authority Sweep: Kiosk, Rooms, Restock (M1-7)

Round 34 hardening audit. Branch: same as PR #303 continuation wave.
Focus: module-load registration, mutation-boundary tenant predicates, kiosk
credential surface, room-status occupancy projection, restock posting unit.

## Verified defects (all fixed, real-PostgreSQL proofs)

1. **P0 — missing route registration.** The routes file exports
   `module.exports = Object.freeze({ router: express.Router() })` for status
   handling, but a sub-router was constructed and never mounted. The
   whole status-handler family silently never registered at module load.
   Registered properly; routes verified present via a route inventory test.

2. **P0 — dead-on-arrival finance/marketing surface (21 handlers).**
   21 handlers in `businessOSRoutes.js` referenced `svc` without declaring it
   (`ReferenceError: svc is not defined` on every call), and the
   `getServices(req)` bundle omitted the raw `prisma` client, so even with a
   declaration every `svc.prisma.*` consumer (recurring expense templates,
   promotions, reviews, 6 audit-logger call sites, the escrow-held list)
   crashed. Fixed by injecting `const svc = getServices(req)` at each handler
   and exposing `prisma` in the service bundle. Discovered by the r34 route
   sweep suite (E-failures surfaced as 400s).

3. **P0 — kiosk ShiftStatus enum mismatch.** The kiosk clock-in/out handlers
   wrote literal `'OPEN'`/`'COMPLETED'` shift statuses that do not exist in
   the `ShiftStatus` enum (`SCHEDULED | CLOCKED_IN | LATE | CLOCKED_OUT |
   NO_SHOW`). Every kiosk shift write failed Prisma validation on arrival.
   Rewritten against the real enum (matches `shiftService.js` conventions).

4. **Kiosk credential surface.** `employeeId` alone was accepted as a
   credential on clock-in/out. Now: PIN OR the scoped 5-minute
   `kioskToken` capability (JWT, `kiosk_clock_only` scope, shift-binding
   asserted on use) is required; `pin-auth` is scoped to the caller's
   effective business (foreign `businessProfileId` in body → 403); PIN
   brute-force ceiling per-employee for named clock-in and per-business for
   pin-auth (429 after 5 failures); per-employee row lock makes concurrent
   clock-ins converge on ONE shift and concurrent clock-outs complete
   exactly once with stats incremented exactly once (conditional
   `updateMany` claim inside the transaction).

5. **Mutation-boundary tenant predicates.** Recurring expense templates,
   promotions (PATCH/DELETE), review respond/flag, recipe link/unlink,
   inventory deduction: authorization is no longer read-then-mutate; the
   mutation itself carries the `businessProfileId` predicate. Promotion
   PATCH also rejects field injection (`businessProfileId`/`usageCount` in
   body are ignored, not applied). Deduction carries a poisoned-recipe
   guard: any cross-business ingredient fails closed (409) before mutation,
   and the decrement loop is tenant-predicated with full rollback on any
   mid-transaction failure.

6. **Room-status occupancy authority.** `updateRoomStatus` is CAS'd on
   `currentReservationId`: a held room can never be flipped AVAILABLE, a
   free room can never be fabricated OCCUPIED (that transition belongs to
   check-in/walk-in/move), foreign rooms 404, and concurrent status edits
   re-read committed truth instead of blind overwrites.
   `completeHousekeeping` completes the task but only flips
   CLEANING→AVAILABLE conditionally (`updateMany` where
   `status: 'CLEANING', currentReservationId: null`) — a room re-occupied
   mid-housekeeping is never forced AVAILABLE. Walk-in claims are
   conditional `updateMany` (`AVAILABLE→OCCUPIED`) inside the transaction —
   two concurrent walk-ins cannot double-book a room.

7. **Restock posting unit.** Sub-unit totals (non-zero exact product below
   the ledger's 10^-8 representable unit) are REJECTED with a clear error
   instead of silently rounding to a zero posting; totals at/above the unit
   post with both the exact product and the posted amount as durable
   metadata evidence; zero-cost restocks post an exact truthful zero.
   Idempotency claims outlive catalog state (replay after item
   soft-retirement returns the committed result, no second posting), new
   restocks on retired items fail closed, and the router exposes no
   hard-delete route for inventory items (soft-retirement is the lifecycle).

## Proofs

- `__tests__/r34-route-authority-sweep.test.js` — 14 proofs (registration
  inventory, tenant predicates, field injection, poisoned recipe, rollback).
- `__tests__/r34-kiosk-room-restock.test.js` — 16 proofs (kiosk E1-E8, room
  F1-F3, restock G1-G3, durability H1-H2).
- Both suites: 3 consecutive green runs (`--runInBand`, real PostgreSQL).
- Full battery: see commit message.

## Notes

- Suites MUST run `--runInBand` (repo convention): they share one disposable
  `azm_test` database and TRUNCATE fixtures per test.
- The r31 `azm_reservation_capacity_trigger` requires an AVAILABLE room at
  CHECKED_IN creation, and `azm_room_status_trigger` forbids MAINTENANCE
  superseding committed future bookings — both are enforced at the DB
  boundary and respected by the r34 service-layer rules above.
