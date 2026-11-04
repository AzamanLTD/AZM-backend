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
    let prisma, p2pService, resolveFeeProfile;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        p2pService = require('../services/p2p.service');
        ({ resolveFeeProfile } = require('../services/feeProfileService'));
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    beforeEach(async () => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            // feeByPaymentMethod is reset explicitly: a leftover per-method
            // override silently changes the fallback path these tests assert.
            update: { p2pFeePct: 0.01, tierThreshold: 1000, vendorShareUnder1k: 0.4, vendorShareOver1k: 0.5, feeByPaymentMethod: null },
            create: { id: 1, p2pFeePct: 0.01, tierThreshold: 1000, vendorShareUnder1k: 0.4, vendorShareOver1k: 0.5, feeByPaymentMethod: null },
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

    test('7. a VENDOR_TIER profile the vendor does not meet does not match', async () => {
        // 'VENDOR' is not a supported scope: _matchesContextSync only handles
        // VENDOR_TIER, USER_TIER, INFLUENCER_REFERRAL, HOLIDAY, CUSTOM and ALL.
        // A level-99 requirement is a real supported scope that no seeded
        // vendor can satisfy, so this proves a genuine non-match.
        await profile({ platformFeePct: 0, targetScope: 'VENDOR_TIER', targetValue: '99' });
        const s = await seedBuyTrade({ amountCrypto: 100 });

        const resolved = await resolveFeeProfile(prisma, {
            vendorId: s.vendor.id, buyerId: s.user.id, amountCrypto: 100,
        });
        expect(resolved.matchedProfile).toBe(false);

        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });
        // GlobalSettings fallback: 1% fee, 60/40 admin/vendor under 1k.
        expect(await fees()).toBeCloseTo(0.6, 6);
        expect(await B(s.vendor.id)).toBeCloseTo(99.4, 6);
    });

    test('7b. an expired profile never becomes authoritative', async () => {
        await profile({
            platformFeePct: 0, adminSplitPct: 0, vendorSplitPct: 1,
            validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
        });
        const s = await seedBuyTrade({ amountCrypto: 100 });

        const resolved = await resolveFeeProfile(prisma, {
            vendorId: s.vendor.id, buyerId: s.user.id, amountCrypto: 100,
        });
        expect(resolved.matchedProfile).toBe(false);

        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });
        expect(await fees()).toBeCloseTo(0.6, 6);
    });

    test('7c. a zero profile leaves no positive fee in ANY financial record', async () => {
        await profile({ platformFeePct: 0, adminSplitPct: 0.6, vendorSplitPct: 0.4 });
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });

        const trade = await prisma.trade.findUnique({ where: { id: s.trade.id } });
        expect(Number(trade.vendorProfitCut)).toBe(0);

        // TransactionHistory: the buyer's fee column is a real column here.
        const hist = await prisma.transactionHistory.findFirst({
            where: { userId: s.user.id, type: 'P2P_TRADE' }, orderBy: { id: 'desc' },
        });
        expect(Number(hist.feeUsdc)).toBe(0);

        // AdminProfitLog: settlement ALWAYS writes the row, so the proof is a
        // zero amount, not an absent row.
        const logs = await prisma.adminProfitLog.findMany({ where: { source: 'P2P_MARGIN' } });
        const netPositive = logs.reduce((a, l) => a + Number(l.amountUsdc), 0);
        expect(netPositive).toBe(0);

        // Authoritative ledger: an all-zero fee posts NO revenue:fees line.
        const posting = await prisma.ledgerTransaction.findUnique({
            where: { idempotencyKey: `ledger:p2p:settle:${s.trade.id}` },
            include: { journalEntries: true },
        });
        const feeLines = posting.journalEntries.filter((e) => e.account === 'revenue:fees');
        expect(feeLines.reduce((a, e) => a + Number(e.credit), 0)).toBe(0);

        // Conservation: the posting balances exactly against the principal.
        const debit = posting.journalEntries.reduce((a, e) => a + Number(e.debit), 0);
        const credit = posting.journalEntries.reduce((a, e) => a + Number(e.credit), 0);
        expect(debit).toBeCloseTo(100, 8);
        expect(credit).toBeCloseTo(100, 8);
    });

    test('7d. a non-zero fee records the same amount in every representation', async () => {
        await profile({ platformFeePct: 0.02, adminSplitPct: 0.6, vendorSplitPct: 0.4 });
        const s = await seedBuyTrade({ amountCrypto: 100 });
        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });

        // 100 * 2% = 2.00 fee -> admin 1.20, vendor 0.80
        const trade = await prisma.trade.findUnique({ where: { id: s.trade.id } });
        expect(Number(trade.vendorProfitCut)).toBeCloseTo(0.8, 6);

        const hist = await prisma.transactionHistory.findFirst({
            where: { userId: s.user.id, type: 'P2P_TRADE' }, orderBy: { id: 'desc' },
        });
        expect(Number(hist.feeUsdc)).toBeCloseTo(1.2, 6);

        const log = await prisma.adminProfitLog.findFirst({ where: { source: 'P2P_MARGIN' } });
        expect(Number(log.amountUsdc)).toBeCloseTo(1.2, 6);

        const posting = await prisma.ledgerTransaction.findUnique({
            where: { idempotencyKey: `ledger:p2p:settle:${s.trade.id}` },
            include: { journalEntries: true },
        });
        const feeCredit = posting.journalEntries
            .filter((e) => e.account === 'revenue:fees')
            .reduce((a, e) => a + Number(e.credit) - Number(e.debit), 0);
        expect(feeCredit).toBeCloseTo(1.2, 6);

        const debit = posting.journalEntries.reduce((a, e) => a + Number(e.debit), 0);
        const credit = posting.journalEntries.reduce((a, e) => a + Number(e.credit), 0);
        expect(debit).toBeCloseTo(100, 8);
        expect(credit).toBeCloseTo(100, 8);
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

        // No duplicate financial record on replay.
        expect(await prisma.ledgerTransaction.count({
            where: { idempotencyKey: `ledger:p2p:settle:${s.trade.id}` },
        })).toBe(1);
        expect(await prisma.adminProfitLog.count({ where: { source: 'P2P_MARGIN' } })).toBe(1);
        expect(await prisma.transactionHistory.count({
            where: { userId: s.user.id, type: 'P2P_TRADE' },
        })).toBe(1);
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
