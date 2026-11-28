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
// These are the defaults. The admin Fee Lab publishes changes to them as
// AdminMoneySettingRevision rows (key feeRefund.<CAUSE>, valueEnum REFUND or
// KEEP); publishedFeeRefund reads the latest one in effect, and a cause with
// no published value keeps its default.
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

const policyKey = (cause) => `feeRefund.${cause}`;

/**
 * The published fee-refund rules in effect, as { CAUSE: true|false }, or null
 * when none are published. Read inside the refund's own transaction.
 */
const publishedFeeRefund = async (db, now = new Date()) => {
    if (!db || !db.adminMoneySettingRevision) return null;
    const keys = Object.keys(DEFAULT_FEE_REFUND).map(policyKey);
    const rows = await db.adminMoneySettingRevision.findMany({
        where: { key: { in: keys }, effectiveAt: { lte: now } },
        orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
    });
    const out = {};
    for (const r of rows) {
        const cause = r.key.slice('feeRefund.'.length);
        if (Object.prototype.hasOwnProperty.call(out, cause)) continue;
        if (r.valueEnum === 'REFUND') out[cause] = true;
        else if (r.valueEnum === 'KEEP') out[cause] = false;
    }
    return Object.keys(out).length ? out : null;
};

/** refundsFee with the published rules, read through `db` (a transaction). */
const refundsFeeNow = async (db, cause, now = new Date()) => refundsFee(cause, await publishedFeeRefund(db, now));

module.exports = { REFUND_CAUSE, DEFAULT_FEE_REFUND, refundsFee, publishedFeeRefund, refundsFeeNow, policyKey };
