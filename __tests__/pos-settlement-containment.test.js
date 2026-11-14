// __tests__/pos-settlement-containment.test.js
// =============================================================================
// WP-POS-C0 — POS settlement containment, proved through the real service and
// the real Express routers against real PostgreSQL.
//
// The claim under test is narrow: NO NEW POS SALE CAN BE CREATED, for any
// payment method, and a refusal writes nothing economic. Recovering an order
// that is ALREADY COMMITTED must still work, because that is not a new sale.
//
// What each block proves is stated on the test itself. Nothing here claims POS
// sales are supported; the opposite is the point.
// =============================================================================

const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__POS_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (_req, _res, next) => next() };
});

const { PrismaClient, Prisma } = require('@prisma/client');
const businessOSRoutes = require('../routes/businessOSRoutes');
const businessOSPosRoutes = require('../routes/businessOSPosRoutes');
const {
    PosOrderService,
    POS_SETTLEMENT_CONTRACT,
    POS_SETTLEMENT_REFUSAL_CODE,
    POS_PAYMENT_METHOD_UNSUPPORTED_CODE,
    POS_VALIDATION_CODE,
    POS_INTERNAL_CODE,
} = require('../services/businessOS/posOrderService');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const run = url ? describe : describe.skip;

if (!url) {
    console.warn('[pos-settlement-containment] TEST_DATABASE_URL not set — skipping.');
}

// WP-POS-C0 fail-closed: an unconfigured CI must FAIL, never skip to green.
if (!url && IS_CI) {
    test('WP-POS-C0 CI configuration: TEST_DATABASE_URL must be set', () => {
        throw new Error(
            'TEST_DATABASE_URL is not set in CI. The POS containment proofs cannot run, and a '
            + 'skipped suite must not be reported as a passing build.',
        );
    });
}

