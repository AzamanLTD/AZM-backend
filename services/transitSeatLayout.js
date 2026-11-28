// services/transitSeatLayout.js
// =============================================================================
// Which cells of a vehicle's seat map are seats.
//
// The operator's seat-map editor marks empty space and walkways as NONE (or
// EMPTY in older maps). Those cells are drawn as space, are never seats, and
// can never be booked, quoted or counted: a booking that names one is
// refused like an unknown seat. The app reads the same rule
// (TransitSeat._parseType: NONE/EMPTY → space).
// =============================================================================

const NON_SEAT_TYPES = new Set(['NONE', 'EMPTY']);

const isSeatCell = (cell) => Boolean(cell && cell.seatId != null
    && !NON_SEAT_TYPES.has(String(cell.type || '').toUpperCase()));

/** The bookable seats of a layout (an array of cells). */
const bookableSeats = (layout) => (Array.isArray(layout) ? layout.filter(isSeatCell) : []);

/** The ids of the bookable seats, as a Set. */
const bookableSeatIds = (layout) => new Set(bookableSeats(layout).map((c) => c.seatId));

module.exports = { NON_SEAT_TYPES, isSeatCell, bookableSeats, bookableSeatIds };
