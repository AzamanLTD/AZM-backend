/**
 * The 30-day revenue series is per currency, exact, and never merged.
 *
 * Regression this pins: the series was COALESCE(SUM("amountUsdc"),0) per day.
 * A native-GHS order carries no USDC amount (the DB CHECK enforces the pairing),
 * so a merchant who takes only cedis saw a chart of zeros while their money was
 * real. Equally wrong in the other direction: adding GHS amounts into that sum
 * would present cedis as dollars.
 *
 * Also pinned here: "no USDC activity" is null, not 0. A merchant who never uses
 * USDC must not be shown a row of USDC zeros on every single day.
 */
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[revenue-by-day] TEST_DATABASE_URL not set — skipping.');

describeDb('daily business revenue by currency (real PostgreSQL)', () => {
    let prisma, businessProfileId, userId;
    const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let ref = 0;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        const u = uniq();
        const user = await prisma.user.create({
            data: { username: `rbd_${u}`, email: `rbd_${u}@test.local`, password: 'x' },
        });
        userId = user.id;
        const biz = await prisma.businessProfile.create({
            data: { userId, bizId: `BIZ-${u}`.slice(0, 30), businessName: 'Daily Revenue' },
        });
        businessProfileId = biz.id;
    });

    afterAll(async () => {
        if (businessProfileId) await prisma.businessOrder.deleteMany({ where: { businessProfileId } });
        if (businessProfileId) await prisma.businessProfile.deleteMany({ where: { id: businessProfileId } });
        if (userId) await prisma.user.deleteMany({ where: { id: userId } });
        if (prisma) await prisma.$disconnect();
    });

    const reset = () => prisma.businessOrder.deleteMany({ where: { businessProfileId } });

    const order = (over = {}) => prisma.businessOrder.create({
        data: {
            businessProfileId,
            customerId: userId,
            orderRef: `RBD-${Date.now()}-${ref++}`,
            title: 'Sale',
            status: 'COMPLETED',
            ...over,
        },
    });

    const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
    const daysAgo = (n, hour = 12) => {
        const d = new Date();
        d.setUTCHours(hour, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - n);
        return d;
    };
    const series = async () => {
        const { getBusinessStats } = require('../services/businessOrderService');
        const stats = await getBusinessStats(prisma, { businessProfileId });
        return stats;
    };
    const dayOf = (stats, d) => stats.revenueByDay.find((x) => x.date === dayKey(d));

    test('a GHS-only merchant sees their own cedis on the chart, and no USDC reading', async () => {
        await reset();
        const d3 = daysAgo(3);
        await order({ currency: 'GHS', amountGhs: '25.00', createdAt: d3 });
        await order({ currency: 'GHS', amountGhs: '20.50', createdAt: d3 });

        const stats = await series();
        const day = dayOf(stats, d3);

        expect(day.byCurrency.GHS).toBe('45.50');   // 25.00 + 20.50, exact
        expect(day.byCurrency.USDC).toBeNull();     // no USDC activity, so no reading
        expect(stats.revenue.GHS).toBe('45.50');
        expect(stats.revenue.USDC).toBe('0.00000000');
        expect(stats.revenueBasis).toBe('PER_CURRENCY');
        expect(stats.revenueByDayBasis).toBe('PER_CURRENCY');

        // The legacy USDC scalar must NOT have absorbed the cedis.
        expect(stats.totalRevenue).toBe(0);
    });

    test('cedis stay exact: ten 0.10 GHS sales are 1.00, not 0.9999999', async () => {
        await reset();
        const d = daysAgo(2);
        for (let i = 0; i < 10; i += 1) {
            await order({ currency: 'GHS', amountGhs: '0.10', createdAt: d });
        }
        const stats = await series();
        expect(dayOf(stats, d).byCurrency.GHS).toBe('1.00');
        expect(stats.revenue.GHS).toBe('1.00');
    });

    test('a USDC-only merchant sees USDC and no GHS reading', async () => {
        await reset();
        const d = daysAgo(1);
        await order({ currency: 'USDC', amountUsdc: '12.50000000', createdAt: d });

        const stats = await series();
        const day = dayOf(stats, d);
        expect(day.byCurrency.USDC).toBe('12.50000000');
        expect(day.byCurrency.GHS).toBeNull();
        expect(day.revenue).toBe(12.5); // legacy scalar still means USDC
        expect(stats.revenue.GHS).toBe('0.00');
        expect(stats.revenue.USDC).toBe('12.50000000');
    });

    test('a pre-contract row (USDC amount, NULL currency) counts as USDC, never as cedis', async () => {
        await reset();
        const d = daysAgo(4);
        await order({ currency: null, amountUsdc: '7.00000000', createdAt: d });

        const stats = await series();
        const day = dayOf(stats, d);
        expect(day.byCurrency.USDC).toBe('7.00000000');
        expect(day.byCurrency.GHS).toBeNull();
    });

    test('a mixed day keeps the two apart and never adds them together', async () => {
        await reset();
        const d = daysAgo(5);
        await order({ currency: 'GHS', amountGhs: '100.00', createdAt: d });
        await order({ currency: 'USDC', amountUsdc: '4.00000000', createdAt: d });

        const stats = await series();
        const day = dayOf(stats, d);
        expect(day.byCurrency.GHS).toBe('100.00');
        expect(day.byCurrency.USDC).toBe('4.00000000');
        expect(day.revenue).toBe(4);              // legacy scalar: USDC only
        expect(stats.revenue.GHS).not.toBe(stats.revenue.USDC);
    });

    test('a row carrying both amounts is refused by a real guard, never counted', async () => {
        await reset();
        const d = daysAgo(6);
        await order({ currency: 'GHS', amountGhs: '10.00', createdAt: d });

        // A GHS tag that also carries a USDC amount. Exactly one of two guards
        // exists, depending on how the database was built:
        //   - a database carrying the currency-shape CHECK refuses the write;
        //   - a database built by `db push` (production's path) has no CHECK, so
        //     the row lands and the readers must refuse it.
        // Both are safe. Neither may ever produce a number. This asserts whichever
        // guard is actually present instead of assuming the environment.
        let dbRefused = false;
        try {
            await order({ currency: 'GHS', amountGhs: '99.00', amountUsdc: '1.00000000', createdAt: d });
        } catch (err) {
            dbRefused = /check constraint/i.test(String(err.message));
            if (!dbRefused) throw err;
        }

        if (dbRefused) {
            // The write never happened, so the honest total is the good row only.
            const stats = await series();
            expect(stats.revenue.GHS).toBe('10.00');
            expect(stats.revenue.USDC).toBe('0.00000000');
            expect(dayOf(stats, d).byCurrency.USDC).toBeNull();
        } else {
            // The row landed: both surfaces must refuse rather than guess.
            await expect(series()).rejects.toMatchObject({ code: 'ORDER_CURRENCY_CORRUPT' });
        }
    });

    test('the one figure a dashboard shows is GHS whenever cedis exist, never a merge', async () => {
        await reset();
        const d = daysAgo(3);

        // USDC-only: USDC is then the honest headline.
        await order({ currency: 'USDC', amountUsdc: '8.00000000', createdAt: d });
        let stats = await series();
        expect(stats.headline).toEqual({ currency: 'USDC', amount: '8.00000000' });

        // Add cedis: GHS takes the headline, and the two are still never summed.
        await order({ currency: 'GHS', amountGhs: '300.00', createdAt: d });
        stats = await series();
        expect(stats.headline).toEqual({ currency: 'GHS', amount: '300.00' }); // not 308
        expect(stats.revenue.GHS).toBe('300.00');
        expect(stats.revenue.USDC).toBe('8.00000000');

        // No revenue at all is null, not a zero in an assumed currency.
        await reset();
        stats = await series();
        expect(stats.headline).toBeNull();
    });

    test('the chart covers 30 days; the lifetime total still counts older sales', async () => {
        await reset();
        await order({ currency: 'GHS', amountGhs: '5.00', createdAt: daysAgo(45) });
        await order({ currency: 'GHS', amountGhs: '2.00', createdAt: daysAgo(2) });

        const stats = await series();

        // Lifetime revenue includes the 45-day-old sale: it is real money.
        expect(stats.revenue.GHS).toBe('7.00');
        // The 30-day chart starts 29 days back, so that sale is outside it.
        expect(stats.revenueByDay).toHaveLength(30);
        expect(stats.revenueByDay.some((x) => x.date === dayKey(daysAgo(45)))).toBe(false);
        expect(stats.revenueByDay.every((x) => x.date >= dayKey(daysAgo(29)))).toBe(true);

        // Empty days carry no reading at all, in either currency.
        const empty = stats.revenueByDay[0];
        expect(empty.byCurrency.GHS).toBeNull();
        expect(empty.byCurrency.USDC).toBeNull();
        expect(empty.revenue).toBe(0);
    });
});
