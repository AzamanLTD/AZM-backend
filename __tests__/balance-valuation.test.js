// __tests__/balance-valuation.test.js
// =============================================================================
// FX-balance workstream — authoritative balance-valuation contract proof.
//
// PROVES, with Prisma never mocked (real PostgreSQL via TEST_DATABASE_URL):
//
//   A. CURRENT: a fresh canonical rate estimates the GHS headline in USDC
//      exactly (headline = nativeGhsAvailable ONLY;
//       usdcEquivalent = nativeGhsAvailable / rate) and the USDC transaction
//      gate is OPEN.
//   B. A rate change moves ONLY the USDC estimate — the GHS headline and
//      every stored balance are untouched; the valuation is a pure read.
//   C. SAVED_FALLBACK / DEMO_FALLBACK: without a fresh rate, an eligible
//      saved observation (or the demo seed in demo/test env) produces an
//      HONEST display estimate — but the transaction gate stays CLOSED.
//   D/E. UNAVAILABLE → FX_UNAVAILABLE: the usdcEquivalent estimate is null,
//      but the GHS HEADLINE stays fully valid — a missing rate NEVER makes
//      a valid GHS balance unavailable.
//   F. Locked buckets (escrow, disputes, vaults, savings, committed Susu,
//      vendor pool) are reported in their NATIVE units and are NOT counted
//      in the available headline.
//   G. AZM loyalty points are excluded from every monetary total.
//   H. USDC held and the USDC equivalent are DISTINCT quantities.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[balance-valuation.test] TEST_DATABASE_URL not set — skipping.');

