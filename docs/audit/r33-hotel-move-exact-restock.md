# r33 — Hotel Room-Move Concurrency Authority + Inventory Restock Exact Economics

Date: 2026-09-23
Scope: Wave 1 of the Business OS data-integrity audit — `hotelOpsService` (`updateRoom`, `moveRoom`) and `inventoryRestockService.restock`, on the `fix/r32-business-os-tenant-authority` tree.

## Wave 1.1 — tenant-scoped hotel room mutations

`updateRoom` no longer mutates by bare `prisma.hotelRoom.update({ where: { id } })`. The mutation is constrained by `updateMany` on `{ id, businessProfileId }` with an explicit field allow-list; a cross-business id matches zero rows and fails closed as `HOTEL_ROOM_NOT_FOUND`. No caller-supplied `businessProfileId` in the PATCH body can alter tenancy: the authoritative business context comes only from the authenticated scope, and the payload key is not in the allow-list (proof 8).

## Wave 1.2 — room-move concurrency authority

`moveRoom` is one database transaction, deliberately at **default (READ COMMITTED) isolation**, not Serializable:

1. The reservation is read inside the transaction (authoritative current room + business scope).
2. The reservation move is a CAS **first** — `updateMany` on `{ id, businessProfileId, serviceItemId: originRoomId }`. This is the statement the r31 capacity trigger evaluates; the target room must still be `AVAILABLE` and the interval unclaimed at that instant, or the trigger refuses the move itself. (The original order — claim the room first — made the trigger observe our own uncommitted `OCCUPIED` claim and refuse **every** move; room moves were broken since the r31 overlay was installed. The reorder fixes that real defect.)
3. The target room is then claimed conditionally on `{ id, businessProfileId, status: 'AVAILABLE' }`; the loser of any claim race gets count 0 and the whole transaction rolls back, including its reservation CAS.
4. Old-room cleanup is conditional on `{ currentReservationId: reservationId }` — a room already re-claimed by another reservation is never clobbered to `DIRTY`.

Why READ COMMITTED: the r31 capacity trigger evaluates availability against **committed** data behind a transaction-scoped business advisory lock. A Serializable snapshot makes that evaluation read stale pre-race state (SSI does not reliably abort the trigger/advisory-lock pattern), which let a concurrent restock double-book the same room in the r31 race proof. Under READ COMMITTED every statement re-reads committed truth, and the trigger + advisory lock are the database authority exactly as designed.

Serialization retries use a **pinned-origin** contract: the origin room observed on the first attempt is remembered across retries; a retry proceeds only while the reservation still holds that same room. A→C can never silently degrade into B→C after losing a race to A→B — the loser fails with `Reservation was moved concurrently; retry the move.`

Proofs: `__tests__/r33-hotel-room-move-concurrency.test.js` (8 proofs, real PostgreSQL):

1. sequential move consistency (old released, target claimed, reservation updated),
2. concurrent A→B vs A→C — exactly one move wins, no orphan `OCCUPIED` room, loser fully rolled back (forced overlap via the capacity trigger's own advisory-lock barrier, so both movers hold the same origin before either CAS),
3. move vs walk-in claim on the target room — exactly one wins,
4. failed move leaves reservation, old room, and target exactly as before,
5. self-move refused,
6. cross-business isolation (foreign reservation, foreign target),
7. conditional old-room cleanup,
8. caller-supplied business id in the payload is inert.

The r31 capacity suite and the r32 tenant-authority suite remain green on this tree (25/25 combined, double-run).

## Wave 1B — inventory restock exact-decimal economics

Binary floats are no longer the economic authority for restocking:

- **Precision contract (documented):** quantities `> 0` and GHS unit costs `>= 0`, each at most **8 decimal places** (the ledger's own `Decimal(20, 8)` scale) and magnitude `<= 1e12`. Malformed inputs are rejected — exponents (`1e5`), hex (`0x10`), comma decimals, whitespace-padded strings, booleans, `NaN`, `Infinity`, `null`, objects, negatives, and anything beyond 8 decimal places.
- All arithmetic runs on `Prisma.Decimal` (`decimal.js`). `0.1 × 3` posts exactly `-0.3` GHS to `BusinessLedgerEntry.amount`, never `-0.30000000000000004`.
- The exact product, quantity, and unit cost are preserved as fixed-notation strings in the ledger row's `metadata` — durable audit evidence that never touches a binary float.
- The schema stays unchanged: `InventoryItem.currentStock/costPerUnit` remain legacy `Float` columns (operational/display state, traced through all readers/writers: `businessOSRoutes`, `businessOSInventoryRoutes`, `posOrderService`). The **ledger row** is the economic authority.
- Wire compatibility preserved: `result.totalCostGhs` remains a JSON number; JSON-number inputs behave exactly as before.
- The idempotency fingerprint stays byte-identical to the original float formula (`JSON.stringify` of the same normalized floats), so every operation committed before this change still replays correctly instead of stranding behind 409s.

Proofs: `__tests__/r33-inventory-restock-exact-economics.test.js` (21 proofs incl. 14 rejection lanes) plus the pre-existing idempotency and unit suites (43/43 combined).

## Local verification

- r33 + r31 + r32 hotel suites: 33 proofs, double-run green.
- Restock suites: 43 proofs green.
- Full battery: see PR check run.

## PR

PR #303 (`fix/r32-business-os-tenant-authority` → `main`), retitled to cover the r32 + r33 waves: business-scoped tenant authority, room-move concurrency, exact restock economics.
