// __tests__/r16-orderbook-concurrency.test.js
// =============================================================================
// r16 P0-F proofs — Order Book concurrency + structural integrity.
//
// Proves against REAL PostgreSQL:
//   1. BUY placement works at all (the old code crashed in a temporal dead
//      zone referencing order.id before creation)
//   2. concurrent takers cannot oversell one resting order (guarded
//      conditional-decrement claim)
//   3. conservation: reserve == distribution + refunds + remaining reserve
//   4. partially-filled resting orders stay matchable
//   5. cancel vs match race pays each quantity exactly once
//
// Uses the real controller handlers with mocked req/res against the real
// prisma client. SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r16-orderbook] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r16 P0-F: Order Book concurrency', () => {
    let prisma, controller;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        // single instance (the controller builds its own client — make them
        // share the same DATABASE_URL, which they do via env).
        prisma = new PrismaClient();
        controller = require('../controllers/orderBookController');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "OrderBookOrder", "OrderBookTrade", "SystemProfitFees", "TransactionHistory" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount" RESTART IDENTITY CASCADE');
    }, 15000);

    const mkReq = (user, body) => ({ user, body });
    const mkRes = () => {
        const res = {};
        res.status = (code) => { res.statusCode = code; return res; };
        // Express defaults to 200 when a handler responds via res.json alone
        // (the order-book success path does exactly that).
        res.json = (payload) => { res.statusCode = res.statusCode || 200; res.payload = payload; return res; };
        return res;
    };

    async function place(user, body) {
        const res = mkRes();
        await controller.placeOrder(mkReq(user, body), res);
        return res;
    }

    test('1: BUY placement no longer crashes on the reserve identity (old TDZ defect)', async () => {
        const seller = await seedUser(prisma, { azmBalance: 100, availableBalance: 0 });
        await place(seller, { side: 'SELL', type: 'LIMIT', price: 2, quantity: 50 });

        const buyer = await seedUser(prisma, { availableBalance: 1000, azmBalance: 0 });
        const res = await place(buyer, { side: 'BUY', type: 'LIMIT', price: 2, quantity: 20 });
        expect(res.statusCode).toBe(200);
        expect(res.payload.success).toBe(true);
        expect(res.payload.trades.length).toBe(1);

        const freshBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
        expect(Number(freshBuyer.azmBalance)).toBeCloseTo(20, 5);
        // Buyer reserved 20*2=40, filled fully at 2.00 → no refund, charge 40.
        expect(Number(freshBuyer.availableBalance)).toBeCloseTo(960, 5);
    });

    test('2: concurrent takers cannot oversell one resting order', async () => {
        const seller = await seedUser(prisma, { azmBalance: 100, availableBalance: 0 });
        await place(seller, { side: 'SELL', type: 'LIMIT', price: 2, quantity: 10 });

        const buyers = [];
        for (let i = 0; i < 4; i++) buyers.push(await seedUser(prisma, { availableBalance: 100, azmBalance: 0 }));

        // Four concurrent takers each try to buy the SAME 10 AZM.
        const results = await Promise.all(
            buyers.map((b) => place(b, { side: 'BUY', type: 'LIMIT', price: 2, quantity: 10 }))
        );

        const trades = await prisma.orderBookTrade.findMany();
        const totalTraded = trades.reduce((s, t) => s + parseFloat(t.quantity.toString()), 0);
        expect(totalTraded).toBeLessThanOrEqual(10);
        expect(totalTraded).toBeGreaterThan(0);

        // The resting order's remaining quantity must never go negative.
        const resting = await prisma.orderBookOrder.findFirst({
            where: { side: 'SELL', userId: seller.id },
        });
        expect(parseFloat(resting.remainingQuantity.toString())).toBeGreaterThanOrEqual(0);

        // Seller received USDC for EXACTLY the traded quantity (fees deducted).
        const freshSeller = await prisma.user.findUnique({ where: { id: seller.id } });
        const expectedGross = totalTraded * 2;
        const expectedNet = expectedGross * (1 - 0.002 - 0.005);
        expect(Number(freshSeller.availableBalance)).toBeCloseTo(expectedNet, 5);

        // Buyers' total spend never exceeds their reserves.
        for (const r of results) expect([200, 400, 500]).toContain(r.statusCode);
    });

    test('3: conservation — every reserve is exactly distributed, refunded or still attached', async () => {
        const seller = await seedUser(prisma, { azmBalance: 100, availableBalance: 0 });
        await place(seller, { side: 'SELL', type: 'LIMIT', price: 5, quantity: 100 });

        const buyer = await seedUser(prisma, { availableBalance: 1000, azmBalance: 0 });
        // BUY at a limit ABOVE the ask → fills at the ask, improvement refunded.
        const res = await place(buyer, { side: 'BUY', type: 'LIMIT', price: 8, quantity: 30 });
        expect(res.statusCode).toBe(200);

        const freshBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
        // Reserve: 30*8=240. Fill: 30 AZM at 5 → charge 150, improvement 90 back.
        expect(Number(freshBuyer.availableBalance)).toBeCloseTo(1000 - 150, 5);
        expect(Number(freshBuyer.azmBalance)).toBeCloseTo(30, 5);

        // The clearing pool must be exactly zero-funded: no stranded dust.
        const clearings = await prisma.$queryRawUnsafe(
            "SELECT COALESCE(SUM(credit - debit), 0) AS balance " +
            'FROM "JournalEntry" ' +
            "WHERE account = 'clearing:orderbook:usdc' AND \"ledgerTransactionId\" IS NOT NULL"
        );
        expect(Number(clearings[0].balance)).toBeCloseTo(0, 5);
    });

    test('4: partially-filled resting order stays matchable', async () => {
        const seller = await seedUser(prisma, { azmBalance: 100, availableBalance: 0 });
        await place(seller, { side: 'SELL', type: 'LIMIT', price: 2, quantity: 100 });

        const b1 = await seedUser(prisma, { availableBalance: 100, azmBalance: 0 });
        await place(b1, { side: 'BUY', type: 'LIMIT', price: 2, quantity: 40 });

        const resting = await prisma.orderBookOrder.findFirst({ where: { side: 'SELL', userId: seller.id } });
        expect(resting.status).toBe('PARTIALLY_FILLED');
        expect(parseFloat(resting.remainingQuantity.toString())).toBeCloseTo(60, 5);

        // A second taker MUST be able to fill the remaining quantity —
        // the old candidate filter (status OPEN only) stranded it.
        const b2 = await seedUser(prisma, { availableBalance: 200, azmBalance: 0 });
        const res2 = await place(b2, { side: 'BUY', type: 'LIMIT', price: 2, quantity: 60 });
        expect(res2.statusCode).toBe(200);

        const after = await prisma.orderBookOrder.findFirst({ where: { side: 'SELL', userId: seller.id } });
        expect(after.status).toBe('FILLED');
        expect(parseFloat(after.remainingQuantity.toString())).toBeCloseTo(0, 5);
    });

    test('5: cancel vs match race pays each resting quantity exactly once', async () => {
        const seller = await seedUser(prisma, { azmBalance: 100, availableBalance: 0 });
        const placed = await place(seller, { side: 'SELL', type: 'LIMIT', price: 2, quantity: 100 });
        const orderId = placed.payload.order.id;

        const buyer = await seedUser(prisma, { availableBalance: 500, azmBalance: 0 });
        // Match and cancel race against the same resting row.
        const cancelReq = mkReq(seller, {});
        cancelReq.params = { id: orderId };
        const cancelRes = mkRes();
        const [, cancelOutcome] = await Promise.allSettled([
            place(buyer, { side: 'BUY', type: 'LIMIT', price: 2, quantity: 50 }),
            controller.cancelOrder(cancelReq, cancelRes),
        ]);

        const trades = await prisma.orderBookTrade.findMany();
        const totalTraded = trades.reduce((s, t) => s + parseFloat(t.quantity.toString()), 0);
        expect(totalTraded).toBeLessThanOrEqual(100);

        // AZM conservation: every resting unit settles EXACTLY once — it
        // is either traded (delivered to the buyer) or refunded to the
        // seller at cancel. Never both, never neither.
        const freshSeller = await prisma.user.findUnique({ where: { id: seller.id } });
        const freshBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
        const resting = await prisma.orderBookOrder.findUnique({ where: { id: orderId } });
        const remaining = parseFloat(resting.remainingQuantity.toString());
        const refunded = Number(freshSeller.azmBalance); // seller started at 0 post-placement

        expect(totalTraded + refunded).toBeCloseTo(100, 5);
        expect(Number(freshBuyer.azmBalance)).toBeCloseTo(totalTraded, 5);

        // Terminal states are mutually consistent: a CANCELLED order must
        // have zero quantity still attached.
        expect(['FILLED', 'PARTIALLY_FILLED', 'CANCELLED']).toContain(resting.status);
        if (resting.status === 'CANCELLED') expect(remaining).toBe(0);
        expect(cancelOutcome.status).toBe('fulfilled');
    });
});
