// services/feeRefundPolicy.js
// =============================================================================
// AZAMAN — WHEN THE AZAMAN FEE IS GIVEN BACK WITH A REFUND.
//
// A booking paid in the app (a stay, a seat) charges the price plus the
// Azaman fee. When the booking is refunded, the price always comes back. The
// fee depends on why:
//   • the business cancelled (the hotel declined or cancelled the stay, the
//     operator cancelled the booking or the whole trip): everything comes
//     back, fee included. The customer did nothing wrong.
//   • the customer cancelled, did not show, or the booking lapsed: the price
//     comes back and the fee is kept (the service was provided: the booking
//     was held for them).
//
// These are the defaults. The admin Fee Lab edits them as part of the
// published fee settings; until a published value exists, these apply.
// =============================================================================

const REFUND_CAUSE = Object.freeze({
    BUSINESS_CANCELLED: 'BUSINESS_CANCELLED',
    CUSTOMER_CANCELLED: 'CUSTOMER_CANCELLED',
    NO_SHOW: 'NO_SHOW',
    EXPIRED: 'EXPIRED',
});

const DEFAULT_FEE_REFUND = Object.freeze({
    [REFUND_CAUSE.BUSINESS_CANCELLED]: true,
    [REFUND_CAUSE.CUSTOMER_CANCELLED]: false,
    [REFUND_CAUSE.NO_SHOW]: false,
    [REFUND_CAUSE.EXPIRED]: false,
});

/**
 * True when a refund for this cause gives the fee back too.
 * @param {string} cause one of REFUND_CAUSE
 * @param {object} [published] the published fee settings' feeRefund map, when
 *        one exists ({ BUSINESS_CANCELLED: true, ... }); unknown or missing
 *        keys fall back to the defaults.
 */
const refundsFee = (cause, published = null) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_FEE_REFUND, cause)) return false;
    if (published && typeof published === 'object' && typeof published[cause] === 'boolean') {
        return published[cause];
    }
    return DEFAULT_FEE_REFUND[cause];
};

module.exports = { REFUND_CAUSE, DEFAULT_FEE_REFUND, refundsFee };
