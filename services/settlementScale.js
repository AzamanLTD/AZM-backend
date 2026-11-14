// ── SETTLEMENT SCALE POLICY (cross-border Susu consolidation, Blocker B) ────
//
// AZM-Planning #75 / financial-core review finding: money conversions on the
// cross-border Susu paths computed full-precision Prisma.Decimal values and
// persisted them UNQUANTIZED. PostgreSQL silently rounds a Decimal(20, 8)
// column on INSERT, so the persisted row, the wallet balance, the FX snapshot
// and the API response could each carry a different last-digit value. The
// response serialized the unquantized in-memory amount — the client saw a
// number the database never stored.
//
// This module is the SINGLE authority for settlement scale and rounding:
//
//   • BASE (USDC) amounts settle at 8 decimal places — the scale of every
//     Decimal(20, 8) ledger column. Ledger math happens at full precision and
//     is quantized exactly once, at the settlement boundary, before the first
//     durable write. Every downstream consumer (DB write, wallet credit,
//     FX snapshot, API response) then uses THE SAME quantized Decimal.
//   • Local fiat amounts (GHS, NGN, KES, USD, …) settle at 2 decimal places.
//     The currency set is not assumed to be uniform — scale is chosen per
//     currency symbol, defaulting to fiat precision.
//   • Rounding mode is ROUND_HALF_UP, chosen explicitly (decimal.js default),
//     the conventional money convention for terminal settlement. No other
//     rounding mode may appear on a cross-border money path.
//   • USER-SUPPLIED amounts are never silently rounded. A contribution request
//     carrying more precision than its currency's settlement scale (e.g.
//     "10.000000001" GHS) is REJECTED with a 400 — the caller is told the exact
//     amount that would be debited instead of discovering it post-hoc. Only
//     COMPUTED amounts (rate conversions) are rounded, once, at the boundary.
//
// Rounding at the boundary, not before: quantize the result of a conversion
// immediately before it is persisted/credited/returned — never quantize an
// intermediate operand (the rate is applied at full precision; the product is
// settled).

const { Prisma } = require('@prisma/client');

const Decimal = Prisma.Decimal;

// Rounding mode used for every terminal settlement on cross-border money
// paths. Imported by tests; do not pass ad-hoc modes at call sites.
const SETTLEMENT_ROUNDING = Decimal.ROUND_HALF_UP;

// Base ledger currency settles at the Decimal(20, 8) column scale.
const BASE_CURRENCY = 'USDC';
const BASE_SCALE = 8;
// Local fiat currencies settle at minor-unit precision.
const FIAT_SCALE = 2;

// Currencies known to settle at base scale (8 dp). Anything not listed
// settles at fiat scale (2 dp). Extend the set deliberately — adding a
// currency here is a settlement contract change.
const BASE_SCALE_CURRENCIES = new Set([BASE_CURRENCY]);

// Storage envelope guard: Decimal(20, 8) columns hold at most 12 integer
// digits. A finite-looking "1e409" parses cleanly as a Decimal but can never
// be persisted — reject it at the parse boundary, not at the DB write.
const MAX_ABS_SETTLEMENT = new Decimal(10).pow(12);

const _cache = {};
for (const d of [BASE_SCALE, FIAT_SCALE]) {
    _cache[d] = new Decimal(10).pow(d);
}

/**
 * Settlement scale (decimal places) for a currency symbol.
 * USDC settles at 8 dp; every other wallet currency at 2 dp.
 */
function settlementScaleFor(currency) {
    return BASE_SCALE_CURRENCIES.has(String(currency || '').toUpperCase())
        ? BASE_SCALE
        : FIAT_SCALE;
}

/**
 * Quantize a Prisma.Decimal to a currency's settlement scale with the
 * policy rounding mode. Returns a NEW Decimal; never mutates the input.
 * Throws on non-finite input — callers validate finiteness first.
 */
function quantizeFor(amount, currency) {
    const scale = settlementScaleFor(currency);
    return new Decimal(amount).toDecimalPlaces(scale, SETTLEMENT_ROUNDING);
}

/**
 * Parse a user-supplied amount string/number into an exact Decimal and
 * REFUSE precision beyond the currency's settlement scale (no silent
 * rounding of debits). Returns { ok: true, amount } or
 * { ok: false, code: 'INVALID_AMOUNT' | 'AMOUNT_PRECISION_EXCEEDED' }.
 */
function parseUserAmount(raw, currency) {
    let amount;
    try {
        amount = new Decimal(String(raw ?? '').trim());
    } catch (_e) {
        return { ok: false, code: 'INVALID_AMOUNT' };
    }
    if (!amount.isFinite() || amount.lte(0) || amount.gte(MAX_ABS_SETTLEMENT)) {
        return { ok: false, code: 'INVALID_AMOUNT' };
    }
    const scale = settlementScaleFor(currency);
    if (amount.decimalPlaces() > scale) {
        return { ok: false, code: 'AMOUNT_PRECISION_EXCEEDED', scale };
    }
    // Settle to the (already exact) scale so the debited amount equals the
    // requested amount bit-for-bit.
    return { ok: true, amount: amount.toDecimalPlaces(scale, SETTLEMENT_ROUNDING) };
}

/**
 * Authoritative wire representation of a SETTLED amount: fixed decimal
 * notation with the currency's exact settlement scale — never scientific
 * notation (Decimal.toString() renders 0.00000001 as "1e-8", which is not
 * the representation the database stores or the client should parse back).
 * The amount must already be quantized for the currency.
 */
function toWireString(amount, currency) {
    return new Decimal(amount).toFixed(settlementScaleFor(currency));
}

/**
 * Validate a Prisma.Decimal money value (already parsed from a request) —
 * finite and strictly positive. Returns true/false.
 */
function isPositiveFiniteDecimal(amount) {
    return (
        amount instanceof Decimal &&
        amount.isFinite() &&
        amount.gt(0)
    );
}

module.exports = {
    Decimal,
    SETTLEMENT_ROUNDING,
    BASE_CURRENCY,
    BASE_SCALE,
    FIAT_SCALE,
    BASE_SCALE_CURRENCIES,
    settlementScaleFor,
    quantizeFor,
    toWireString,
    parseUserAmount,
    isPositiveFiniteDecimal,
};
