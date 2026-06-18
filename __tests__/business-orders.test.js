// __tests__/business-orders.test.js
// =============================================================================
// Business order lifecycle coverage. SKIPS unless TEST_DATABASE_URL is set.
//
// Written against the real services/businessOrderService.js contract:
//   markDelivered({ orderId, businessProfileId, deliveryNotes }) — owner-scoped,
//   requires the order to be in PAID status, transitions it to DELIVERED.
// =============================================================================

const { seedBusiness, seedUser } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[business-orders.test] TEST_DATABASE_URL not set — skipping business order tests.');
}

describeOrSkip('BusinessOrder — lifecycle', () => {
    let prisma;
    let businessOrderService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        // eslint-disable-next-line global-require
        businessOrderService = require('../services/businessOrderService');
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "BusinessProfile", "BusinessProduct", "BusinessOrder" RESTART IDENTITY CASCADE'
        );
    });

    test('markDelivered transitions a PAID order to DELIVERED', async () => {
        const { biz, product } = await seedBusiness(prisma);
        const customer = await seedUser(prisma);

        const order = await prisma.businessOrder.create({
            data: {
                businessProfileId: biz.id,
                customerId: customer.id,
                productId: product.id,
                status: 'PAID',
                title: 'Test Order',
                amountUsdc: 50.0,
                orderRef: `ORD-TEST-${Date.now()}`,
            },
        });

        const updated = await businessOrderService.markDelivered(prisma, {
            orderId: order.id,
            businessProfileId: biz.id,
            deliveryNotes: 'Delivered',
        });

        expect(updated.status).toBe('DELIVERED');
        expect(updated.deliveredAt).toBeTruthy();
    });

    test('markDelivered rejects a non-owner', async () => {
        const { biz } = await seedBusiness(prisma);
        const customer = await seedUser(prisma);
        const order = await prisma.businessOrder.create({
            data: {
                businessProfileId: biz.id,
                customerId: customer.id,
                status: 'PAID',
                title: 'Test Order',
                amountUsdc: 50.0,
                orderRef: `ORD-TEST-${Date.now()}-2`,
            },
        });

        await expect(
            businessOrderService.markDelivered(prisma, {
                orderId: order.id,
                businessProfileId: 'some-other-biz-id',
                deliveryNotes: 'x',
            })
        ).rejects.toThrow(/do not own this order/i);
    });
});
