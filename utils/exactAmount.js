// utils/exactAmount.js
// =============================================================================
// The EXACT decimal value of a request amount.
//
// `parseFloat(req.body.amount)` is how the legacy wallet paths read an amount,
// and it is fine for the legacy arithmetic they already do — but a guard that
// decides "would this settle to 0.00 GHS?" must measure what the client
// actually sent, not a binary approximation of it. `String(0.1 + 0.2)` is
// "0.30000000000000004"; a double round-trip can move a figure across a rounding
// boundary, and at pesewa precision that is the difference between a payout and
// a dust refusal.
//
// This returns a Prisma.Decimal built from the ORIGINAL TEXT (string inputs keep
// every digit the client sent) and `null` when the input is absent, empty or not
// a finite number, so callers can refuse rather than guess.
// =============================================================================
'use strict';

const { Prisma } = require('@prisma/client');

function requestAmountExact(raw) {
    if (raw === null || raw === undefined) return null;
    let text;
    if (typeof raw === 'string') {
        text = raw.trim();
    } else if (typeof raw === 'number') {
        text = Number.isFinite(raw) ? String(raw) : '';
    } else {
        return null;
    }
    if (text === '') return null;
    try {
        const value = new Prisma.Decimal(text);
        return value.isFinite() ? value : null;
    } catch (_) {
        return null;
    }
}

module.exports = { requestAmountExact };
