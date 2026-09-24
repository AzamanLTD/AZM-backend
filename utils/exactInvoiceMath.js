// utils/exactInvoiceMath.js
// =============================================================================
// r39/P0 — EXACT-DECIMAL financial math authority for business commerce
// (POS settlement, business invoices, dine-in cash close).
//
// The legacy utils/invoiceMath.js computes with parseFloat + JS float
// multiplication + 6dp toFixed rounding. That silently loses the 7th/8th
// decimal against every Decimal(20,8) storage column and is binary-float
// inexact end-to-end. This module replaces it as the ONE business tax/line
// math authority:
//
//   • inputs enter through ledger.toExactDecimal — the platform's canonical
//     exact-decimal parser (same authority as every financial rail): no
//     exponent strings, no NaN/Infinity, no >8dp fractional floats, explicit
//     decimal strings always exact;
//   • all arithmetic runs on Prisma.Decimal — never on JS numbers;
//   • the ONLY rounding is the deliberate storage quantization at the exact
//     Decimal(20,8) boundary: HALF_UP to 8dp, applied per tax line and to
//     every stored monetary field. The quantization rule is a tested
//     contract: tax on 0.12345678 at 5% = 0.006172839 exact, quantized to
//     0.00617284 (never silently truncated to the legacy 0.006173);
//   • the tax total is the sum of the QUANTIZED line amounts, so stored
//     lines always reconcile with the stored tax total and replay is exact;
//   • serialized wire values are produced by toWire() only at the response
//     boundary (8dp string -> JS number for the legacy JSON envelope).
//
// The legacy invoiceMath.js is retained untouched for non-financial legacy
// callers; every money-bearing runtime caller now imports THIS module.
// =============================================================================

'use strict';

const { Prisma } = require('@prisma/client');
const ledger = require('../services/ledgerService');

// Canonical exact-decimal parse (non-negative, <= 8dp, no exponent).
// Re-exported for callers that need the same strict entry parser.
function parseExactDecimal(value, label) {
    return ledger.toExactDecimal(value, label);
}

// Deliberate storage quantization — HALF_UP to exactly 8 decimal places.
// This is the ONLY rounding in the business commerce money path and it is
// applied at the Decimal(20,8) storage boundary, never mid-computation.
function quantize8(dec) {
    return new Prisma.Decimal(dec).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
}

// Wire serialization for the legacy JSON envelope: the exact 8dp string is
// converted to a JS number whose round-trip representation is identical
// (Number("0.00617284") === 0.00617284). Deliberate boundary, not authority.
function toWire(dec) {
    return Number(quantize8(dec).toFixed(8));
}

function toFixed8(dec) {
    return quantize8(dec).toFixed(8);
}

/**
 * Compute invoice/POS line items with exact decimal arithmetic.
 * Each item: { description, quantity (integer 1..N), unitPrice }
 * unitPrice must be an exact non-negative decimal (<= 8dp).
 * Returns { subtotal: Prisma.Decimal, lineItems: [{ description, quantity,
 * unitPrice: Prisma.Decimal, lineTotal: Prisma.Decimal }] }
 * — all financial fields remain Decimal (no rounding anywhere).
 */
function computeLineItemsExact(lineItems) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
        throw new Error('At least one line item is required.');
    }
    if (lineItems.length > 50) {
        throw new Error('Maximum 50 line items per invoice.');
    }

    let subtotal = new Prisma.Decimal(0);
    const clean = lineItems.map((item) => {
        const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
        if (!Number.isInteger(qty) || qty < 1) throw new Error('Invalid line item quantity.');
        const unit = parseExactDecimal(item.unitPrice, 'unitPrice'); // non-negative, <= 8dp
        // Exact decimal multiplication — 8dp × integer is representable at 8dp.
        const lineTotal = unit.times(qty);
        if (lineTotal.decimalPlaces() > 8) {
            throw new Error('Line total exceeds 8 decimal places.');
        }
        subtotal = subtotal.plus(lineTotal);
        return {
            description: String(item.description || '').trim().slice(0, 200),
            quantity: qty,
            unitPrice: unit,
            lineTotal,
        };
    });

    return { subtotal, lineItems: clean };
}

/**
 * Compute tax lines from tax specs against an exact decimal subtotal.
 * Each spec: { name, type: 'FLAT' | 'PERCENTAGE', value }.
 * PERCENTAGE: computed = subtotal × (value / 100), exact, then quantized
 * HALF_UP to 8dp per line (the storage rule). taxTotal = Σ quantized lines,
 * so stored tax lines reconcile exactly with the stored tax total.
 * Returns { taxTotal: Prisma.Decimal, taxLines: [{ name, type, value, computedAmount: Prisma.Decimal }] }.
 */
function computeTaxLinesExact(taxSpecs, subtotalDec) {
    const subtotal = quantize8(subtotalDec);
    let taxTotal = new Prisma.Decimal(0);
    const clean = (taxSpecs || []).map((t) => {
        const name = String(t.name || '').trim().slice(0, 100);
        if (!name) throw new Error('Tax line name is required.');
        if (t.type !== 'FLAT' && t.type !== 'PERCENTAGE') {
            throw new Error(`Unsupported tax line type for '${name}'.`);
        }
        const type = t.type;
        const value = parseExactDecimal(t.value, `tax value for '${name}'`); // non-negative, <= 8dp
        // Exact percentage arithmetic: 0.12345678 × 5% = 0.006172839 exactly.
        const computed = type === 'PERCENTAGE'
            ? subtotal.times(value).div(new Prisma.Decimal(100))
            : value;
        // Deliberate storage quantization (HALF_UP, 8dp) — the tested rule.
        const computedAmount = quantize8(computed);
        taxTotal = taxTotal.plus(computedAmount);
        return { name, type, value, computedAmount };
    });

    // taxTotal is the exact sum of 8dp-quantized lines — always <= 8dp.
    return { taxTotal, taxLines: clean };
}

/**
 * Full exact invoice computation: line items + tax lines -> bill total.
 * All outputs are Prisma.Decimal; no rounding beyond the per-line tax
 * quantization rule above.
 */
function computeInvoiceTotalsExact(lineItems, taxSpecs) {
    const { subtotal, lineItems: clean } = computeLineItemsExact(lineItems);
    const { taxTotal, taxLines: cleanTax } = computeTaxLinesExact(taxSpecs, subtotal);
    const billTotal = subtotal.plus(taxTotal);
    return { subtotal, taxTotal, billTotal, lineItems: clean, taxLines: cleanTax };
}

module.exports = {
    parseExactDecimal,
    quantize8,
    toWire,
    toFixed8,
    computeLineItemsExact,
    computeTaxLinesExact,
    computeInvoiceTotalsExact,
};
