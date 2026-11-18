'use strict';
// BusinessOrder currency discipline — the ONE interpretation of an order's money.
//
// WHY THIS FILE EXISTS
// The mutual-exclusion constraints in prisma/sql/2026-11-15-business-order-
// currency-contract.sql only exist where that SQL has actually been applied.
// Production is provisioned with `prisma db push`, which creates no CHECK
// constraints, so production WOULD accept a row carrying both a GHS and a USDC
// amount. This module is the enforcement that travels in the code.
//
// WHY SUB-PESEWA IS REFUSED HERE AND NOWHERE ELSE
// Postgres coerces to the column scale BEFORE evaluating constraints, so
// '25.005' reaches numeric(20,2) as 25.01 and no CHECK can see the excess. The
// only place the original string still exists is here, before the write.
//
// WHY THERE IS ONE READER
// A caller that guesses an order's currency is exactly how a 25.00 GHS sale
// becomes "$25.00" in a report.

const CURRENCIES = Object.freeze(['GHS', 'USDC']);

const CODES = Object.freeze({
    NOT_A_STRING: 'ORDER_AMOUNT_NOT_A_STRING',
    MALFORMED: 'ORDER_AMOUNT_MALFORMED',
    SUB_PESEWA: 'ORDER_AMOUNT_SUB_PESEWA',
    NEGATIVE: 'ORDER_AMOUNT_NEGATIVE',
    ZERO: 'ORDER_AMOUNT_ZERO',
    CORRUPT: 'ORDER_CURRENCY_CORRUPT',
    UNKNOWN: 'ORDER_CURRENCY_UNKNOWN',
});

class OrderCurrencyError extends Error {
    constructor(code, message, detail = {}) {
        super(message);
        this.name = 'OrderCurrencyError';
        this.code = code;
        this.detail = detail;
    }
}

/** Render a Prisma Decimal (or string) at a fixed scale, never exponentiating. */
function decimalText(value, dp) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' && typeof value.toFixed === 'function') return value.toFixed(dp);
    return String(value);
}

/**
 * Parse a native GHS amount from its WIRE form (an exact decimal string) and
 * return the canonical 2dp string, or throw. Numbers are rejected on purpose: a
 * JS double may already have lost the exact value before it gets here.
 */
function parseGhsAmount(raw, opts = {}) {
    const allowZero = opts.allowZero !== false;
    if (typeof raw !== 'string') {
        throw new OrderCurrencyError(CODES.NOT_A_STRING,
            'GHS amounts must be sent as an exact decimal string, never a number.',
            { received: typeof raw });
    }
    const text = raw.trim();
    if (text === '') {
        throw new OrderCurrencyError(CODES.MALFORMED, 'GHS amount is empty.');
    }
    if (text.startsWith('-')) {
        throw new OrderCurrencyError(CODES.NEGATIVE, 'GHS amount cannot be negative.', { received: raw });
    }
    if (/[eE]/.test(text)) {
        throw new OrderCurrencyError(CODES.MALFORMED, 'GHS amount cannot use exponent notation.', { received: raw });
    }
    if (!/^\d+(\.\d+)?$/.test(text)) {
        throw new OrderCurrencyError(CODES.MALFORMED,
            'GHS amount must be digits with an optional decimal point (no separators, symbols or inner spaces).',
            { received: raw });
    }
    const [intPart, fracPart = ''] = text.split('.');
    if (fracPart.length > 2) {
        throw new OrderCurrencyError(CODES.SUB_PESEWA,
            'GHS amount has more than 2 decimal places; pesewas are the smallest unit and the amount will NOT be rounded.',
            { received: raw });
    }
    const normalisedInt = intPart.replace(/^0+(?=\d)/, '');
    const canonical = `${normalisedInt}.${(fracPart + '00').slice(0, 2)}`;
    if (!allowZero && canonical === '0.00') {
        throw new OrderCurrencyError(CODES.ZERO,
            'GHS amount must be greater than zero for this operation.', { received: raw });
    }
    return canonical;
}

/**
 * The only sanctioned reading of a BusinessOrder's money.
 * @returns {{currency:'GHS'|'USDC', amount:string, legacy:boolean}}
 */
function readOrderAmount(order) {
    if (!order || typeof order !== 'object') {
        throw new OrderCurrencyError(CODES.CORRUPT, 'Cannot read money from a missing order.');
    }
    const hasUsdc = order.amountUsdc !== null && order.amountUsdc !== undefined;
    const hasGhs = order.amountGhs !== null && order.amountGhs !== undefined;
    if (hasUsdc && hasGhs) {
        throw new OrderCurrencyError(CODES.CORRUPT,
            'Order carries BOTH a GHS and a USDC amount; refusing to pick one.',
            { orderId: order.id ?? null });
    }
    if (!hasUsdc && !hasGhs) {
        throw new OrderCurrencyError(CODES.CORRUPT,
            'Order carries no amount at all; it would vanish from every total.',
            { orderId: order.id ?? null });
    }
    const currency = order.currency === undefined ? null : order.currency;
    if (currency === null) {
        // Legacy rows pre-date the currency column; their meaning is USDC by history.
        if (!hasUsdc) {
            throw new OrderCurrencyError(CODES.CORRUPT, 'Untagged order carries no USDC amount.', { orderId: order.id ?? null });
        }
        return { currency: 'USDC', amount: decimalText(order.amountUsdc, 8), legacy: true };
    }
    if (currency === 'GHS') {
        if (!hasGhs) {
            throw new OrderCurrencyError(CODES.CORRUPT, 'GHS order carries no GHS amount.', { orderId: order.id ?? null });
        }
        return { currency: 'GHS', amount: decimalText(order.amountGhs, 2), legacy: false };
    }
    if (currency === 'USDC') {
        if (!hasUsdc) {
            throw new OrderCurrencyError(CODES.CORRUPT, 'USDC order carries no USDC amount.', { orderId: order.id ?? null });
        }
        return { currency: 'USDC', amount: decimalText(order.amountUsdc, 8), legacy: false };
    }
    throw new OrderCurrencyError(CODES.UNKNOWN, `Unsupported order currency: ${String(currency)}`, { currency });
}

module.exports = { CURRENCIES, CODES, OrderCurrencyError, parseGhsAmount, readOrderAmount, decimalText };