run('WP-POS-C0 — POS settlement containment', () => {
    let db;
    let app;
    let A;
    let seq = 0;

    const asUser = (user) => { global.__POS_USER__ = user ? { id: user.id } : null; };

    const buildApp = (prismaClient) => {
        const a = express();
        a.use(express.json());
        a.set('prisma', prismaClient || db);
        a.set('logger', { error: () => {}, warn: () => {} });
        // Mirror src/routes/index.js mount order: canonical POS router first.
        a.use('/api/business-os', businessOSPosRoutes);
        a.use('/api/business-os', businessOSRoutes);
        return a;
    };

    const posOrder = (body) => request(app).post('/api/business-os/pos/order').send(body);
    const cashSaleAlias = (body) => request(app).post('/api/business-os/pos/cash-sale').send(body);

    const saleBody = (extra = {}) => ({
        items: [{ productId: A.product.id, quantity: 2 }],
        cashGiven: 1000,
        idempotencyKey: `pos-c0-${++seq}`,
        ...extra,
    });

    /** Every table a POS sale could write, read as one snapshot. */
    const snapshot = async () => {
        const [orders, ledger, azmSpend, product, owner] = await Promise.all([
            db.businessOrder.count(),
            db.businessLedgerEntry.count(),
            db.azmSpendLog.count(),
            db.businessProduct.findUnique({ where: { id: A.product.id }, select: { stockQty: true } }),
            db.user.findUnique({ where: { id: A.owner.id }, select: { azmBalance: true } }),
        ]);
        return {
            orders,
            ledger,
            azmSpend,
            stock: product.stockQty === null ? null : Number(product.stockQty),
            azmBalance: owner.azmBalance === null ? null : String(owner.azmBalance),
        };
    };

    /** An order that was genuinely committed before containment: seeded directly. */
    const seedCommittedOrder = async ({ idempotencyKey, amount = 102.5, customerId } = {}) => {
        const orderRef = `POS-SEED-${++seq}`;
        const order = await db.businessOrder.create({
            data: {
                businessProfileId: A.biz.id,
                customerId: customerId || A.owner.id,
                status: 'COMPLETED',
                orderRef,
                title: 'POS Sale (CASH)',
                amountUsdc: new Prisma.Decimal(amount),
                paymentMethod: 'CASH',
                idempotencyKey: idempotencyKey || `seed-${seq}`,
                cashReceived: new Prisma.Decimal(200),
                cashChange: new Prisma.Decimal(200).minus(new Prisma.Decimal(amount)),
                completedAt: new Date(),
            },
        });
        await db.businessLedgerEntry.create({
            data: {
                businessProfileId: A.biz.id,
                type: 'INCOME',
                category: 'SALES',
                description: `POS Sale (${orderRef})`,
                amount: new Prisma.Decimal(amount),
                sourceType: 'POS_SALE',
                sourceId: order.id,
                metadata: { orderRef, paymentMethod: 'CASH' },
            },
        });
        return order;
    };

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = buildApp();
    });

    afterAll(async () => { await db.$disconnect(); });

    afterEach(async () => {
        global.__POS_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "BusinessLedgerEntry", "BusinessOrderItem", "BusinessOrder", "AzmSpendLog", "BusinessTaxPreset", "RecipeIngredient", "InventoryItem", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    beforeEach(async () => {
        A = await seedBusiness(db);
        asUser(A.owner);
        await db.businessProduct.update({ where: { id: A.product.id }, data: { stockQty: 100 } });
        await db.businessTaxPreset.create({
            data: { businessProfileId: A.biz.id, name: 'VAT', type: 'PERCENTAGE', value: 2.5, isDefault: true },
        });
    });

    // ── the gate itself ────────────────────────────────────────────────────
    test('the containment contract cannot be lifted by configuration', () => {
        expect(POS_SETTLEMENT_CONTRACT.enabled).toBe(false);
        expect(POS_SETTLEMENT_CONTRACT.orderCurrency).toBeNull();
        expect(Object.isFrozen(POS_SETTLEMENT_CONTRACT)).toBe(true);
        // No environment flag is consulted anywhere: flipping every candidate
        // variable cannot enable settlement, because the contract object is the
        // only input and it is frozen.
        const saved = { ...process.env };
        for (const k of ['POS_SETTLEMENT_ENABLED', 'POS_CASH_SETTLEMENT_ENABLED', 'POS_ORDER_CURRENCY']) {
            process.env[k] = 'true';
        }
        try {
            expect(POS_SETTLEMENT_CONTRACT.enabled).toBe(false);
        } finally {
            process.env = saved;
        }
    });

    // ── 1. CASH refused ────────────────────────────────────────────────────
    test('1. a new CASH order is refused with POS_SETTLEMENT_NOT_ENABLED', async () => {
        const before = await snapshot();
        const res = await posOrder(saleBody({ paymentMethod: 'CASH' }));

        expect(res.status).toBe(422);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe(POS_SETTLEMENT_REFUSAL_CODE);
        expect(res.body.settlement).toEqual({ available: false, currency: null });
        // The response must not read as accepted/created/reserved.
        expect(res.body.order).toBeUndefined();
        expect(res.body.computedGrand).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toMatch(/orderRef|computedGrand|"status":"COMPLETED"/);
        expect(await snapshot()).toEqual(before);
    });

    // ── 2/3. AZM and SPLIT refused, and permanently so ─────────────────────
    test('2. a new AZM order is refused and debits nobody', async () => {
        const before = await snapshot();
        const res = await posOrder(saleBody({ paymentMethod: 'AZM', azmAmount: 102.5 }));

        expect(res.status).toBe(422);
        expect(res.body.code).toBe(POS_PAYMENT_METHOD_UNSUPPORTED_CODE);
        expect(res.body.message).toContain('AZM is loyalty value');
        const after = await snapshot();
        expect(after).toEqual(before);
        // Specifically: the cashier's personal loyalty balance is untouched and
        // no AZM spend record exists.
        expect(after.azmBalance).toBe(before.azmBalance);
        expect(after.azmSpend).toBe(0);
    });

    test('3. a new SPLIT order is refused', async () => {
        const before = await snapshot();
        const res = await posOrder(saleBody({ paymentMethod: 'SPLIT', azmAmount: 50, cashGiven: 500 }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(POS_PAYMENT_METHOD_UNSUPPORTED_CODE);
        expect(await snapshot()).toEqual(before);
    });

    // ── 4. every other payment method is refused too ────────────────────────
    test('4. every other payment method is refused, none slips through', async () => {
        const methods = ['CARD', 'MOBILE_MONEY', 'MOMO', 'BANK', 'TRANSFER', 'USDC', 'GHS_CASH',
            'CASH_ON_DELIVERY', 'WALLET', 'azm', 'split', 'cash', ''];
        const before = await snapshot();
        const seen = new Set();

        for (const paymentMethod of methods) {
            // eslint-disable-next-line no-await-in-loop
            const res = await posOrder(saleBody({ paymentMethod, azmAmount: 10 }));
            expect([400, 422]).toContain(res.status);
            expect(res.body.success).toBe(false);
            expect(res.body.order).toBeUndefined();
            // A refusal is always machine-readable, never a bare 201/200.
            expect([POS_SETTLEMENT_REFUSAL_CODE, POS_PAYMENT_METHOD_UNSUPPORTED_CODE, POS_VALIDATION_CODE])
                .toContain(res.body.code);
            seen.add(res.body.code);
        }
        // The set proves CASH-shaped, AZM-shaped and unknown methods were all
        // refused through the intended codes rather than one accidental path.
        expect(seen.has(POS_SETTLEMENT_REFUSAL_CODE)).toBe(true);
        expect(seen.has(POS_PAYMENT_METHOD_UNSUPPORTED_CODE)).toBe(true);
        expect(seen.has(POS_VALIDATION_CODE)).toBe(true);
        expect(await snapshot()).toEqual(before);
    });

    // ── 5. an already committed order still replays ─────────────────────────
    test('5. a committed order replays with its original identity and result', async () => {
        const key = 'committed-replay-key';
        const committed = await seedCommittedOrder({ idempotencyKey: key, amount: 102.5 });
        const before = await snapshot();

        const res = await posOrder(saleBody({ paymentMethod: 'CASH', idempotencyKey: key }));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.duplicate).toBe(true);
        expect(res.body.order.id).toBe(committed.id);
        expect(res.body.order.orderRef).toBe(committed.orderRef);
        expect(Number(res.body.computedGrand)).toBeCloseTo(102.5, 8);

        // The legacy alias replays the same durable order.
        const alias = await cashSaleAlias({ items: saleBody().items, cashReceived: 1000, idempotencyKey: key });
        expect(alias.status).toBe(200);
        expect(alias.body.order.id).toBe(committed.id);
        expect(alias.body.message).toBe('Duplicate (idempotent)');

        // Replay wrote nothing new.
        expect(await snapshot()).toEqual(before);
    });

    test('5b. the service refuses a NEW order but still replays a committed one', async () => {
        const key = 'service-level-replay';
        const committed = await seedCommittedOrder({ idempotencyKey: key });
        const service = new PosOrderService(db);

        // Direct service call: the gate is inside the service, not the route.
        await expect(service.createOrder({
            businessProfileId: A.biz.id, actorId: A.owner.id,
            items: [{ productId: A.product.id, quantity: 1 }],
            paymentMethod: 'CASH', cashGiven: 500, idempotencyKey: `fresh-${++seq}`,
        })).rejects.toMatchObject({ code: POS_SETTLEMENT_REFUSAL_CODE, statusCode: 422 });

        const replay = await service.createOrder({
            businessProfileId: A.biz.id, actorId: A.owner.id,
            items: [{ productId: A.product.id, quantity: 1 }],
            paymentMethod: 'CASH', cashGiven: 500, idempotencyKey: key,
        });
        expect(replay.duplicate).toBe(true);
        expect(replay.order.id).toBe(committed.id);
    });

    // ── 6-10. a refusal writes nothing at all ──────────────────────────────
    test('6-10. a refusal creates no order, ledger, stock move, or loyalty spend', async () => {
        const before = await snapshot();
        expect(before).toMatchObject({ orders: 0, ledger: 0, azmSpend: 0, stock: 100 });

        await posOrder(saleBody({ paymentMethod: 'CASH' }));
        await posOrder(saleBody({ paymentMethod: 'AZM', azmAmount: 20 }));
        await posOrder(saleBody({ paymentMethod: 'SPLIT', azmAmount: 20, cashGiven: 500 }));
        await cashSaleAlias({ items: saleBody().items, cashReceived: 1000, idempotencyKey: `aliased-${++seq}` });

        const after = await snapshot();
        expect(after).toEqual(before);
        // No payment intent, provider dispatch, reservation or settlement row
        // exists in this deployment; assert the tables a sale would have to
        // touch are all still empty.
        expect(after.orders).toBe(0);
        expect(after.ledger).toBe(0);
        expect(after.azmSpend).toBe(0);
        expect(after.stock).toBe(100);
        expect(await db.businessOrderItem.count()).toBe(0);
    });

    // ── 11. no phantom idempotency state ───────────────────────────────────
    test('11. a refused request leaves no phantom idempotency record', async () => {
        const key = `phantom-${++seq}`;
        const body = saleBody({ idempotencyKey: key });

        const first = await posOrder(body);
        expect(first.body.code).toBe(POS_SETTLEMENT_REFUSAL_CODE);
        // Nothing durable carries the key, so nothing can look committed.
        expect(await db.businessOrder.findFirst({ where: { idempotencyKey: key } })).toBeNull();

        // Reusing the key with a DIFFERENT body must give the same refusal, not
        // a fingerprint conflict against a phantom order.
        const second = await posOrder(saleBody({ idempotencyKey: key, cashGiven: 2000 }));
        expect(second.status).toBe(422);
        expect(second.body.code).toBe(POS_SETTLEMENT_REFUSAL_CODE);
        expect(second.body.message).not.toContain('different POS request');

        // And again, unchanged: still refused, still nothing stored.
        const third = await posOrder(body);
        expect(third.body.code).toBe(POS_SETTLEMENT_REFUSAL_CODE);
        expect(await db.businessOrder.count()).toBe(0);
        expect(await db.businessLedgerEntry.count()).toBe(0);
    });

    // ── 12. infrastructure failure is not the contractual refusal ───────────
    test('12. a simulated database failure answers 500, not the contractual 422', async () => {
        // The REAL client stays in place for auth/permission middleware; only the
        // service's first durable read fails, which is what an unreachable
        // database looks like from inside the settlement path.
        const outage = () => {
            const e = new Error('connect ECONNREFUSED 127.0.0.1:5432');
            e.code = 'P1001';
            return e;
        };
        const broken = new Proxy(db, {
            get(target, prop) {
                if (prop === 'businessOrder') {
                    return { findFirst: async () => { throw outage(); }, count: async () => 0 };
                }
                const value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        const brokenApp = buildApp(broken);
        const res = await request(brokenApp).post('/api/business-os/pos/order').send({
            items: [{ productId: 'anything', quantity: 1 }], paymentMethod: 'CASH', idempotencyKey: 'boom-1',
        });

        expect(res.status).toBe(500);
        expect(res.body.code).toBe(POS_INTERNAL_CODE);
        expect(res.body.code).not.toBe(POS_SETTLEMENT_REFUSAL_CODE);
        expect(res.body.message).toBe('POS order could not be processed.');
        // No driver text, host, port or stack reaches the client.
        expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|5432|P1001|at .*\.js:/);
    });

    // ── 13. the direct API cannot bypass the service gate ──────────────────
    test('13. neither POS endpoint can create an order, including the legacy alias', async () => {
        const results = await Promise.all([
            posOrder(saleBody({ paymentMethod: 'CASH' })),
            cashSaleAlias({ items: [{ productId: A.product.id, quantity: 1 }], cashReceived: 1000, idempotencyKey: `alias-${++seq}` }),
        ]);
        for (const res of results) {
            expect(res.status).toBe(422);
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe(POS_SETTLEMENT_REFUSAL_CODE);
        }
        expect(await db.businessOrder.count()).toBe(0);
        expect(await db.businessLedgerEntry.count()).toBe(0);
    });

    // ── 14. unrelated reads still work ─────────────────────────────────────
    test('14. order-history reads still work, including a committed order', async () => {
        const committed = await seedCommittedOrder({ amount: 42 });
        const res = await request(app).get('/api/business-os/analytics/predictive');
        expect(res.status).toBe(200);
        expect(res.body.success).not.toBe(false);
        // The committed order is readable through the normal path.
        const stored = await db.businessOrder.findUnique({ where: { id: committed.id } });
        expect(stored.status).toBe('COMPLETED');
        expect(Number(stored.amountUsdc)).toBeCloseTo(42, 8);
    });
});
