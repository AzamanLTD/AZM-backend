/**
 * SETTLEMENT SCALE POLICY — unit regressions (Blocker B).
 *
 * These pin the exact scale + rounding contract that cross-border money
 * paths must settle at: USDC/base at 8 dp, fiat at 2 dp, ROUND_HALF_UP,
 * user-supplied amounts with excess precision REFUSED (never silently
 * rounded), and no mutation of caller-owned Decimals.
 */
const { Prisma } = require('@prisma/client');

const {
    Decimal,
    SETTLEMENT_ROUNDING,
    BASE_SCALE,
    FIAT_SCALE,
    settlementScaleFor,
    quantizeFor,
    toWireString,
    parseUserAmount,
    isPositiveFiniteDecimal,
} = require('../services/settlementScale');

describe('settlementScale — currency-appropriate settlement contract', () => {
    describe('settlementScaleFor', () => {
        test('USDC settles at the 8-dp base ledger scale', () => {
            expect(settlementScaleFor('USDC')).toBe(8);
            expect(BASE_SCALE).toBe(8);
        });

        test('fiat wallet currencies settle at minor-unit precision', () => {
            expect(settlementScaleFor('GHS')).toBe(2);
            expect(settlementScaleFor('NGN')).toBe(2);
            expect(settlementScaleFor('KES')).toBe(2);
            expect(settlementScaleFor('USD')).toBe(2);
            expect(FIAT_SCALE).toBe(2);
        });

        test('unknown/absent currencies default to the FIAT scale — never to base scale', () => {
            expect(settlementScaleFor('XYZ')).toBe(2);
            expect(settlementScaleFor('')).toBe(2);
            expect(settlementScaleFor(undefined)).toBe(2);
        });
    });

    describe('quantizeFor — terminal settlement rounding', () => {
        test('a full-precision conversion product settles at the fiat scale with ROUND_HALF_UP', () => {
            // 500 GHS * 0.99 effective rate = 495 — exact, unchanged.
            expect(quantizeFor(new Decimal('495'), 'GHS').toString()).toBe('495');
            // 15.642 -> 15.64 (round down)
            expect(quantizeFor(new Decimal('15.642'), 'GHS').toString()).toBe('15.64');
            // 15.645 -> 15.65 (half rounds up)
            expect(quantizeFor(new Decimal('15.645'), 'GHS').toString()).toBe('15.65');
        });

        test('USDC amounts settle at 8 dp with half-up on the 9th place', () => {
            expect(quantizeFor(new Decimal('0.123456789'), 'USDC').toString()).toBe('0.12345679');
            expect(quantizeFor(new Decimal('0.000000005'), 'USDC').toString()).toBe('1e-8'); // Decimal.toString is exponential — wire form is toWireString
            expect(toWireString(quantizeFor(new Decimal('0.000000005'), 'USDC'), 'USDC')).toBe('0.00000001');
            expect(quantizeFor(new Decimal('10'), 'USDC').toString()).toBe('10');
        });

        test('the policy rounding mode is ROUND_HALF_UP (decimal.js)', () => {
            expect(SETTLEMENT_ROUNDING).toBe(Decimal.ROUND_HALF_UP);
        });

        test('quantizeFor never mutates the caller-owned Decimal', () => {
            const original = new Decimal('1.005');
            quantizeFor(original, 'GHS');
            expect(original.toString()).toBe('1.005');
        });
    });

    describe('parseUserAmount — user-supplied amounts are never silently rounded', () => {
        test('accepts an exact fiat amount and settles it bit-for-bit', () => {
            const r = parseUserAmount('10.5', 'GHS');
            expect(r.ok).toBe(true);
            expect(r.amount.toString()).toBe('10.5');
        });

        test('accepts an exact 8-dp USDC amount', () => {
            const r = parseUserAmount('0.12345678', 'USDC');
            expect(r.ok).toBe(true);
            expect(r.amount.toString()).toBe('0.12345678');
        });

        test('REFUSES a fiat amount with sub-minor-unit precision (no silent debit rounding)', () => {
            const r = parseUserAmount('10.000000001', 'GHS');
            expect(r.ok).toBe(false);
            expect(r.code).toBe('AMOUNT_PRECISION_EXCEEDED');
            expect(r.scale).toBe(2);
        });

        test('REFUSES a USDC amount beyond the base settlement scale', () => {
            const r = parseUserAmount('0.123456789', 'USDC');
            expect(r.ok).toBe(false);
            expect(r.code).toBe('AMOUNT_PRECISION_EXCEEDED');
            expect(r.scale).toBe(8);
        });

        test('wire serialization is fixed-notation at the exact settlement scale', () => {
            expect(toWireString(new Decimal('15.65'), 'GHS')).toBe('15.65');
            expect(toWireString(new Decimal('0.12345679'), 'USDC')).toBe('0.12345679');
            expect(toWireString(new Decimal('0'), 'USDC')).toBe('0.00000000');
        });

        test('refuses an amount beyond the Decimal(20, 8) storage envelope', () => {
            expect(parseUserAmount('1e409', 'GHS').ok).toBe(false);
            expect(parseUserAmount('1000000000000', 'GHS').ok).toBe(false); // 13 integer digits
            expect(parseUserAmount('999999999999.99', 'GHS').ok).toBe(true); // 12 integer digits — fits
        });

        test('refuses zero, negative, non-numeric and empty input', () => {
            for (const bad of ['0', '-5', 'abc', '', '  ', '1e409']) {
                const r = parseUserAmount(bad, 'GHS');
                expect(r.ok).toBe(false);
                expect(r.code).toBe('INVALID_AMOUNT');
            }
        });
    });

    describe('isPositiveFiniteDecimal', () => {
        test('accepts only finite strictly-positive Decimals', () => {
            expect(isPositiveFiniteDecimal(new Decimal('0.01'))).toBe(true);
            expect(isPositiveFiniteDecimal(new Decimal('0'))).toBe(false);
            expect(isPositiveFiniteDecimal(new Decimal('-1'))).toBe(false);
            expect(isPositiveFiniteDecimal(new Decimal('NaN'))).toBe(false);
            expect(isPositiveFiniteDecimal(new Decimal('Infinity'))).toBe(false);
            expect(isPositiveFiniteDecimal('1.00')).toBe(false); // non-Decimal rejected
        });
    });
});
