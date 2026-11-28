'use strict';

// =============================================================================
// STORE ORDERS PAID FROM THE WALLET (real PostgreSQL).
//
// Through the real checkout chain (integrity boundary → storefront handler)
// in ESCROW mode, for a store that never touched the escrow setting:
//   S1. Checkout creates an AWAITING_PAYMENT order with a DRAFT escrow;
//       funding debits price + fee and holds the price; handing the order
//       over marks the store's side; the buyer's "Got it" pays the store
//       and completes the order.
//   S2. With no answer, the release sweep (its relation filter and the
//       escrow row lock, in real SQL) pays the store only after 72h, once.
//   S3. A reported problem (the real dispute) is never released.
//   S4. An unpaid order whose payment hold lapses is cancelled with it.
// =============================================================================

jest.mock('uuid', () => ({
    v4: () => `pg-test-${Math.random().toString(36).slice(2, 10)}`,
}));

const { PrismaClient } = require('@prisma/client');
const { seedUser, seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('store orders paid from the wallet (PostgreSQL)', () => {
    let prisma;
    let escrowService;
    let orders;
    let biz;
    let owner;
    let product;
    const HOUR = 3600_000;

    const integrityRouter = require('../routes/storefrontCheckoutIntegrityRoutes');
    const legacyRouter = require('../routes/storefrontRoutes');
    const handlerOf = (router, routePath) => {
        const layer = router.stack.find(l => l.route && l.route.path === routePath);
        if (!layer) throw new Error(`route not mounted: ${routePath}`);
        return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const checkoutBoundary = handlerOf(integrityRouter, '/:businessProfileId/checkout');
    const checkoutLegacy = handlerOf(legacyRouter, '/:businessProfileId/checkout');

    const app = { settings: {}, get(k) { return this.settings[k]; }, set(k, v) { this.settings[k] = v; } };
    const checkout = ({ userId, body }) => new Promise((resolve, reject) => {
        const req = {
            method: 'POST',
            originalUrl: `/api/storefront/${biz.id}/checkout`, path: `/api/storefront/${biz.id}/checkout`,
            url: `/api/storefront/${biz.id}/checkout`, baseUrl: '', route: { path: '/:businessProfileId/checkout' },
            headers: {}, params: { businessProfileId: biz.id }, query: {}, body,
            app, get: (k) => app.get(k), user: { id: userId },
        };
        const res = {
            app, locals: {}, statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { if (!this.headersSent) { this.headersSent = true; this.body = b; } return this; },
            setHeader() {}, end() { this.headersSent = true; return this; },
        };
        const originalJson = res.json.bind(res);
        res.json = (b) => { originalJson(b); resolve({ status: res.statusCode, body: res.body }); return res; };
        Promise.resolve(checkoutBoundary(req, res, (err) => {
            if (err) return reject(err);
            return Promise.resolve(checkoutLegacy(req, res)).catch(reject);
        })).catch(reject);
    });

    const balances = async (id) => {
        const u = await prisma.user.findUnique({ where: { id }, select: { availableBalance: true, escrowLockedBalance: true } });
        return { available: Number(u.availableBalance), locked: Number(u.escrowLockedBalance) };
    };
    const settle = () => new Promise((r) => setTimeout(r, 150)); // post-commit order sync

    const sweep = async () => {
        if (!biz) return;
        const rows = await prisma.businessOrder.findMany({ where: { businessProfileId: biz.id }, select: { id: true, escrowId: true, ticketId: true } });
        if (rows.length) {
            await prisma.businessOrderItem.deleteMany({ where: { orderId: { in: rows.map(r => r.id) } } });
            await prisma.businessOrder.deleteMany({ where: { id: { in: rows.map(r => r.id) } } });
            const escrowIds = rows.map(r => r.escrowId).filter(Boolean);
            if (escrowIds.length) {
                await prisma.escrowDispute.deleteMany({ where: { escrowId: { in: escrowIds } } });
                await prisma.smartEscrow.deleteMany({ where: { id: { in: escrowIds } } });
            }
            const ticketIds = rows.map(r => r.ticketId).filter(Boolean);
            if (ticketIds.length) {
                await prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
                await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
            }
        }
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        app.set('prisma', prisma);
        app.set('socketio', null);
        app.set('logger', console);
        escrowService = require('../services/escrowService');
        orders = require('../services/businessOrderService');
        const seeded = await seedBusiness(prisma, { owner: { availableBalance: 0 } });
        biz = seeded.biz; owner = seeded.owner; product = seeded.product;
        await prisma.businessProduct.update({
            where: { id: product.id },
            data: { isAvailable: true, isActive: true, stockQty: null, priceUsdc: 10 },
        });
        // The store never set escrowProtection: it is on by default.
        await prisma.businessProfile.update({ where: { id: biz.id }, data: { businessMeta: {} } });
    });
    beforeEach(sweep, 15000);
    afterAll(async () => {
        await sweep();
        await prisma.businessProduct.deleteMany({ where: { businessProfileId: biz.id } });
        await prisma.businessProfile.deleteMany({ where: { id: biz.id } });
        await prisma.$disconnect();
    });

    async function placedAndPaid() {
        const buyer = await seedUser(prisma, { availableBalance: 100 });
        const out = await checkout({
            userId: buyer.id,
            body: { items: [{ productId: product.id, quantity: 1 }], paymentMode: 'ESCROW', idempotencyKey: `sp-${Date.now()}-${Math.random()}` },
        });
        expect([200, 201]).toContain(out.status);
        const order = out.body.data.order;
        expect(order.status).toBe('AWAITING_PAYMENT');
        expect(order.escrow.status).toBe('DRAFT');
        await escrowService.fundEscrow(prisma, { escrowId: order.escrow.id, payerId: buyer.id });
        await settle();
        return { buyer, order };
    }

    test('S1: pay, hand over, "Got it": the store is paid and the order completes', async () => {
        const { buyer, order } = await placedAndPaid();
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: order.escrow.id } });
        expect(escrow.status).toBe('FUNDED');
        const fee = Number(escrow.feeUsdc);
        expect(await balances(buyer.id)).toEqual({ available: expect.closeTo(100 - 10 - fee, 6), locked: expect.closeTo(10, 6) });
        expect((await prisma.businessOrder.findUnique({ where: { id: order.id } })).status).toBe('PAID');

        await orders.markDelivered(prisma, { orderId: order.id, businessProfileId: biz.id });
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrow.id } })).payeeSatisfied).toBe(true);
        expect((await balances(owner.id)).available).toBe(0);

        const done = await escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: buyer.id });
        await settle();
        expect(done.settled).toBe(true);
        expect((await balances(owner.id)).available).toBeCloseTo(10, 6);
        expect((await balances(buyer.id)).locked).toBeCloseTo(0, 6);
        expect((await prisma.businessOrder.findUnique({ where: { id: order.id } })).status).toBe('COMPLETED');
    });

    test('S2: no answer: paid after 72h, not before, once', async () => {
        const { buyer, order } = await placedAndPaid();
        await orders.markDelivered(prisma, { orderId: order.id, businessProfileId: biz.id });
        const before = await orders.releaseDeliveredOrders(prisma, { now: Date.now() + 71 * HOUR });
        expect(before.released).toBe(0);
        expect((await balances(owner.id)).available).toBe(0);

        const after = await orders.releaseDeliveredOrders(prisma, { now: Date.now() + 73 * HOUR });
        expect(after.released).toBe(1);
        expect((await balances(owner.id)).available).toBeCloseTo(10, 6);
        expect((await balances(buyer.id)).locked).toBeCloseTo(0, 6);
        expect((await prisma.businessOrder.findUnique({ where: { id: order.id } })).status).toBe('COMPLETED');

        const again = await orders.releaseDeliveredOrders(prisma, { now: Date.now() + 200 * HOUR });
        expect(again.checked).toBe(0);
        expect((await balances(owner.id)).available).toBeCloseTo(10, 6);
    });

    test('S3: a reported problem is never released', async () => {
        const { buyer, order } = await placedAndPaid();
        await orders.markDelivered(prisma, { orderId: order.id, businessProfileId: biz.id });
        await escrowService.raiseDispute(prisma, {
            escrowId: order.escrow.id, raisedById: buyer.id, reason: 'Wrong item', evidenceUrls: [],
        });
        const out = await orders.releaseDeliveredOrders(prisma, { now: Date.now() + 200 * HOUR });
        expect(out.released).toBe(0);
        expect((await balances(owner.id)).available).toBe(0);
        expect((await prisma.smartEscrow.findUnique({ where: { id: order.escrow.id } })).status).toBe('DISPUTED');
    });

    test('S4: an unpaid order whose payment hold lapses is cancelled', async () => {
        const buyer = await seedUser(prisma, { availableBalance: 100 });
        const out = await checkout({
            userId: buyer.id,
            body: { items: [{ productId: product.id, quantity: 1 }], paymentMode: 'ESCROW', idempotencyKey: `sp4-${Date.now()}` },
        });
        const order = out.body.data.order;
        await prisma.smartEscrow.update({ where: { id: order.escrow.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        const EscrowExpiryWorker = require('../workers/escrowExpiryWorker');
        const Worker = EscrowExpiryWorker.EscrowExpiryWorker || EscrowExpiryWorker;
        await new Worker(prisma, null, null, {})._expireUnfunded(new Date());
        expect((await prisma.smartEscrow.findUnique({ where: { id: order.escrow.id } })).status).toBe('EXPIRED');
        expect((await prisma.businessOrder.findUnique({ where: { id: order.id } })).status).toBe('CANCELLED');
        expect(await balances(buyer.id)).toEqual({ available: 100, locked: 0 });
    });
});
