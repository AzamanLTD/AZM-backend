// services/transitSeatLayout.js
// =============================================================================
// Which cells of a vehicle's seat map are seats, and which can be booked.
//
// The operator's seat-map editor marks empty space and walkways as NONE (or
// EMPTY in older maps). Those cells are drawn as space, are never seats, and
// can never be booked, quoted or counted: a booking that names one is
// refused like an unknown seat. The app reads the same rule
// (TransitSeat._parseType: NONE/EMPTY → space).
//
// A seat the operator marked BLOCKED (status) is a seat, shown as blocked,
// and cannot be booked or quoted.
//
// validateLayout checks what an operator saves; bookedSeatsLost finds booked
// seats a new layout would remove or block (the save is then refused).
// =============================================================================

const NON_SEAT_TYPES = new Set(['NONE', 'EMPTY']);
const SEAT_TIERS = Object.freeze(['VIP', 'STANDARD', 'ECONOMY']);
const MAX_CELLS = 400;
const MAX_GRID = 40;
const MAX_TIER_FARE_USDC = 10000;
const ACTIVE_BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'IN_PROGRESS'];

const isSeatCell = (cell) => Boolean(cell && cell.seatId != null
    && !NON_SEAT_TYPES.has(String(cell.type || '').toUpperCase()));

const isBlocked = (cell) => String((cell && cell.status) || '').toUpperCase() === 'BLOCKED';

/** A seat that can be booked: a real seat, not blocked by the operator. */
const isBookableSeat = (cell) => isSeatCell(cell) && !isBlocked(cell);

/** The bookable seats of a layout (an array of cells). */
const bookableSeats = (layout) => (Array.isArray(layout) ? layout.filter(isBookableSeat) : []);

/** The ids of the bookable seats, as a Set. */
const bookableSeatIds = (layout) => new Set(bookableSeats(layout).map((c) => c.seatId));

const _err = (code, message, httpStatus = 400, detail) => Object.assign(new Error(message), { code, httpStatus, ...(detail ? { detail } : {}) });

/**
 * What an operator saves. Throws a coded error; returns the cleaned
 * { layout, rows, cols, tierFares }.
 */
const validateLayout = ({ layout, rows, cols, tierFares }) => {
    const r = Number(rows); const c = Number(cols);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 1 || c < 1 || r > MAX_GRID || c > MAX_GRID) {
        throw _err('SEAT_MAP_INVALID', `rows and cols must be whole numbers from 1 to ${MAX_GRID}.`);
    }
    if (!Array.isArray(layout) || layout.length === 0 || layout.length > MAX_CELLS) {
        throw _err('SEAT_MAP_INVALID', `layout must be a list of 1 to ${MAX_CELLS} cells.`);
    }
    const seen = new Set();
    for (const cell of layout) {
        if (!cell || typeof cell !== 'object') throw _err('SEAT_MAP_INVALID', 'Each cell must be an object.');
        const id = cell.seatId;
        if (typeof id !== 'string' || !id.trim() || id.length > 16) throw _err('SEAT_MAP_INVALID', 'Each cell needs a seatId of at most 16 characters.');
        if (seen.has(id)) throw _err('SEAT_MAP_INVALID', `Seat ${id} appears twice.`);
        seen.add(id);
        if (cell.tier != null && !SEAT_TIERS.includes(cell.tier)) {
            throw _err('SEAT_MAP_INVALID', `Invalid seat tier "${cell.tier}". Must be one of ${SEAT_TIERS.join(', ')}.`);
        }
    }
    let fares;
    if (tierFares != null) {
        if (typeof tierFares !== 'object' || Array.isArray(tierFares)) throw _err('SEAT_MAP_INVALID', 'tierFares must be an object.');
        fares = {};
        for (const [k, v] of Object.entries(tierFares)) {
            if (!SEAT_TIERS.includes(k)) throw _err('SEAT_MAP_INVALID', `Invalid tier fare key "${k}". Must be one of ${SEAT_TIERS.join(', ')}.`);
            const n = Number(v);
            if (!Number.isFinite(n) || n <= 0 || n > MAX_TIER_FARE_USDC) {
                throw _err('SEAT_MAP_INVALID', `The ${k} fare must be more than 0 and at most ${MAX_TIER_FARE_USDC} USDC.`);
            }
            fares[k] = n;
        }
    }
    return { layout, rows: r, cols: c, tierFares: fares };
};

/**
 * Seats with an active booking on this vehicle's trips that the new layout
 * would remove, turn into space, or block. A save that loses any is refused:
 * move or cancel those bookings first.
 */
const bookedSeatsLost = async (db, { vehicleId, layout }) => {
    const keep = bookableSeatIds(layout);
    const rows = await db.transitBookingSeat.findMany({
        where: { trip: { vehicleId }, booking: { status: { in: ACTIVE_BOOKING_STATUSES } } },
        select: { seatId: true },
    });
    return [...new Set(rows.map((s) => s.seatId).filter((id) => !keep.has(id)))].sort();
};

module.exports = {
    NON_SEAT_TYPES, SEAT_TIERS, isSeatCell, isBlocked, isBookableSeat, bookableSeats, bookableSeatIds,
    validateLayout, bookedSeatsLost,
};
