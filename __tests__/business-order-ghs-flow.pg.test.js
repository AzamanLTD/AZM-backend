/**
 * The bounded native-GHS business flow, end to end on real PostgreSQL.
 *
 * WHAT THIS PROVES: a Ghanaian merchant who has never touched USDC can price a
 * product in cedis and take a real order for it, with the amount computed from
 * their own confirmed price — never from a client-supplied number, never from a
 * conversion, and never written into a USDC column. Every fixture here carries a
 * legacy `priceUsdc` on purpose, so "the cedi price wins" is verified rather than
 * assumed, and the merchant's read surface is checked to report cedis as the
 * headline with no merged GHS+USDC total anywhere.
 */
const { PrismaClient, Prisma } = require('@prisma/client');

const url = process.env.TEST_DATABASE_URL;
if (!url) console.warn('[ghs-order-flow] TEST_DATABASE_URL not set — skipping.');
const run = url ? describe : describe.skip;

const orderSvc = require('../services/businessOrderService');
const priceSvc = require('../services/businessPriceService');

run('native-GHS business order flow (real PostgreSQL)', () => {
    let db;
    let seq = 0;

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        await db.$disconnect();
    });

    beforeEach(async () => {
        await db.businessOrder.deleteMany({ where: { title: { startsWith: 'GHS Flow Test' } } });
        await db.businessPrice.deleteMany({});
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'ghs-flow-test-' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'GHS Flow Test Business' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'ghs-flow-test-user' } } });
    });

    // A merchant with a legacy USDC price on the product (which the GHS path must
    // ignore) and a customer. Neither needs any USDC balance or USDC history.
    async function seedMerchant() {
        seq += 1;
        const owner = await db.user.create({
            data: { username: `ghs-flow-test-user-${seq}-${Date.now()}`, email: `ghs-flow-${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const customer = await db.user.create({
            data: { username: `ghs-flow-test-user-c${seq}-${Date.now()}`, email: `ghs-flow-c${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `GHS Flow Test Business ${seq}`,
                bizId: `BIZ-GHSF-${seq}-${String(Date.now()).slice(-6)}`,
                category: 'FOOD_BEVERAGE',
            },
        });
        const product = await db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: `GHS flow test product ${seq}`,
                slug: `ghs-flow-test-${seq}-${Date.now()}`,
                priceUsdc: new Prisma.Decimal('10.50'), // legacy USDC price, must not be used
            },
        });
        return { owner, customer, profile, product };
    }

    async function setGhsPrice(productId, amountGhs, confirm = true) {
        return db.$transaction((tx) => priceSvc.setPrice(tx, {
            businessProductId: productId,
            amountGhs,
            confirmedByType: 'BUSINESS',
            confirmedById: 'test-owner',
            confirm,
        }));
    }

    test('a merchant with only a cedi price can take an order, and no USDC amount is written', async () => {
        const { customer, profile, product } = await seedMerchant();
        await setGhsPrice(product.id, '25.00');

        const order = await orderSvc.createGhsOrder(db, {
            businessProfileId: profile.id,
            customerId: customer.id,
            productId: product.id,
            title: 'GHS Flow Test order jollof',
        });

        expect(order.currency).toBe('GHS');
        expect(new Prisma.Decimal(order.amountGhs).equals(25)).toBe(true);
        expect(order.amountUsdc).toBeNull();
        expect(order.status).toBe('AWAITING_PAYMENT');

        // Re-read from the table: the persisted row must agree with what was returned.
        const [row] = await db.$queryRawUnsafe(
            `SELECT "currency", "amountGhs"::text AS amount_ghs, "amountUsdc" FROM "BusinessOrder" WHERE id = $1`, order.id);
        expect(row.currency).toBe('GHS');
        // ::text, because Prisma renders the Decimal canonically ("25") while the
        // column holds 2dp ("25.00"). The stored value is what matters here.
        expect(row.amount_ghs).toBe('25.00');
        expect(row.amountUsdc).toBeNull();
    });

    test('the total is exact: a 0.10 cedi price times three is exactly 0.30, never 0.30000000000000004', async () => {
        const { customer, profile, product } = await seedMerchant();
        await setGhsPrice(product.id, '0.10');

        const order = await orderSvc.createGhsOrder(db, {
            businessProfileId: profile.id,
            customerId: customer.id,
            productId: product.id,
            quantity: 3,
            title: 'GHS Flow Test order penny',
        });

        const [row] = await db.$queryRawUnsafe(
            `SELECT "amountGhs"::text AS amount FROM "BusinessOrder" WHERE id = $1`, order.id);
        expect(row.amount).toBe('0.30');
    });

    test('a large cedi total stays exact and never loses pesewas to float error', async () => {
        const { customer, profile, product } = await seedMerchant();
        await setGhsPrice(product.id, '9999999.99');

        const order = await orderSvc.createGhsOrder(db, {
            businessProfileId: profile.id,
            customerId: customer.id,
            productId: product.id,
            quantity: 3,
            title: 'GHS Flow Test order large',
        });

        const [row] = await db.$queryRawUnsafe(
            `SELECT "amountGhs"::text AS amount FROM "BusinessOrder" WHERE id = $1`, order.id);
        expect(row.amount).toBe('29999999.97');
    });

    test('a caller cannot dictate the price: a supplied amount is ignored in favour of the confirmed cedi price', async () => {
        const { customer, profile, product } = await seedMerchant();
        await setGhsPrice(product.id, '40.00');

        const order = await orderSvc.createGhsOrder(db, {
            businessProfileId: profile.id,
            customerId: customer.id,
            productId: product.id,
            title: 'GHS Flow Test order spoof',
            // Hostile caller input: must have no effect at all.
            amountGhs: '0.01',
            amountUsdc: 0.01,
        });

        expect(new Prisma.Decimal(order.amountGhs).equals(40)).toBe(true);
        expect(order.amountUsdc).toBeNull();
    });

    test('a product with no confirmed cedi price is REFUSED — it is never quietly priced in USDC', async () => {
        const { customer, profile, product } = await seedMerchant(); // has priceUsdc 10.50, no GHS price

        await expect(orderSvc.createGhsOrder(db, {
            businessProfileId: profile.id,
            customerId: customer.id,
            productId: product.id,
            title: 'GHS Flow Test order unpriced',
        })).rejects.toMatchObject({ code: 'GHS_PRICE_UNAVAILABLE' });

        // And nothing was written: a refusal must not leave a half-priced order.
        expect(await db.businessOrder.count({ where: { businessProfileId: profile.id } })).toBe(0);
    });

    test('an UNCONFIRMED cedi price is refused too, because it confers no right to charge', async () => {
        const { customer, profile, product } = await seedMerchant();
        await setGhsPrice(product.id, '15.00', false); // proposed, not confirmed

        await expect(orderSvc.createGhsOrder(db, {
            businessProfileId: profile.id,
            customerId: customer.id,
            productId: product.id,
            title: 'GHS Flow Test order unconfirmed',
        })).rejects.toMatchObject({ code: 'GHS_PRICE_UNAVAILABLE' });
        expect(await db.businessOrder.count({ where: { businessProfileId: profile.id } })).toBe(0);
    });

    test('quantity must be a whole number of units within bounds', async () => {
        const { customer, profile, product } = await seedMerchant();
        await setGhsPrice(product.id, '5.00');
        const base = { businessProfileId: profile.id, customerId: customer.id, productId: product.id, title: 'GHS Flow Test order qty' };

        for (const quantity of [0, -1, 2.5, 1000, Number.NaN]) {
            await expect(orderSvc.createGhsOrder(db, { ...base, quantity }))
                .rejects.toThrow(/quantity must be an integer between 1 and 999/);
        }
        expect(await db.businessOrder.count({ where: { businessProfileId: profile.id } })).toBe(0);
    });

    test('the merchant read reports cedis as the headline with no merged GHS+USDC total', async () => {
        const { customer, profile, product } = await seedMerchant();
        await setGhsPrice(product.id, '120.50');

        const first = await orderSvc.createGhsOrder(db, {
            businessProfileId: profile.id, customerId: customer.id, productId: product.id, title: 'GHS Flow Test order stats a',
        });
        const second = await orderSvc.createGhsOrder(db, {
            businessProfileId: profile.id, customerId: customer.id, productId: product.id, title: 'GHS Flow Test order stats b',
        });
        await db.businessOrder.updateMany({
            where: { id: { in: [first.id, second.id] } },
            data: { status: 'COMPLETED' },
        });

        const stats = await orderSvc.getBusinessStats(db, { businessProfileId: profile.id });

        expect(stats.revenue.counts.GHS).toBe(2);
        expect(stats.revenue.GHS).toBe('241.00');
        // The USDC rail simply has no activity, which is a normal state, not a zero.
        // No USDC activity is a normal state: counts.USDC is the signal a surface
        // uses to omit the rail entirely. The bucket still reports its own zero at
        // the USDC rail's 8dp precision rather than pretending a cedi figure.
        expect(stats.revenue.counts.USDC).toBe(0);
        expect(stats.revenue.USDC).toBe('0.00000000');
        expect(stats.headline).toEqual({ currency: 'GHS', amount: '241.00' });
        // Legacy scalar must stay USDC-only: a cedi sale may never inflate it.
        expect(stats.totalRevenue).toBe(0);
        expect(stats.revenueBasis).toBe('PER_CURRENCY');
    });
});
