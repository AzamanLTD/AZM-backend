'use strict';

// __tests__/transaction-quote-retail-rate.test.js
// =============================================================================
// §271 canonical FX source + fail-closed freshness gate (unit contract).
//
// The quote authority's ONLY rate reader is getFreshServerRateGhsPerUsdc:
//   1. retail rate preference: liveRetailRate wins; legacy USD/GHS is a
//      compatibility fallback only (installations predating the retail field)
//   2. freshness: lastExternalSync must exist, be in the past (bounded
//      clock-skew allowance) and be at most RATE_FRESHNESS_MAX_AGE_SECONDS
//      old — anything else throws RateUnavailableError (503), never a
//      fabricated-fresh read
//   3. rateAsOf is the TRUE external observation timestamp freshness was
//      enforced against — never the read time, never lastRateSync
//
// Prisma is mocked here (the real-PostgreSQL end-to-end proofs live in
// stale-rate-gate.test.js and rate-provenance-truthfulness.test.js).
// =============================================================================

const {
    getFreshServerRateGhsPerUsdc,
    RateUnavailableError,
} = require('../src/services/transactionQuoteService');

const FRESH = new Date('2026-10-07T06:00:00.000Z');
const NOW = new Date('2026-10-07T06:10:00.000Z'); // 600s after FRESH

const settings = (overrides = {}) => ({
    liveRetailRate: '13.18',
    liveUsdToGhs: '13.25',
    liveRateSource: 'KOTANI_PAY',
    lastExternalSync: FRESH,
    ...overrides,
});

const prismaWith = (s) => ({
    globalSettings: { findUnique: jest.fn().mockResolvedValue(s) },
});

describe('transaction quote canonical FX source (gated reader)', () => {
    test('prefers liveRetailRate over legacy USD/GHS field', async () => {
        const result = await getFreshServerRateGhsPerUsdc({ prisma: prismaWith(settings()), now: NOW });
        // §P.5-C Decimal-native rate path: the reader returns the authoritative
        // Decimal alongside the presentation Number.
        expect(result.rateGhsPerUsdc).toBe(13.18);
        expect(result.rateSource).toBe('KOTANI_PAY');
        expect(result.rateAsOf).toEqual(new Date(FRESH));
        expect(String(result.rateGhsPerUsdcExact)).toBe('13.18'); // the DB-authoritative Decimal, exact
        expect(Number(result.rateGhsPerUsdcExact)).toBe(13.18); // and its presentation projection agrees
        expect(result.externalAgeSeconds).toBeCloseTo(600, 0);
    });

    test('falls back to legacy USD/GHS only when retail rate is unavailable', async () => {
        const result = await getFreshServerRateGhsPerUsdc({
            prisma: prismaWith(settings({ liveRetailRate: null, liveRateSource: 'LEGACY' })),
            now: NOW,
        });
        expect(result.rateGhsPerUsdc).toBe(13.25);
        expect(result.rateSource).toBe('LEGACY');
    });

    test('NULL lastExternalSync fails closed (RATE_UNAVAILABLE)', async () => {
        const prisma = prismaWith(settings({ lastExternalSync: null }));
        await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
            .rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' });
    });

    test('missing GlobalSettings row fails closed (RATE_UNAVAILABLE)', async () => {
        const prisma = { globalSettings: { findUnique: jest.fn().mockResolvedValue(null) } };
        await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
            .rejects.toBeInstanceOf(RateUnavailableError);
    });

    test('age beyond the configured maximum fails closed (RATE_STALE)', async () => {
        const stale = new Date(NOW.getTime() - 1801 * 1000); // > default 1800s
        const prisma = prismaWith(settings({ lastExternalSync: stale }));
        await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
            .rejects.toMatchObject({ code: 'RATE_STALE' });
    });

    test('future lastExternalSync is untrusted, never infinitely fresh (RATE_STALE)', async () => {
        const future = new Date(NOW.getTime() + 24 * 3600 * 1000);
        const prisma = prismaWith(settings({ lastExternalSync: future }));
        await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
            .rejects.toMatchObject({ code: 'RATE_STALE' });
    });

    test('non-positive retail AND legacy rates fail closed (RATE_UNAVAILABLE)', async () => {
        const prisma = prismaWith(settings({ liveRetailRate: '0', liveUsdToGhs: '-1' }));
        await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
            .rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' });
    });

    test('rateAsOf is the true observation timestamp, never the read time', async () => {
        const result = await getFreshServerRateGhsPerUsdc({ prisma: prismaWith(settings()), now: NOW });
        expect(result.rateAsOf.getTime()).toBe(FRESH.getTime());
        expect(result.rateAsOf.getTime()).not.toBe(NOW.getTime());
    });
});
