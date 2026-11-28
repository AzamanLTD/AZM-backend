'use strict';

// =============================================================================
// PROFIT BREAKDOWN REVENUE (real PostgreSQL).
//   P1. The SQL classification on real rows: cash-out principal, profit
//       liquidations, other ARBITRAGE_SPREAD rows and the referrer's half of
//       an exit fee are left out; a negative refund row and a positive
//       isSubsidized refund row net against their source; a NULL relatedTxId
//       is revenue; rows outside the period are not read.
//   P2. GET /api/admin/profit-breakdown returns that revenue, the left-out
//       amounts, and a daily chart that adds up to the total.
// Rows use the relatedTxId templates the writers use (pinned in
// __tests__/profitRevenueService.test.js R1).
// =============================================================================

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('profit breakdown revenue (PostgreSQL)', () => {
    let prisma;
    let profitRevenue;
    let controller;

    const truncate = () => prisma.$executeRawUnsafe('TRUNCATE TABLE "AdminProfitLog", "DailySnapshot" RESTART IDENTITY CASCADE');

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        profitRevenue = require('../services/profitRevenueService');
        controller = require('../controllers/adminProfitBreakdownController');
    });
    afterAll(async () => { await prisma.$disconnect(); });
    beforeEach(async () => { await truncate(); }, 15000);
    afterEach(async () => { await truncate(); }, 15000);

    const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

    async function seed() {
        const at = hoursAgo(30);
        await prisma.adminProfitLog.createMany({
            data: [
                // A referred customer's settled 1000 USDC cash-out with a 20 fee.
                { amountUsdc: '10', source: 'EXIT_FEE', relatedTxId: 'referral_split_system_WD-1', createdAt: at },
                { amountUsdc: '10', source: 'EXIT_FEE', relatedTxId: 'referral_split_referrer_42_WD-1', createdAt: at },
                { amountUsdc: '1000', source: 'ARBITRAGE_SPREAD', relatedTxId: 'arbitrage_capture_WD-1', createdAt: at },
                // An unreferred cash-out: the whole fee is Azaman's.
                { amountUsdc: '4', source: 'EXIT_FEE', relatedTxId: 'full_fee_WD-2', createdAt: at },
                { amountUsdc: '200', source: 'ARBITRAGE_SPREAD', relatedTxId: 'arbitrage_capture_WD-2', createdAt: at },
                // A profit liquidation and an ARBITRAGE_SPREAD row of unknown origin.
                { amountUsdc: '7', source: 'ARBITRAGE_SPREAD', relatedTxId: 'liquidation_admin_1_1764000000000', createdAt: at },
                { amountUsdc: '3', source: 'ARBITRAGE_SPREAD', relatedTxId: null, createdAt: at },
                // A stay fee refunded with a negative row.
                { amountUsdc: '2.5', source: 'SMART_ESCROW_FEE', relatedTxId: 'booking_fee_T1_R1', createdAt: at },
                { amountUsdc: '-2.5', source: 'SMART_ESCROW_FEE', relatedTxId: 'booking_fee_refund_E1', createdAt: hoursAgo(2) },
                // A crypto withdrawal charge refunded with a positive isSubsidized row.
                { amountUsdc: '0.0275', source: 'GAS_FEE_REVENUE', relatedTxId: 'crypto_withdraw_charge_9', createdAt: hoursAgo(2) },
                { amountUsdc: '0.0275', source: 'GAS_FEE_REVENUE', relatedTxId: 'crypto_withdraw_refund_9', isSubsidized: true, createdAt: hoursAgo(2) },
                // A P2P trade with no relatedTxId (still revenue).
                { amountUsdc: '1.2', source: 'P2P_MARGIN', relatedTxId: null, createdAt: hoursAgo(2) },
                // Outside a 7-day window.
                { amountUsdc: '99', source: 'P2P_MARGIN', relatedTxId: 'trade_complete_old', createdAt: hoursAgo(24 * 10) },
            ],
        });
    }

    test('P1 the SQL leaves out non-revenue rows and nets refunds', async () => {
        await seed();
        const now = new Date();
        const out = await profitRevenue.readRevenue(prisma, { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), to: now });

        expect(out.sourceBreakdown).toEqual({
            EXIT_FEE: { totalUsdc: 14, count: 2, grossUsdc: 14, reversedUsdc: 0, reversalCount: 0 },
            GAS_FEE_REVENUE: { totalUsdc: 0, count: 1, grossUsdc: 0.0275, reversedUsdc: 0.0275, reversalCount: 1 },
            P2P_MARGIN: { totalUsdc: 1.2, count: 1, grossUsdc: 1.2, reversedUsdc: 0, reversalCount: 0 },
            SMART_ESCROW_FEE: { totalUsdc: 0, count: 1, grossUsdc: 2.5, reversedUsdc: 2.5, reversalCount: 1 },
        });
        expect(out.totalUsdc).toBe(15.2);
        expect(out.count).toBe(5);
        expect(out.reversals).toEqual({ totalUsdc: 2.5275, count: 2 });
        expect(out.excluded.items.map(({ key, totalUsdc, count }) => ({ key, totalUsdc, count }))).toEqual([
            { key: 'WITHDRAWAL_PRINCIPAL', totalUsdc: 1200, count: 2 },
            { key: 'PROFIT_LIQUIDATION', totalUsdc: 7, count: 1 },
            { key: 'ARBITRAGE_SPREAD_OTHER', totalUsdc: 3, count: 1 },
            { key: 'REFERRER_PAYOUT', totalUsdc: 10, count: 1 },
        ]);
        expect(out.excluded.totalUsdc).toBe(1220);
    });

    test('P2 the endpoint reports revenue, the left-out amounts and a chart that adds up', async () => {
        await seed();
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
        await controller.getProfitBreakdown({ app: { get: () => prisma }, query: { period: '7d' } }, res);

        expect(res.status).toHaveBeenCalledWith(200);
        const data = res.json.mock.calls[0][0].data;
        expect(data.totalProfit).toBe(15.2);
        expect(data.totalTransactions).toBe(5);
        expect(data.sourceBreakdown.ARBITRAGE_SPREAD).toBeUndefined();
        expect(data.excluded.totalUsdc).toBe(1220);
        expect(data.dailyPnl).toHaveLength(8);
        const sum = data.dailyPnl.reduce((s, d) => s + d.profit, 0);
        expect(sum).toBeCloseTo(15.2, 8);
    });
});