describe('Balance valuation contract (real PostgreSQL)', () => {
    if (!hasDb) return;

    let prisma;
    let valuation;
    let snapshotService;
    let { seedUser } = {};

    // Fixed evaluation clock for deterministic freshness comparisons.
    const NOW = new Date('2026-10-22T12:00:00Z');

    let originalSettings;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        valuation = require('../src/services/balanceValuationService');
        snapshotService = require('../src/services/fxRateSnapshotService');
        ({ seedUser } = require('./helpers/factories'));

        // Preserve the suite-relevant GlobalSettings fields (the oracle
        // singletons belong to other suites; restore them on exit).
        originalSettings = await prisma.globalSettings.findUnique({
            where: { id: 1 },
            select: { liveRetailRate: true, liveUsdToGhs: true, liveRateSource: true, lastExternalSync: true },
        });

        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "LedgerAccount", "JournalEntry", "User" RESTART IDENTITY CASCADE'
        );
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.fxSavedRate.deleteMany({});
            if (originalSettings) {
                await prisma.globalSettings.update({
                    where: { id: 1 },
                    data: {
                        liveRetailRate: originalSettings.liveRetailRate,
                        liveUsdToGhs: originalSettings.liveUsdToGhs,
                        liveRateSource: originalSettings.liveRateSource,
                        lastExternalSync: originalSettings.lastExternalSync,
                    },
                });
            }
            await prisma.$executeRawUnsafe(
                'TRUNCATE TABLE "LedgerTransaction", "LedgerAccount", "JournalEntry", "User" RESTART IDENTITY CASCADE'
            );
            await prisma.$disconnect();
        }
    });

    beforeEach(async () => {
        await prisma.fxSavedRate.deleteMany({});
    });

    // Rate-state helpers --------------------------------------------------

    const setFreshRate = async (rate) => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: {
                liveRetailRate: rate,
                liveUsdToGhs: rate,
                liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(NOW.getTime() - 60_000), // 1 min old: fresh
            },
            create: {
                id: 1,
                liveRetailRate: rate,
                liveUsdToGhs: rate,
                liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(NOW.getTime() - 60_000),
            },
        });
    };

    const setStaleRate = async (rate) => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: {
                liveRetailRate: rate,
                liveUsdToGhs: rate,
                liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(NOW.getTime() - 2 * 3600_000), // 2h old: stale (> 1800s max)
            },
            create: {
                id: 1,
                liveRetailRate: rate,
                liveUsdToGhs: rate,
                liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(NOW.getTime() - 2 * 3600_000),
            },
        });
    };

    const setNoRate = async () => {
        // 271C freshness is evaluated FIRST and exclusively on
        // lastExternalSync; a NULL there is RATE_UNAVAILABLE regardless of
        // any stored rate value. (liveRetailRate is NOT NULL in the schema,
        // so it keeps a positive value here that must be IGNORED.)
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: '12.5', liveUsdToGhs: '12.5', lastExternalSync: null },
            create: { id: 1, liveRetailRate: '12.5', liveUsdToGhs: '12.5', lastExternalSync: null },
        });
    };

    // ── A. CURRENT ───────────────────────────────────────────────────────

    test('fresh canonical rate: exact valuation math and an OPEN transaction gate', async () => {
        const user = await seedUser(prisma, {
            nativeGhsBalance: 50, availableBalance: 100,
        });
        await setFreshRate('12.5');
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.4', source: 'KOTANI_PAY',
            observedAt: new Date(NOW.getTime() - 60_000), now: NOW,
        });

        const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });

        expect(v.rateStatus).toBe('CURRENT');
        expect(v.valuationStatus).toBe('CURRENT');
        expect(v.currentRate.isFresh).toBe(true);
        expect(v.currentRate.rateExact).toBe('12.50000000');
        expect(v.usdcTransactionGateOpen).toBe(true);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
        // GHS-first: the headline is the native-GHS wallet balance ONLY.
        expect(v.nativeGhsAvailable.value).toBe(50);
        expect(v.availableUsdc.value).toBe(100);
        // Estimate = headline / rate = 50 / 12.5 = 4 USDC — an estimate of
        // the GHS balance's worth, NOT a combined (50 + 100×12.5) valuation.
        expect(v.usdcEquivalent.exact).toBe('4.00000000');
        expect(v.usdcEquivalent.value).not.toBe(v.availableUsdc.value);
        // display basis is the CURRENT rate
        expect(v.displayRate.basis).toBe('CURRENT');
        expect(v.displayRate.rateExact).toBe('12.50000000');
    });

    // ── B. FX moves the headline, never the money ────────────────────────

    test('a rate change moves ONLY the USDC estimate — headline and ledger untouched', async () => {
        const user = await seedUser(prisma, {
            nativeGhsBalance: 50, availableBalance: 100,
        });
        await setFreshRate('12.5');
        const v1 = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
        expect(v1.nativeGhsAvailable.value).toBe(50);
        expect(v1.usdcEquivalent.value).toBe(4); // 50 / 12.5

        await setFreshRate('13.0');
        const v2 = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
        // The headline is INVARIANT to the rate; only the estimate moves.
        expect(v2.nativeGhsAvailable.value).toBe(50);
        expect(v2.usdcEquivalent.value).toBeCloseTo(50 / 13, 6);

        // The underlying assets are byte-identical: the valuation is a pure
        // read model over unchanged money.
        const fresh = await prisma.user.findUnique({
            where: { id: user.id },
            select: { nativeGhsBalance: true, availableBalance: true },
        });
        expect(Number(fresh.nativeGhsBalance)).toBe(50);
        expect(Number(fresh.availableBalance)).toBe(100);
        expect(v2.nativeGhsAvailable.exact).toBe('50.00000000');
        expect(v2.availableUsdc.exact).toBe('100.00000000');
    });

    // ── C. saved / demo fallbacks are display-only ────────────────────────

    test('eligible saved rate: honest SAVED_FALLBACK display, CLOSED transaction gate', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 10, availableBalance: 20 });
        await setStaleRate('12.5'); // canonical exists but is STALE
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.0', source: 'KOTANI_PAY',
            observedAt: new Date(NOW.getTime() - 3600_000), now: NOW,
        });

        const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
        expect(v.rateStatus).toBe('SAVED_FALLBACK');
        expect(v.valuationStatus).toBe('SAVED_FALLBACK');
        expect(v.currentRate).toBeNull(); // a saved rate is NEVER labelled current
        expect(v.usdcTransactionGateOpen).toBe(false);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
        expect(v.usdcTransactionGateReason).toBe('NO_FRESH_CANONICAL_RATE_SAVED_FALLBACK_DISPLAY_ONLY');
        // headline 10 GHS; estimate = 10 / 12 = 0.8333...
        expect(v.nativeGhsAvailable.value).toBe(10);
        expect(v.usdcEquivalent.value).toBeCloseTo(10 / 12, 6);
        expect(v.displayRate.basis).toBe('SAVED_FALLBACK');
    });

    test('demo seed (demo/test env): DEMO_FALLBACK display at 12.03, CLOSED gate', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0, availableBalance: 100 });
        await setNoRate();
        await snapshotService.seedDemoRateSnapshot({ prisma, now: NOW });

        const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
        expect(v.rateStatus).toBe('DEMO_FALLBACK');
        expect(v.valuationStatus).toBe('DEMO_FALLBACK');
        expect(v.usdcTransactionGateOpen).toBe(false);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
        expect(v.usdcTransactionGateReason).toBe('NO_FRESH_CANONICAL_RATE_DEMO_FALLBACK_DISPLAY_ONLY');
        // headline 0 GHS; estimate of the headline = 0 / 12.03 = 0
        expect(v.nativeGhsAvailable.value).toBe(0);
        expect(v.usdcEquivalent.value).toBe(0);
        expect(v.availableUsdc.value).toBe(100); // USDC held stays separate, never reinterpreted
        expect(v.displayRate.rateExact).toBe('12.03000000');
        expect(v.displayRate.basis).toBe('DEMO_FALLBACK');
    });

    // ── D/E. honest unavailability ──────────────────────────────────────

    test('no rate + available USDC > 0: FX_UNAVAILABLE — estimate null, GHS headline still fully valid', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 30, availableBalance: 75 });
        await setNoRate();

        const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
        expect(v.rateStatus).toBe('UNAVAILABLE');
        expect(v.valuationStatus).toBe('FX_UNAVAILABLE');
        expect(v.usdcEquivalent).toBeNull();
        expect(v).not.toHaveProperty('availableGhsValue'); // combined aggregate REMOVED from the contract
        expect(v.displayRate).toBeNull();
        expect(v.usdcTransactionGateOpen).toBe(false);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
        // The native GHS component is still reported SEPARATELY and honestly
        expect(v.nativeGhsAvailable.value).toBe(30);
        expect(v.availableUsdc.value).toBe(75);
    });

    test('no rate + available USDC == 0: FX_UNAVAILABLE — headline still fully valid', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 30, availableBalance: 0 });
        await setNoRate();

        const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
        expect(v.rateStatus).toBe('UNAVAILABLE');
        expect(v.valuationStatus).toBe('FX_UNAVAILABLE');
        expect(v.nativeGhsAvailable.exact).toBe('30.00000000'); // native total remains valid
        expect(v.usdcEquivalent).toBeNull(); // nothing to estimate in USDC
        expect(v.usdcTransactionGateOpen).toBe(false);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
    });

    // ── F. locked buckets, native units, excluded from the headline ─────

    test('locked escrow/dispute/vendor buckets and seeded vault/savings/susu stay OUT of the available headline', async () => {
        const user = await seedUser(prisma, {
            nativeGhsBalance: 5, availableBalance: 40,
            escrowLockedBalance: 11, disputeEscrowBalance: 7,
            vendorUnallocatedBalance: 300, azmBalance: 999,
        });
        await setFreshRate('12.5');

        await prisma.vault.create({
            data: {
                userId: user.id, name: 'locked-vault',
                targetAmountUsdc: 25, currentAmountUsdc: 25,
                status: 'ACTIVE', rulesAcceptedAt: new Date(),
                maturityDate: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000),
            },
        });
        await prisma.savingsGoal.create({
            data: {
                userId: user.id, targetAmountGhs: 60, currentAmountGhs: 60,
                frequencyAmount: 10, status: 'ACTIVE',
            },
        });
        const group = await prisma.susuGroup.create({
            data: {
                status: 'ACTIVE', contributionUsdc: 10, frequency: 'WEEKLY',
                totalCycles: 4, startDate: new Date(),
                contractRequiredCount: 1, rotationSnapshot: { order: [] },
            },
        });
        const member = await prisma.susuMember.create({
            data: { susuGroupId: group.id, userId: user.id, cycleSlot: 1, trustScore: 1 },
        });
        const cycle = await prisma.susuCycle.create({
            data: {
                susuGroupId: group.id, cycleNumber: 1, collectionDate: new Date(),
                payoutAmount: 40, payoutUserId: user.id, status: 'COLLECTING',
            },
        });
        await prisma.susuContribution.create({
            data: {
                cycleId: cycle.id, memberId: member.id, userId: user.id,
                amountUsdc: 10, status: 'PAID',
            },
        });

        const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });

        // Locked buckets reported in NATIVE units
        expect(v.locked.escrowUsdc.value).toBe(11);
        expect(v.locked.disputesUsdc.value).toBe(7);
        expect(v.locked.vaultsUsdc.value).toBe(25);
        expect(v.locked.savingsGhs.value).toBe(60);
        expect(v.locked.committedSusuUsdc.value).toBe(10);
        expect(v.locked.vendorUnallocatedUsdc.value).toBe(300);

        // The GHS headline counts ONLY the native-GHS wallet: 5 GHS. USDC
        // held (40), every locked bucket, and AZM points are all reported
        // separately in native units — never summed into the headline.
        expect(v.nativeGhsAvailable.value).toBe(5);
        expect(v.availableUsdc.value).toBe(40);
        // AZM points are non-cash and excluded from every monetary total
        expect(v.nonCash.azmPoints.value).toBe(999);
    });

    // ── H. distinct quantities ──────────────────────────────────────────

    test('USDC held and the USDC equivalent are distinct quantities', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 25, availableBalance: 100 });
        await setFreshRate('12.5');

        const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
        // Held: 100. Estimate of the headline: 25 / 12.5 = 2
        expect(v.availableUsdc.value).toBe(100);
        expect(v.usdcEquivalent.value).toBe(2);
        expect(v.usdcEquivalent.value).not.toBe(v.availableUsdc.value);
    });

    // ── OWNER REGRESSION (contract correction, #369, 2026-10-27) ────────
    // The GHS headline is the authoritative native-GHS wallet balance ONLY.
    // nativeGhs = 100, USDC held = 500, rate = 10 → headline MUST be 100
    // and the estimated USDC equivalent of it MUST be 10 — NOT a combined
    // (100 + 500×10 = 5010 GHS → 501 USDC) valuation.
    test('GHS headline is the native balance only — never a combined valuation (owner regression)', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 100, availableBalance: 500 });
        await setFreshRate('10');

        const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
        expect(v.nativeGhsAvailable.exact).toBe('100.00000000');
        expect(v.availableUsdc.exact).toBe('500.00000000');
        expect(v.usdcEquivalent.exact).toBe('10.00000000'); // 100 / 10
        // Prove it is NOT the combined valuation (would be 5010/10 = 501).
        expect(v.usdcEquivalent.value).not.toBe((100 + 500 * 10) / 10);
        expect(v.usdcEquivalent.value).not.toBe(v.availableUsdc.value);
    });

    // The headline must be INVARIANT to any variation in actual USDC held.
    test('the GHS headline is unchanged by any variation in actual USDC held', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 100, availableBalance: 500 });
        await setFreshRate('10');
        for (const usdcHeld of [0, 17, 500, 5000]) {
            await prisma.user.update({
                where: { id: user.id },
                data: { availableBalance: usdcHeld },
            });
            const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
            expect(v.nativeGhsAvailable.exact).toBe('100.00000000');
            expect(v.usdcEquivalent.exact).toBe('10.00000000'); // estimate derives from GHS / rate
        }
    });

    // A missing FX rate must NOT make a valid GHS balance unavailable.
    test('a missing FX rate never makes a valid GHS balance unavailable', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 100, availableBalance: 500 });
        await setNoRate();

        const v = await valuation.buildBalanceValuation({ prisma, userId: user.id, now: NOW });
        expect(v.valuationStatus).toBe('FX_UNAVAILABLE');
        expect(v.nativeGhsAvailable.exact).toBe('100.00000000'); // headline fully available
        expect(v.availableUsdc.exact).toBe('500.00000000');       // USDC held stays honest
        expect(v.usdcEquivalent).toBeNull();                      // only the estimate is unavailable
    });
});
