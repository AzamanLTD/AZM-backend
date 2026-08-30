// __tests__/business-orders.test.js
const { seedBusiness, seedUser } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) console.warn('[business-orders.test] TEST_DATABASE_URL not set — skipping business order tests.');

describeOrSkip('BusinessOrder — lifecycle', () => {
    let prisma;
    let businessOrderService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        businessOrderService = require('../services/businessOrderService');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "User", "BusinessProfile", "BusinessProduct", "BusinessOrder" RESTART IDENTITY CASCADE');
    }, 15000);

    test('markDelivered transitions a PAID order to DELIVERED', async () => {
        const { biz, product } = await seedBusiness(prisma);
        const customer = await seedUser(prisma);
        const order = await prisma.businessOrder.create({
            data: { businessProfileId: biz.id, customerId: customer.id, productId: product.id, status: 'PAID', title: 'Test Order', amountUsdc: 50.0, orderRef: `ORD-TEST-${Date.now()}` }
        });
        const updated = await businessOrderService.markDelivered(prisma, { orderId: order.id, businessProfileId: biz.id, deliveryNotes: 'Delivered' });
        expect(updated.status).toBe('DELIVERED');
        expect(updated.deliveredAt).toBeTruthy();
    });

    test('markDelivered rejects a non-owner', async () => {
        const { biz } = await seedBusiness(prisma);
        const customer = await seedUser(prisma);
        const order = await prisma.businessOrder.create({ data: { businessProfileId: biz.id, customerId: customer.id, status: 'PAID', title: 'Test Order', amountUsdc: 50.0, orderRef: `ORD-TEST-${Date.now()}-2` } });
        await expect(businessOrderService.markDelivered(prisma, { orderId: order.id, businessProfileId: 'some-other-biz-id', deliveryNotes: 'x' })).rejects.toThrow(/do not own this order/i);
    });

    test('concurrent markDelivered calls allow exactly one PAID → DELIVERED transition', async () => {
        const { biz, product } = await seedBusiness(prisma);
        const customer = await seedUser(prisma);
        const order = await prisma.businessOrder.create({ data: { businessProfileId: biz.id, customerId: customer.id, productId: product.id, status: 'PAID', title: 'Concurrent Order', amountUsdc: 50.0, orderRef: `ORD-CONCURRENT-${Date.now()}` } });

        const results = await Promise.allSettled([
            businessOrderService.markDelivered(prisma, { orderId: order.id, businessProfileId: biz.id, deliveryNotes: 'First' }),
            businessOrderService.markDelivered(prisma, { orderId: order.id, businessProfileId: biz.id, deliveryNotes: 'Second' }),
        ]);

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        const persisted = await prisma.businessOrder.findUnique({ where: { id: order.id } });
        expect(persisted.status).toBe('DELIVERED');
        expect(['First', 'Second']).toContain(persisted.deliveryNotes);
    });

    test('late escrow FUNDED event cannot regress a refunded order', async () => {
        const { biz, product } = await seedBusiness(prisma);
        const customer = await seedUser(prisma);
        const escrow = await prisma.smartEscrow.create({ data: { ticketId: (await prisma.ticket.create({ data: { creatorId: customer.id, counterpartyId: biz.userId, name: 'Test', type: 'ESCROW', targetAmount: 50, targetCurrency: 'USDC', status: 'OPEN', businessProfileId: biz.id, lastActivityAt: new Date() } })).id, payerId: customer.id, payeeId: biz.userId, amountUsdc: 50, feeUsdc: 0.5, status: 'DRAFT' } });
        const order = await prisma.businessOrder.create({ data: { businessProfileId: biz.id, customerId: customer.id, productId: product.id, escrowId: escrow.id, status: 'REFUNDED', title: 'Refunded Order', amountUsdc: 50, orderRef: `ORD-REFUNDED-${Date.now()}` } });

        const result = await businessOrderService.updateOrderStatusFromEscrow(prisma, escrow.id, 'FUNDED');
        expect(result.status).toBe('REFUNDED');
        const persisted = await prisma.businessOrder.findUnique({ where: { id: order.id } });
        expect(persisted.status).toBe('REFUNDED');
    });
});