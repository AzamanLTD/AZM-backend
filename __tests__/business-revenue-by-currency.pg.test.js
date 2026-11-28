/**
 * Business revenue is per currency, exact, and never merged.
 *
 * The dashboard previously returned Number(sum(amountUsdc)) — a float of a sum
 * with no currency. With a GHS sale in the mix that is either silent exclusion
 * or a false equivalence between cedis and dollars. This suite fails if the two
 * ever collapse into one number, or if a total stops being exact.
 */
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[revenue-currency] TEST_DATABASE_URL not set — skipping.');

describeDb('business revenue by currency (real PostgreSQL)', () => {
    let prisma, businessProfileId, userId;
    const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        const u = uniq();
        const user = await prisma.user.create({
            data: { username: `rev_${u}`, email: `rev_${u}@test.local`, password: 'x' },
        });
        userId = user.id;
        const biz = await prisma.businessProfile.create({
            data: { userId, bizId: `BIZ-${u}`.slice(0, 30), businessName: 'Revenue Test' },
        });
        businessProfileId = biz.id;
    });

    afterAll(async () => {
        if (businessProfileId) await prisma.businessOrder.deleteMany({ where: { businessProfileId } });
        if (businessProfileId) await prisma.businessProfile.deleteMany({ where: { id: businessProfileId } });
        if (userId) await prisma.user.deleteMany({ where: { id: userId } });
        if (prisma) await prisma.$disconnect();
    });

    let ref = 0;
    const order = (over = {}) => prisma.businessOrder.create({
        data: {
            businessProfileId,
            customerId: userId,
            orderRef: `REV-${Date.now()}-${ref++}`,
            title: 'Sale',
            status: 'COMPLETED',
            ...over,
        },
    });

    test('GHS and USDC totals stay separate, exact, and unmerged', async () => {
        const { getBusinessStats } = require('../services/businessOrderService');
        await prisma.businessOrder.deleteMany({ where: { businessProfileId } });

        await order({ currency: 'GHS', amountGhs: '25.00' });      // cedis
        await order({ currency: 'GHS', amountGhs: '20.50' });      // cedis
        await order({ currency: 'USDC', amountUsdc: '10.00000000' }); // legacy shape
        await order({ currency: 'GHS', amountGhs: '999.00', status: 'AWAITING_PAYMENT' }); // not revenue

        const stats = await getBusinessStats(prisma, { businessProfileId });

        expect(stats.revenue.GHS).toBe('45.50');
        expect(stats.revenue.USDC).toBe('10.00000000');
        expect(stats.revenue.counts).toEqual({ GHS: 2, USDC: 1 });
        expect(stats.revenueBasis).toBe('PER_CURRENCY');

        // the legacy scalar means USDC only — it must not include the cedis
        expect(stats.totalRevenue).toBe(10);
        // and the averages never divide cedis by a dollar count
        expect(stats.avgOrderValueByCurrency.GHS).toBe('22.75');
        expect(stats.avgOrderValueByCurrency.USDC).toBe('10.00000000');
    });

    test('a GHS-only business reports GHS revenue and zero USDC, not a converted figure', async () => {
        const { getBusinessStats } = require('../services/businessOrderService');
        await prisma.businessOrder.deleteMany({ where: { businessProfileId } });
        await order({ currency: 'GHS', amountGhs: '120.00' });

        const stats = await getBusinessStats(prisma, { businessProfileId });
        expect(stats.revenue.GHS).toBe('120.00');
        expect(stats.revenue.USDC).toBe('0.00000000');
        expect(stats.totalRevenue).toBe(0);
        expect(stats.avgOrderValueByCurrency.USDC).toBeNull();
    });

    test('exact sums survive many small GHS amounts (no float drift)', async () => {
        const { getBusinessStats } = require('../services/businessOrderService');
        await prisma.businessOrder.deleteMany({ where: { businessProfileId } });
        // 0.10 x 10 is the classic float trap: 0.9999999999999999 in doubles
        for (let i = 0; i < 10; i += 1) await order({ currency: 'GHS', amountGhs: '0.10' });

        const stats = await getBusinessStats(prisma, { businessProfileId });
        expect(stats.revenue.GHS).toBe('1.00');
    });
});
