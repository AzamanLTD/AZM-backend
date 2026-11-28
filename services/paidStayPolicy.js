// services/paidStayPolicy.js
// =============================================================================
// AZAMAN — WHEN A STAY PAID IN THE APP CAN BE CHECKED IN, AND WHEN IT IS A
// NO-SHOW.
//
// A stay's dates are whole UTC days: it starts at 00:00 on the check-in day
// and ends at 00:00 on the check-out day. A stay paid in the app
// (stayPaymentService marks it metadata.paidStay) has two extra rules,
// because its check-in is what pays the hotel:
//   • check-in opens 24 hours before the check-in day (an early arrival the
//     evening before). A QR scanned earlier is refused and pays nothing out;
//   • a late arrival (a delayed flight, past midnight) can still check in
//     until noon on the check-out day, and only after that is the stay a
//     no-show (refunded by the sweep).
// Every other reservation keeps its own window: start to end.
// =============================================================================

const HOUR_MS = 60 * 60 * 1000;
const PAID_STAY_EARLY_CHECKIN_MS = 24 * HOUR_MS;
const PAID_STAY_LATE_ARRIVAL_MS = 12 * HOUR_MS;

const isPaidStay = (reservation) => !!(reservation
    && reservation.metadata
    && typeof reservation.metadata === 'object'
    && reservation.metadata.paidStay === true);

/** Epoch ms from which a QR check-in is accepted, or null (no lower bound). */
const checkInOpensAt = (reservation) => (isPaidStay(reservation) && reservation.startDatetime
    ? new Date(reservation.startDatetime).getTime() - PAID_STAY_EARLY_CHECKIN_MS
    : null);

/** Epoch ms after which check-in is closed, or null (no end). */
const checkInClosesAt = (reservation) => (reservation && reservation.endDatetime
    ? new Date(reservation.endDatetime).getTime() + (isPaidStay(reservation) ? PAID_STAY_LATE_ARRIVAL_MS : 0)
    : null);

/** A reservation is a no-show once its end is before this instant. */
const noShowCutoff = (reservation, now = Date.now()) => new Date(
    now - (isPaidStay(reservation) ? PAID_STAY_LATE_ARRIVAL_MS : 0),
);

module.exports = {
    isPaidStay,
    checkInOpensAt,
    checkInClosesAt,
    noShowCutoff,
    PAID_STAY_EARLY_CHECKIN_MS,
    PAID_STAY_LATE_ARRIVAL_MS,
};
