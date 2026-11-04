// __tests__/zero-fee-p2p-profiles.test.js
// =============================================================================
// P2P zero-value fee-profile semantics against real PostgreSQL.
//
// A matched AdminFeeProfile is authoritative, INCLUDING a legitimate 0. The
// legacy expressions (`feeProfile.platformFeePct || fallback`) treated 0 as
// "missing" and substituted GlobalSettings, which:
//   • charged a fee the operator had explicitly set to zero, and
//   • could pair a profile's vendor split with a legacy admin split, crediting
//     more than the configured fee allocation.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[zero-fee-p2p-profiles] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('P2P zero-value fee profiles (real PostgreSQL)', () => {
    let prisma, p2pService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        p2pService = require('../services/p2p.service');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    beforeEach(async () => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { p2pFeePct: 0.01, tierThreshold: 1000, vendorShareUnder1k: 0.4, vendorShareOver1k: 0.5 },
            create: { id: 1, p2pFeePct: 0.01, tierThreshold: 1000, vendorShareUnder1k: 0.4, vendorShareOver1k: 0.5 },
        });
        await prisma.adminFeeProfile.deleteMany();
        await prisma.systemProfitFees.upsert({ where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 } });
    });

    afterEach(async () => {
        // Leave no profile behind: AdminFeeProfile overrides GlobalSettings for
        // every later suite, so a leftover row would silently change their fees.
        await prisma.adminFeeProfile.deleteMany();
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Trade", "Ad", "TransactionHistory", "AdminProfitLog", "SystemProfitFees", "AuditLog", '
            + '"LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    const { seedUser, seedVendor } = require('./helpers/factories');

    async function seedBuyTrade({ amountCrypto = 100 } = {}) {
        const vendor = await seedVendor(prisma, { availableBalance: 0 });
        const user = await seedUser(prisma, { availableBalance: 0, escrowLockedBalance: amountCrypto });
        const trade = await prisma.trade.create({
            data: {
                userId: user.id, vendorId: vendor.id, type: 'BUY',
                crypto: 'USDT', amountCrypto, amountFiat: amountCrypto * 15.5,
                currency: 'GHS', rate: 15.5, paymentMethod: 'Bank Transfer',
                status: 'PAID', expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            },
        });
        return { trade, user, vendor };
    }

    const profile = (over = {}) => prisma.adminFeeProfile.create({
        data: {
            name: `p-${Math.random().toString(36).slice(2, 8)}`,
            targetScope: 'ALL', priority: 100, isActive: true,
            platformFeePct: 0.02, adminSplitPct: 0.6, vendorSplitPct: 0.4, exitFeePct: 0,
            ...over,
        },
    });

    const B = async (id) => Number((await prisma.user.findUnique({ where: { id } })).availableBalance);
    const E = async (id) => Number((await prisma.user.findUnique({ where: { id } })).escrowLockedBalance);
    const fees = async () => Number((await prisma.systemProfitFees.findUnique({ where: { id: 1 } })).balance);

    test('1. no profile: GlobalSettings percentage and tier split still apply', async () => {
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });

        expect(await B(s.vendor.id)).toBeCloseTo(99.4, 6);   // net 99 + vendor cut 0.4
        expect(await B(s.user.id)).toBeCloseTo(0, 6);        // buyer held escrow, receives no GHS-side balance
        expect(await E(s.user.id)).toBeCloseTo(0, 6);        // escrow drained exactly once
        expect(await fees()).toBeCloseTo(0.6, 6);
    });

    test('2. matched profile with platformFeePct 0 charges no fee', async () => {
        await profile({ platformFeePct: 0, adminSplitPct: 0.6, vendorSplitPct: 0.4 });
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });

        expect(await B(s.vendor.id)).toBeCloseTo(100, 6);    // no fee deducted at all
        expect(await fees()).toBeCloseTo(0, 6);
        expect(await B(s.user.id)).toBeCloseTo(0, 6);
        const t = await prisma.trade.findUnique({ where: { id: s.trade.id } });
        expect(Number(t.vendorProfitCut)).toBeCloseTo(0, 6);
    });

    test('3. matched profile fee 0.02, admin 0 / vendor 1: vendor takes the whole fee', async () => {
        await profile({ platformFeePct: 0.02, adminSplitPct: 0, vendorSplitPct: 1 });
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });

        // fee 2.00 -> vendor 2.00, admin 0, buyer 98
        expect(await B(s.vendor.id)).toBeCloseTo(100, 6);    // net 98 + entire 2.00 fee
        expect(await fees()).toBeCloseTo(0, 6);              // admin share is exactly zero
        expect(await B(s.user.id)).toBeCloseTo(0, 6);
        const t = await prisma.trade.findUnique({ where: { id: s.trade.id } });
        expect(Number(t.vendorProfitCut)).toBeCloseTo(2, 6);
    });

    test('4. matched profile fee 0.02, admin 1 / vendor 0: admin takes the whole fee', async () => {
        await profile({ platformFeePct: 0.02, adminSplitPct: 1, vendorSplitPct: 0 });
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });

        expect(await B(s.vendor.id)).toBeCloseTo(98, 6);     // net only, zero vendor cut
        expect(await fees()).toBeCloseTo(2, 6);              // entire fee to admin
    });

    test('5. a normal split still produces the previous allocation', async () => {
        await profile({ platformFeePct: 0.02, adminSplitPct: 0.6, vendorSplitPct: 0.4 });
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });

        expect(await B(s.vendor.id)).toBeCloseTo(98.8, 6);   // net 98 + vendor cut 0.8
        expect(await fees()).toBeCloseTo(1.2, 6);
    });

    test('6. an inactive profile is not applied', async () => {
        await profile({ platformFeePct: 0, isActive: false });
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });
        // falls back to GlobalSettings 1% -> vendor 0.4, fees 0.6
        expect(await B(s.vendor.id)).toBeCloseTo(99.4, 6);
        expect(await fees()).toBeCloseTo(0.6, 6);
    });

    test('7. a profile scoped to another vendor does not match this trade', async () => {
        await profile({ platformFeePct: 0, targetScope: 'VENDOR', targetValue: 'some-other-vendor-id' });
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });
        expect(await B(s.vendor.id)).toBeCloseTo(99.4, 6);
        expect(await fees()).toBeCloseTo(0.6, 6);
    });

    test('8. repeated completion cannot post the fee twice', async () => {
        await profile({ platformFeePct: 0.02, adminSplitPct: 0, vendorSplitPct: 1 });
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });
        await expect(
            p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id })
        ).rejects.toThrow();
        expect(await B(s.vendor.id)).toBeCloseTo(100, 6);
        expect(await fees()).toBeCloseTo(0, 6);
    });

    test('9. resolver distinguishes a matched zero profile from no profile at all', async () => {
        const { resolveFeeProfile } = require('../services/feeProfileService');

        const v = await seedUser(prisma, { availableBalance: 0 });
        const b = await seedUser(prisma, { availableBalance: 0 });
        const ctx = { vendorId: v.id, buyerId: b.id, amountCrypto: 100 };

        const none = await resolveFeeProfile(prisma, ctx);
        expect(none.matchedProfile).toBe(false);
        expect(none.platformFeePct).toBe(0);

        await profile({ platformFeePct: 0, adminSplitPct: 0, vendorSplitPct: 1 });
        const matched = await resolveFeeProfile(prisma, ctx);
        expect(matched.matchedProfile).toBe(true);
        expect(matched.platformFeePct).toBe(0);
        expect(matched.adminSplitPct).toBe(0);
        expect(matched.vendorSplitPct).toBe(1);
        // Same numeric platformFeePct as the no-match case: only the flag differs.
        expect(none.platformFeePct).toBe(matched.platformFeePct);
        expect(none.matchedProfile).not.toBe(matched.matchedProfile);
    });
});
