// __tests__/p2p-settlement-integrity.test.js
// =============================================================================
// P0 — P2P escrow settlement integrity (markUnderpaid / flagOverpayment /
// completeTrade) against real PostgreSQL. Every escrow debit is a guarded
// conditional claim inside the settlement transaction; every settlement has
// exactly one winner under concurrency; every downstream failure rolls the
// whole transaction back; replay after commit moves no money.
//
// Escrow direction is the AUTHORITATIVE tradeController accept-flow:
//   SELL ad → vendor's pool locked (vendor holds escrow; buyer paid fiat)
//   BUY ad  → trade.userId's balance locked (user holds escrow; vendor paid fiat)
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p2p-settlement-integrity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('P2P escrow settlement integrity (real PostgreSQL)', () => {
    let prisma, p2pService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV     = 'test';
        process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma      = new PrismaClient();
        p2pService  = require('../services/p2p.service');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    beforeEach(async () => {
        await prisma.globalSettings.upsert({
            where:  { id: 1 },
            update: { p2pFeePct: 1, tierThreshold: 1000, vendorShareUnder1k: 0.4, vendorShareOver1k: 0.5 },
            create: { id: 1, p2pFeePct: 1, tierThreshold: 1000, vendorShareUnder1k: 0.4, vendorShareOver1k: 0.5 },
        });
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Trade", "Ad", "TransactionHistory", "AdminProfitLog", "SystemProfitFees", "AuditLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    const { seedUser, seedVendor, seedPaidTrade } = require('./helpers/factories');

    async function seedBuyTrade({ amountCrypto = 100 } = {}) {
        const vendor = await seedVendor(prisma, { availableBalance: 0 });
        const user   = await seedUser(prisma, { availableBalance: 0, escrowLockedBalance: amountCrypto });
        const trade = await prisma.trade.create({
            data: {
                userId: user.id, vendorId: vendor.id, type: 'BUY',
                crypto: 'USDT', amountCrypto, amountFiat: amountCrypto * 15.5,
                currency: 'GHS', rate: 15.5, paymentMethod: 'Bank Transfer',
                status: 'PAID', expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            },
        });
        return { trade, user, vendor, amountCrypto };
    }

    const userById = async (id) => prisma.user.findUnique({ where: { id } });
    const B = (u) => Number(u.availableBalance);
    const E = (u) => Number(u.escrowLockedBalance);

    // ── completeTrade ───────────────────────────────────────────────────────
    test('1. completeTrade SELL: vendor escrow drained once, buyer receives the net', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });

        await p2pService.completeTrade(prisma, {
            tradeId: seed.tradeId, releasedByUserId: seed.releasedByUserId,
        });

        const vendor = await userById(seed.vendorId);
        const buyer   = await userById(seed.buyerId);

        // fee profile fallback: settings p2pFeePct=1, vendorShare 0.4
        // totalFee=1, adminCut=0.6, vendorCut=0.4, net=99
        expect(E(vendor)).toBeCloseTo(0, 6);           // escrow released exactly once
        expect(vendor.tradesCompleted).toBe(1);
        expect(B(buyer)).toBeCloseTo(99, 6);           // fiat payer receives the net
        expect(B(vendor)).toBeCloseTo(0.4, 6);         // vendor margin share
        expect(E(buyer)).toBeCloseTo(0, 6);            // buyer never had escrow — not debited

        // Conservation: 99 + 0.4 + 0.6 === 100
        const fees = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
        expect(Number(fees.balance)).toBeCloseTo(0.6, 6);

        const trade = await prisma.trade.findUnique({ where: { id: seed.tradeId } });
        expect(trade.status).toBe('COMPLETED');
        expect(Number(trade.vendorProfitCut)).toBeCloseTo(0.4, 6);
    });

    test('2. completeTrade BUY: user escrow drained once, vendor receives net + vendor cut', async () => {
        const s = await seedBuyTrade({ amountCrypto: 100 });

        await p2pService.completeTrade(prisma, { tradeId: s.trade.id, releasedByUserId: s.user.id });

        const user = await userById(s.user.id);
        const vendor = await userById(s.vendor.id);

        expect(E(user)).toBeCloseTo(0, 6);
        expect(B(vendor)).toBeCloseTo(99.4, 6);       // net 99 + vendor cut 0.4
        expect(vendor.tradesCompleted).toBe(1);
        expect(B(user)).toBeCloseTo(0, 6);

        const trade = await prisma.trade.findUnique({ where: { id: s.trade.id } });
        expect(trade.status).toBe('COMPLETED');
    });

    test('3. completeTrade concurrent duplicate: exactly one settlement', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });

        const call = () => p2pService.completeTrade(prisma, {
            tradeId: seed.tradeId, releasedByUserId: seed.releasedByUserId,
        }).then(() => ({ ok: true })).catch((e) => ({ ok: false, e }));

        const outcomes = await Promise.all([call(), call()]);
        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);

        const vendor = await userById(seed.vendorId);
        const buyer   = await userById(seed.buyerId);
        expect(E(vendor)).toBeCloseTo(0, 6);           // drained exactly once
        expect(B(buyer)).toBeCloseTo(99, 6);           // credited exactly once
        expect(B(vendor)).toBeCloseTo(0.4, 6);

        const fees = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
        expect(Number(fees.balance)).toBeCloseTo(0.6, 6); // fee booked exactly once
    });

    test('4. completeTrade insufficient escrow: whole settlement rolls back', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });
        // Starve the escrow bucket after seeding — the guarded claim must lose.
        await prisma.user.update({
            where: { id: seed.vendorId }, data: { escrowLockedBalance: 50 },
        });

        await expect(p2pService.completeTrade(prisma, {
            tradeId: seed.tradeId, releasedByUserId: seed.releasedByUserId,
        })).rejects.toThrow('ESCROW_INSUFFICIENT_FUNDS');

        const trade = await prisma.trade.findUnique({ where: { id: seed.tradeId } });
        expect(trade.status).toBe('PAID');             // claim rolled back

        const vendor = await userById(seed.vendorId);
        const buyer   = await userById(seed.buyerId);
        expect(E(vendor)).toBeCloseTo(50, 6);
        expect(B(buyer)).toBeCloseTo(0, 6);            // no credit without a won claim
        expect(vendor.tradesCompleted).toBe(0);
    });

    test('5. completeTrade downstream failure rolls back money + trade state', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });
        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION _azm_forbid_profit_log() RETURNS trigger AS
            $$ BEGIN RAISE EXCEPTION 'forced profit-log failure'; END $$ LANGUAGE plpgsql;
        `);
        await prisma.$executeRawUnsafe(
            `CREATE TRIGGER _azm_fail_plog BEFORE INSERT ON "AdminProfitLog" FOR EACH ROW EXECUTE FUNCTION _azm_forbid_profit_log();`
        );
        try {
            await expect(p2pService.completeTrade(prisma, {
                tradeId: seed.tradeId, releasedByUserId: seed.releasedByUserId,
            })).rejects.toThrow();

            const trade = await prisma.trade.findUnique({ where: { id: seed.tradeId } });
            expect(trade.status).toBe('PAID');
            const vendor = await userById(seed.vendorId);
            const buyer   = await userById(seed.buyerId);
            expect(E(vendor)).toBeCloseTo(100, 6);
            expect(B(buyer)).toBeCloseTo(0, 6);
        } finally {
            await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS _azm_fail_plog ON "AdminProfitLog"');
            await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS _azm_forbid_profit_log()');
        }
    });

    // ── markUnderpaid ───────────────────────────────────────────────────────
    test('6. markUnderpaid SELL: paid portion to buyer, unpaid refunded from the vendor escrow', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });

        await p2pService.markUnderpaid(prisma, {
            tradeId: seed.tradeId, callerUserId: seed.vendorId,
            paidAmountFiat: 775, intentional: false,   // half of amountFiat (100 * 15.5 / 2 = 775)
        });

        const vendor = await userById(seed.vendorId);
        const buyer   = await userById(seed.buyerId);
        expect(B(buyer)).toBeCloseTo(50, 6);           // paid portion credited to the fiat payer
        expect(E(vendor)).toBeCloseTo(0, 6);           // FULL principal leaves the escrow
        expect(B(vendor)).toBeCloseTo(50, 6);           // unpaid portion returned to the escrow owner
        expect(E(buyer)).toBeCloseTo(0, 6);

        const trade = await prisma.trade.findUnique({ where: { id: seed.tradeId } });
        expect(trade.status).toBe('CANCELLED');
    });

    test('7. markUnderpaid BUY: paid portion to vendor, unpaid refunded to the user escrow owner', async () => {
        const s = await seedBuyTrade({ amountCrypto: 100 });

        await p2pService.markUnderpaid(prisma, {
            tradeId: s.trade.id, callerUserId: s.vendorId,
            paidAmountFiat: 775, intentional: false,
        });

        const vendor = await userById(s.vendor.id);
        const user   = await userById(s.user.id);
        expect(B(vendor)).toBeCloseTo(50, 6);           // paid portion to the fiat payer
        expect(E(user)).toBeCloseTo(0, 6);               // FULL principal leaves the escrow
        expect(B(user)).toBeCloseTo(50, 6);              // unpaid portion returned to the escrow owner
        expect(E(vendor)).toBeCloseTo(0, 6);

        const trade = await prisma.trade.findUnique({ where: { id: s.trade.id } });
        expect(trade.status).toBe('CANCELLED');
    });

    test('8. markUnderpaid concurrent duplicate: exactly one settlement', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });

        const call = () => p2pService.markUnderpaid(prisma, {
            tradeId: seed.tradeId, callerUserId: seed.vendorId,
            paidAmountFiat: 775, intentional: false,
        }).then(() => ({ ok: true })).catch((e) => ({ ok: false, e }));

        const outcomes = await Promise.all([call(), call()]);
        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);

        const vendor = await userById(seed.vendorId);
        const buyer   = await userById(seed.buyerId);
        expect(B(buyer)).toBeCloseTo(50, 6);
        expect(E(vendor)).toBeCloseTo(0, 6);
        expect(B(vendor)).toBeCloseTo(50, 6);
    });

    test('9. markUnderpaid insufficient escrow: throws and rolls back', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });
        await prisma.user.update({
            where: { id: seed.vendorId }, data: { escrowLockedBalance: 1 },
        });

        await expect(p2pService.markUnderpaid(prisma, {
            tradeId: seed.tradeId, callerUserId: seed.vendorId,
            paidAmountFiat: 775, intentional: false,
        })).rejects.toThrow('ESCROW_INSUFFICIENT_FUNDS');

        const trade = await prisma.trade.findUnique({ where: { id: seed.tradeId } });
        expect(trade.status).toBe('PAID');
        const buyer = await userById(seed.buyerId);
        expect(B(buyer)).toBeCloseTo(0, 6);
    });

    test('10. markUnderpaid authority: a non-vendor non-admin caller is rejected', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });
        const stranger = await seedUser(prisma, { role: 'USER' });

        await expect(p2pService.markUnderpaid(prisma, {
            tradeId: seed.tradeId, callerUserId: stranger.id,
            paidAmountFiat: 775, intentional: false,
        })).rejects.toThrow('Only the vendor or an admin');

        const trade = await prisma.trade.findUnique({ where: { id: seed.tradeId } });
        expect(trade.status).toBe('PAID');
    });

    // ── flagOverpayment ─────────────────────────────────────────────────────
    test('11. flagOverpayment: guarded split drains + dispute escrow credit, one winner under concurrency', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });
        await prisma.user.update({
            where: { id: seed.vendorId },
            data:  { vendorUnallocatedBalance: 5, availableBalance: 100 },
        });

        const call = () => p2pService.flagOverpayment(prisma, {
            tradeId: seed.tradeId, buyerId: seed.buyerId, overpaidAmountUsdc: 20,
        }).then(() => ({ ok: true })).catch((e) => ({ ok: false, e }));

        const outcomes = await Promise.all([call(), call()]);
        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);

        const vendor = await userById(seed.vendorId);
        const buyer   = await userById(seed.buyerId);
        // Drained exactly once: 5 from unallocated + 15 from available.
        expect(Number(vendor.vendorUnallocatedBalance)).toBeCloseTo(0, 6);
        expect(B(vendor)).toBeCloseTo(85, 6);
        expect(Number(vendor.disputeEscrowBalance)).toBeCloseTo(20, 6);
        expect(B(buyer)).toBeCloseTo(0, 6);

        const trade = await prisma.trade.findUnique({ where: { id: seed.tradeId } });
        expect(trade.status).toBe('DISPUTED');
    });

    test('12. flagOverpayment insufficient combined balance: throws, nothing frozen', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });
        await prisma.user.update({
            where: { id: seed.vendorId },
            data:  { vendorUnallocatedBalance: 0, availableBalance: 10 },
        });

        await expect(p2pService.flagOverpayment(prisma, {
            tradeId: seed.tradeId, buyerId: seed.buyerId, overpaidAmountUsdc: 20,
        })).rejects.toThrow();

        const vendor = await userById(seed.vendorId);
        expect(B(vendor)).toBeCloseTo(10, 6);
        expect(Number(vendor.disputeEscrowBalance)).toBeCloseTo(0, 6);
        const trade = await prisma.trade.findUnique({ where: { id: seed.tradeId } });
        expect(trade.status).toBe('PAID');
    });

    test('13. flagOverpayment authority: only the buyer can flag', async () => {
        const seed = await seedPaidTrade(prisma, { amountCrypto: 100 });
        await prisma.user.update({
            where: { id: seed.vendorId }, data: { vendorUnallocatedBalance: 50 },
        });

        await expect(p2pService.flagOverpayment(prisma, {
            tradeId: seed.tradeId, buyerId: seed.vendorId, overpaidAmountUsdc: 20,
        })).rejects.toThrow('Only the buyer');

        const vendor = await userById(seed.vendorId);
        expect(Number(vendor.disputeEscrowBalance)).toBeCloseTo(0, 6);
    });
});
