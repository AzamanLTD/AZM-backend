'use strict';
// =============================================================================
// Business revenue aggregation  per currency, exact, never merged.
//
// The dashboard used to compute revenue as
// `Number(aggregate._sum.amountUsdc || 0)`: a float conversion of a sum that
// carries no currency at all. Under local-fiat-first that is wrong in two
// independent ways 
//    a GHS sale would either be excluded from it or (worse) added to it, making
//      25.00 GHS look like $25.00 of revenue;
//    Number() throws away exactness, so the total stops being a record and
//     becomes an approximation of one.
// This module returns one exact total PER CURRENCY and no merged figure. A
// caller that wants "total revenue" has to say which currency it means.
// =============================================================================
const { Prisma } = require('@prisma/client');
const { readOrderAmount } = require('./businessOrderCurrency');

/**
 * @param {Array<{currency:string|null, amountUsdc:any, amountGhs:any}>} orders
 * @returns {{GHS:string, USDC:string, counts:{GHS:number, USDC:number}}}
 * @throws {OrderCurrencyError} on a corrupt row  it is never skipped silently,
 *         because a skipped row is revenue that quietly disappears from a total.
 */
function sumOrdersByCurrency(orders = []) {
    let ghs = new Prisma.Decimal('0.00');
    let usdc = new Prisma.Decimal('0');
    const counts = { GHS: 0, USDC: 0 };

    for (const order of orders) {
        const reading = readOrderAmount(order);
        if (reading.currency === 'GHS') {
            ghs = ghs.plus(new Prisma.Decimal(reading.amount));
            counts.GHS += 1;
        } else {
            usdc = usdc.plus(new Prisma.Decimal(reading.amount));
            counts.USDC += 1;
        }
    }

    return { GHS: ghs.toFixed(2), USDC: usdc.toFixed(8), counts };
}

/** Exact mean per currency, or null when that currency had no orders. */
function averageOrderValue(summary) {
    const out = { GHS: null, USDC: null };
    for (const currency of ['GHS', 'USDC']) {
        if (summary.counts[currency] > 0) {
            const total = new Prisma.Decimal(summary[currency]);
            const mean = total.div(summary.counts[currency]);
            out[currency] = currency === 'GHS' ? mean.toFixed(2) : mean.toFixed(8);
        }
    }
    return out;
}

module.exports = { sumOrdersByCurrency, averageOrderValue };
