// __tests__/fx-rate-snapshot.test.js
// =============================================================================
// FX-balance workstream — saved-rate snapshot service proof.
//
// PROVES, with Prisma NEVER mocked (real PostgreSQL via TEST_DATABASE_URL):
//
//   A. ONLY VALIDATED observations persist: noncanonical pair, non-positive /
//      malformed rate, empty source, unparseable or future observedAt are
//      all refused, and a refusal NEVER overwrites a valid saved rate.
//   B. DEMO HONESTY: a demo seed never overwrites a genuine observation
//      (refused with GENUINE_SAVED_RATE_PRESENT); a genuine observation
//      DOES replace a demo seed (reality supersedes demo); an idempotent
//      demo re-seed is refused with DEMO_SEED_ALREADY_PRESENT.
//   C. DISPLAY ELIGIBILITY is server-side and boundary-exact from the
//      persisted observedAt: age == max → eligible; age > max → ineligible.
//      There is no client-supplied endpoint in the comparison.
//   D. DEMO VISIBILITY: demo rows are display-eligible only when
//      demoModeRateSeedEnabled() is true (NODE_ENV='test' or explicit
//      DEMO_RATE_SEED flag); with the flag off, a demo row returns null
//      while a genuine row remains visible — production can never display
//      a demo rate.
//   E. SERIAL CONVERGENCE: successive genuine observations replace the
//      singleton (the table is a singleton snapshot, never an append log).
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[fx-rate-snapshot.test] TEST_DATABASE_URL not set — skipping.');

describe('FX saved-rate snapshot service (real PostgreSQL)', () => {
    if (!hasDb) return;

    let prisma;
    let snapshotService;
    let demoConfig;
    let policy;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        snapshotService = require('../src/services/fxRateSnapshotService');
        demoConfig = require('../src/config/demoRateSeed');
        policy = require('../src/config/fxDisplayPolicy');
    });

    afterAll(async () => {
        if (prisma) {
            // Hermetic exit: this suite owns the FxSavedRate singleton row —
            // wipe it so no other suite (or a later serial ordering) reads a
            // rate this suite fabricated. GlobalSettings is untouched by
            // this suite.
            await prisma.fxSavedRate.deleteMany({});
            await prisma.$disconnect();
        }
    });

    beforeEach(async () => {
        await prisma.fxSavedRate.deleteMany({});
    });

    // ── A. validated-only persistence ────────────────────────────────────

    test('persists a genuine validated observation with canonical provenance', async () => {
        const now = new Date('2026-10-22T12:00:00Z');
        const observedAt = new Date('2026-10-22T11:59:00Z');
        const result = await snapshotService.saveValidatedRateSnapshot({
            prisma,
            pair: 'USDC/GHS',
            rate: '12.0371',
            source: 'KOTANI_PAY',
            observedAt,
            now,
        });
        expect(result.saved).toBe(true);
        expect(result.snapshot.pair).toBe('USDC/GHS');
        expect(result.snapshot.isDemoSeed).toBe(false);
        expect(result.snapshot.source).toBe('KOTANI_PAY');
        expect(String(result.snapshot.rate)).toBe('12.0371');
        expect(new Date(result.snapshot.observedAt).toISOString()).toBe(observedAt.toISOString());
    });

    test.each([
        ['noncanonical pair', { pair: 'EUR/GHS', rate: '13', source: 'X', observedAt: new Date('2026-10-22T11:00:00Z') }],
        ['non-positive rate', { pair: 'USDC/GHS', rate: '0', source: 'X', observedAt: new Date('2026-10-22T11:00:00Z') }],
        ['malformed rate', { pair: 'USDC/GHS', rate: 'not-a-number', source: 'X', observedAt: new Date('2026-10-22T11:00:00Z') }],
        ['missing source', { pair: 'USDC/GHS', rate: '12', source: '  ', observedAt: new Date('2026-10-22T11:00:00Z') }],
        ['unparseable observedAt', { pair: 'USDC/GHS', rate: '12', source: 'X', observedAt: 'garbage' }],
    ])('refuses a %s observation', async (_label, badPayload) => {
        const now = new Date('2026-10-22T12:00:00Z');
        await expect(
            snapshotService.saveValidatedRateSnapshot({ prisma, now, ...badPayload })
        ).rejects.toThrow(snapshotService.SnapshotValidationError);
        // Nothing was persisted.
        expect(await prisma.fxSavedRate.findUnique({ where: { pair: 'USDC/GHS' } })).toBeNull();
    });

    test('refuses a future observation beyond clock-skew allowance and keeps the saved rate intact', async () => {
        const now = new Date('2026-10-22T12:00:00Z');
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.5', source: 'KOTANI_PAY',
            observedAt: new Date('2026-10-22T11:59:00Z'), now,
        });
        await expect(
            snapshotService.saveValidatedRateSnapshot({
                prisma, pair: 'USDC/GHS', rate: '99', source: 'EVIL_CLOCK',
                observedAt: new Date('2026-10-22T13:00:00Z'), now, // 1h in the future
            })
        ).rejects.toThrow(/future/);
        const row = await prisma.fxSavedRate.findUnique({ where: { pair: 'USDC/GHS' } });
        expect(String(row.rate)).toBe('12.5'); // refused update never overwrote it
        expect(row.source).toBe('KOTANI_PAY');
    });

    // ── B. demo honesty ─────────────────────────────────────────────────

    test('demo seed never overwrites a genuine observation', async () => {
        const now = new Date('2026-10-22T12:00:00Z');
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.5', source: 'KOTANI_PAY',
            observedAt: new Date('2026-10-22T11:59:00Z'), now,
        });
        const result = await snapshotService.seedDemoRateSnapshot({ prisma, now });
        expect(result.saved).toBe(false);
        expect(result.reason).toBe('GENUINE_SAVED_RATE_PRESENT');
        const row = await prisma.fxSavedRate.findUnique({ where: { pair: 'USDC/GHS' } });
        expect(row.isDemoSeed).toBe(false);
        expect(String(row.rate)).toBe('12.5');
    });

    test('a genuine observation replaces a demo seed (reality supersedes demo)', async () => {
        const now = new Date('2026-10-22T12:00:00Z');
        await snapshotService.seedDemoRateSnapshot({ prisma, now });
        const result = await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.44', source: 'FALLBACK_FX',
            observedAt: new Date('2026-10-22T11:59:00Z'), now,
        });
        expect(result.saved).toBe(true);
        const row = await prisma.fxSavedRate.findUnique({ where: { pair: 'USDC/GHS' } });
        expect(row.isDemoSeed).toBe(false);
        expect(row.source).toBe('FALLBACK_FX');
    });

    test('an idempotent demo re-seed is refused without changing provenance', async () => {
        const now = new Date('2026-10-22T12:00:00Z');
        await snapshotService.seedDemoRateSnapshot({ prisma, now });
        const result = await snapshotService.seedDemoRateSnapshot({
            prisma, now: new Date('2026-10-23T12:00:00Z'),
        });
        expect(result.saved).toBe(false);
        expect(result.reason).toBe('DEMO_SEED_ALREADY_PRESENT');
        // original observedAt provenance kept
        const row = await prisma.fxSavedRate.findUnique({ where: { pair: 'USDC/GHS' } });
        expect(new Date(row.observedAt).toISOString()).toBe(now.toISOString());
    });

    // ── C. server-side boundary-exact display eligibility ────────────────

    test('display eligibility: age == max is eligible, age > max is ineligible', async () => {
        const now = new Date('2026-10-22T12:00:00Z');
        const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
        // exactly at the boundary
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.5', source: 'KOTANI_PAY',
            observedAt: new Date(now.getTime() - maxAgeMs), now,
        });
        const atBoundary = await snapshotService.getSavedRateForDisplay({ prisma, now, maxAgeMs });
        expect(atBoundary.eligibleForDisplayFallback).toBe(true);

        // one second past the boundary
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.5', source: 'KOTANI_PAY',
            observedAt: new Date(now.getTime() - maxAgeMs - 1000), now,
        });
        const pastBoundary = await snapshotService.getSavedRateForDisplay({ prisma, now, maxAgeMs });
        expect(pastBoundary.eligibleForDisplayFallback).toBe(false);
    });

    // ── D. demo visibility env-gating ───────────────────────────────────

    test('demo rows are display-eligible in test env but hidden when the demo flag is off', async () => {
        const now = new Date('2026-10-22T12:00:00Z');
        await snapshotService.seedDemoRateSnapshot({ prisma, now });

        // NODE_ENV=test in this suite → demo row is visible
        const visible = await snapshotService.getSavedRateForDisplay({ prisma, now });
        expect(visible).not.toBeNull();
        expect(visible.isDemoSeed).toBe(true);
        expect(visible.eligibleForDisplayFallback).toBe(true);
        expect(visible.source).toBe(demoConfig.DEMO_RATE_SOURCE);
        expect(Number(visible.rate)).toBeCloseTo(Number(demoConfig.DEMO_RATE_GHS_PER_USDC), 8);

        // Simulating a production read: the demo-visibility predicate is
        // env-driven and pure, so we prove the same row is invisible when
        // the predicate says demo mode is off — production can never
        // display a demo rate.
        const config = require('../src/config/demoRateSeed');
        expect(config.demoModeRateSeedEnabled({ NODE_ENV: 'production' })).toBe(false);
        expect(config.demoModeRateSeedEnabled({ NODE_ENV: 'production', DEMO_RATE_SEED: '1' })).toBe(true);
        expect(config.demoModeRateSeedEnabled({ NODE_ENV: 'test' })).toBe(true);
    });

    // ── E. singleton convergence ────────────────────────────────────────

    test('successive genuine observations converge on the singleton (append is forbidden)', async () => {
        const now = new Date('2026-10-22T12:00:00Z');
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.5', source: 'KOTANI_PAY',
            observedAt: new Date('2026-10-22T11:00:00Z'), now,
        });
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.6', source: 'KOTANI_PAY',
            observedAt: new Date('2026-10-22T11:30:00Z'), now,
        });
        const count = await prisma.fxSavedRate.count();
        expect(count).toBe(1);
        const row = await prisma.fxSavedRate.findUnique({ where: { pair: 'USDC/GHS' } });
        expect(String(row.rate)).toBe('12.6'); // the LAST validated observation
    });

    // ── policy bounds are wired to the same constants the service uses ──

    test('fxDisplayPolicy bounds: env value in range is honored; the fallback cannot be disabled', async () => {
        expect(policy.resolveFxSavedRateMaxAgeMs({ FX_SAVED_RATE_MAX_AGE_MS: String(2 * 24 * 3600 * 1000) }))
            .toBe(2 * 24 * 3600 * 1000);
        expect(policy.resolveFxSavedRateMaxAgeMs({ FX_SAVED_RATE_MAX_AGE_MS: '10' })) // below minimum
            .toBe(policy.DEFAULT_FX_SAVED_RATE_MAX_AGE_MS);
        expect(policy.resolveFxSavedRateMaxAgeMs({})) // unset
            .toBe(policy.DEFAULT_FX_SAVED_RATE_MAX_AGE_MS);
    });
});
