'use strict';

// =============================================================================
// WP-1.10 — RETAIL GHS-PRICE / USDC-CHECKOUT CONTAINMENT (real PostgreSQL).
//
// The defect: the catalogue can present an authoritative GHS BusinessPrice for
// an item while checkout charges product.priceUsdc. The two amounts are
// unrelated. Until a merchant GHS settlement path exists, an item presented
// with an applicable GHS price must not reach a USDC checkout.
//
// Every proof drives the REAL production route handlers against a REAL
// database, then asserts PERSISTED state (orders, escrows, tickets, items,
// analytics) — never merely that a helper returned a refusal. No provider or
// network call is involved anywhere.
// =============================================================================

jest.mock('uuid', () => ({
    v4: () => `ghs-test-${Math.random().toString(36).slice(2, 10)}`,
}));

const { PrismaClient } = require('@prisma/client');
const { seedUser, seedBusiness } = require('./helpers/factories');
const priceService = require('../services/businessPriceService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('WP-1.10 — storefront GHS checkout guard (PostgreSQL)', () => {
    let prisma;
    let legacyRouter, integrityRouter;

    const app = {
        settings: {},
        get(k) { return this.settings[k]; },
        set(k, v) { this.settings[k] = v; },
    };

    const mkRes = () => ({
        app, locals: {}, statusCode: 200, headersSent: false,
        status(c) { this.statusCode = c; return this; },
        json(b) {
            if (!this.headersSent) { this.headersSent = true; this.body = b; }
            return this;
        },
        setHeader() {}, end() { this.headersSent = true; return this; },
    });

    const handlerOf = (router, routePath) => {
        const layer = router.stack.find(l => l.route && l.route.path === routePath);
        if (!layer) throw new Error(`route not mounted: ${routePath}`);
        return layer.route.stack[layer.route.stack.length - 1].handle;
    };

    const drive = (handler, { userId, businessProfileId, routePath, body }) =>
        new Promise((resolve, reject) => {
            const p = `/api/storefront/${businessProfileId}${routePath}`;
            const req = {
                method: 'POST', originalUrl: p, path: p, url: p, baseUrl: '',
                route: { path: `/:businessProfileId${routePath}` },
                headers: {}, params: { businessProfileId }, query: {}, body,
                app, get: (k) => app.get(k), user: { id: userId },
            };
            const res = mkRes();
            const originalJson = res.json.bind(res);
            res.json = (b) => { originalJson(b); resolve({ status: res.statusCode, body: res.body }); return res; };
            Promise.resolve(handler(req, res, reject)).catch(reject);
        });

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        prisma = new PrismaClient();
        app.set('prisma', prisma);
        legacyRouter = require('../routes/storefrontRoutes');
        integrityRouter = require('../routes/storefrontCheckoutIntegrityRoutes');
    });

    afterAll(async () => prisma.$disconnect());

    // ── fixtures ────────────────────────────────────────────────────────────
    let seq = 0;
    const uniq = () => `${Date.now()}_${++seq}`;

    async function seedShop({ ghs = true, ghsOverrides = {}, secondProduct = false, escrow = false } = {}) {
        const { biz, owner, product } = await seedBusiness(prisma);
        // The checkout transaction enforces a stock trigger; fixtures buy stock
        // so the only variable under test is the pricing guard.
        await prisma.businessProduct.update({ where: { id: product.id }, data: { stockQty: 50 } });
        if (escrow) {
            // Escrow protection is opt-in per business; without it the ESCROW
            // checkout mode is refused 403 before any pricing is considered.
            await prisma.businessProfile.update({
                where: { id: biz.id },
                data: { businessMeta: { escrowProtection: { enabled: true } } },
            });
        }
        const customer = await seedUser(prisma, { availableBalance: 1000 });
        // The factory product has no BusinessPrice row by default.
        if (ghs) {
            await prisma.$transaction(async (tx) => {
                await priceService.setPrice(tx, {
                    businessProductId: product.id,
                    amountGhs: '120.50',
                    confirmedByType: 'BUSINESS',
                    confirmedById: String(owner.id),
                    ...ghsOverrides,
                });
            });
        }
        let other = null;
        if (secondProduct) {
            other = await prisma.businessProduct.create({
                data: {
                    businessProfileId: biz.id, name: 'USDC-only item',
                    priceUsdc: 9.99, slug: `usdc-only-${uniq()}`, isActive: true, isAvailable: true,
                    stockQty: 50,
                },
            });
        }
        return { biz, owner, customer, product, other };
    }

    // SmartEscrow has no business column; it is reachable only through its
    // ticket (businessProfileId) or its payer. Count BOTH, so a hypothetical
    // escrow created without a business-scoped ticket cannot hide.
    const counts = async (bizId, payerId) => {
        const orders = await prisma.businessOrder.findMany({
            where: { businessProfileId: bizId }, select: { id: true },
        });
        const orderIds = orders.map(o => o.id);
        const tickets = await prisma.ticket.findMany({
            where: { businessProfileId: bizId }, select: { id: true },
        });
        return {
            orders: orders.length,
            items: orderIds.length
                ? await prisma.businessOrderItem.count({ where: { orderId: { in: orderIds } } })
                : 0,
            escrows: await prisma.smartEscrow.count({
                where: {
                    OR: [
                        { ticketId: { in: tickets.map(t => t.id) } },
                        ...(payerId ? [{ payerId }] : []),
                    ],
                },
            }),
            tickets: tickets.length,
            analytics: await prisma.storefrontAnalyticsEvent.count({ where: { businessProfileId: bizId } }),
        };
    };

    const placeOrder = (bizId, userId, body) => drive(handlerOf(legacyRouter, '/:businessProfileId/order'), {
        userId, businessProfileId: bizId, routePath: '/order', body,
    });
    const placeCheckout = (bizId, userId, body) => drive(handlerOf(legacyRouter, '/:businessProfileId/checkout'), {
        userId, businessProfileId: bizId, routePath: '/checkout', body,
    });

    // ── 1. multi-item checkout with an applicable GHS price ─────────────────
    test('1. multi-item checkout with an applicable GHS price → 409, zero side effects', async () => {
        const { biz, customer, product } = await seedShop({ escrow: true });
        const before = await counts(biz.id, customer.id);

        const res = await placeCheckout(biz.id, customer.id, {
            items: [{ productId: product.id, quantity: 2 }],
            paymentMode: 'ESCROW',
        });

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ success: false, code: 'GHS_CHECKOUT_UNAVAILABLE' });
        expect(typeof res.body.message).toBe('string');
        expect(await counts(biz.id, customer.id)).toEqual(before);
        expect(await prisma.businessOrder.count({ where: { businessProfileId: biz.id } })).toBe(0);
    });

    // ── 2. single-item checkout with an applicable GHS price ────────────────
    test('2. single-item order with an applicable GHS price → 409, zero side effects', async () => {
        const { biz, customer, product } = await seedShop();
        const before = await counts(biz.id, customer.id);

        const res = await placeOrder(biz.id, customer.id, { productId: product.id, quantity: 1 });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('GHS_CHECKOUT_UNAVAILABLE');
        expect(await counts(biz.id, customer.id)).toEqual(before);
    });

    // ── 3/4. BRANCH-scoped rows are NOT eligible in v1 ──────────────────────
    test('3. a BRANCH-scoped GHS price is not eligible and does not block checkout', async () => {
        const { biz, owner, customer, product } = await seedShop({ ghs: false });
        const location = await prisma.businessLocation.create({
            data: {
                businessProfileId: biz.id, label: 'Osu', address: 'A', latitude: 5.5, longitude: -0.2,
            },
        });
        await prisma.$transaction(async (tx) => {
            await priceService.setPrice(tx, {
                businessProductId: product.id, amountGhs: '99.00', scope: 'BRANCH',
                locationId: location.id, confirmedByType: 'BUSINESS', confirmedById: String(owner.id),
            });
        });

        // v1 eligibility is DEFAULT-scope only (businessPriceService header +
        // eligibleCurrentGhsPriceWhere): neither a matching nor a non-matching
        // branch confers a displayed GHS price, so the guard must not fire.
        const branchDecision = await priceService.resolveGhsCheckoutDecision(prisma, [product.id]);
        expect(branchDecision.block).toBe(false);

        const res = await placeOrder(biz.id, customer.id, { productId: product.id, quantity: 1 });
        expect(res.status).not.toBe(409);
        expect(res.status).toBe(201);
        expect(await prisma.businessOrder.count({ where: { businessProfileId: biz.id } })).toBe(1);
    });

    test('4. a DEFAULT price never applies to a different branch identity either', async () => {
        // DEFAULT scope is the GLOBAL identity (locationId null). A product with
        // a DEFAULT row blocks EVERY branch — there is no branch exemption.
        const { biz, customer, product } = await seedShop({ ghs: true });
        const location = await prisma.businessLocation.create({
            data: { businessProfileId: biz.id, label: 'Accra', address: 'B', latitude: 5.6, longitude: -0.1 },
        });
        const res = await placeOrder(biz.id, customer.id, {
            productId: product.id, quantity: 1, locationId: location.id,
        });
        expect(res.status).toBe(409);
        expect(await prisma.businessOrder.count({ where: { businessProfileId: biz.id } })).toBe(0);
    });

    // ── 5. DEFAULT scope blocks ─────────────────────────────────────────────
    test('5. a DEFAULT-scope confirmed price blocks both checkout routes', async () => {
        const { biz, customer, product } = await seedShop();
        expect((await placeOrder(biz.id, customer.id, { productId: product.id })).status).toBe(409);
        expect((await placeCheckout(biz.id, customer.id, { items: [{ productId: product.id }] })).status).toBe(409);
        expect(await prisma.businessOrder.count({ where: { businessProfileId: biz.id } })).toBe(0);
    });

    // ── 6. effective-date boundaries ────────────────────────────────────────
    test('6a. an UNCONFIRMED row confers no eligibility and does not block', async () => {
        const { biz, owner, customer, product } = await seedShop({ ghs: false });
        await prisma.$transaction(async (tx) => {
            await priceService.setPrice(tx, {
                businessProductId: product.id, amountGhs: '50.00', confirm: false,
                confirmedByType: 'MIGRATION', confirmedById: String(owner.id),
            });
        });
        expect((await priceService.resolveGhsCheckoutDecision(prisma, [product.id])).block).toBe(false);
        expect((await placeOrder(biz.id, customer.id, { productId: product.id })).status).toBe(201);
    });

    test('6b. a FUTURE-dated confirmed row is not eligible (fail closed on resolution)', async () => {
        const { biz, customer, product } = await seedShop({ ghs: false });
        await prisma.$transaction(async (tx) => {
            await priceService.setPrice(tx, {
                businessProductId: product.id, amountGhs: '50.00',
                confirmedByType: 'BUSINESS', confirmedById: '1',
            });
        });
        await prisma.businessPrice.updateMany({
            where: { businessProductId: product.id },
            data: { effectiveFrom: new Date(Date.now() + 24 * 3600_000) },
        });
        // WP-1.10A: a future-dated current identity is NOT "no GHS price" — the
        // strict semantics fail closed instead of allowing a USDC charge for an
        // item whose GHS price the platform is deliberately not yet showing.
        const decision = await priceService.resolveGhsCheckoutDecision(prisma, [product.id]);
        expect(decision.block).toBe(true);
        expect(decision.code).toBe('GHS_PRICE_STATE_UNRESOLVED');
        const res = await placeOrder(biz.id, customer.id, { productId: product.id });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ success: false, code: 'GHS_PRICE_STATE_UNRESOLVED' });
        expect(await prisma.businessOrder.count({ where: { businessProfileId: biz.id } })).toBe(0);
    });

    test('6c. an expired (effectiveTo set) row is not eligible', async () => {
        const { biz, customer, product } = await seedShop({ ghs: false });
        await prisma.$transaction(async (tx) => {
            await priceService.setPrice(tx, {
                businessProductId: product.id, amountGhs: '50.00',
                confirmedByType: 'BUSINESS', confirmedById: '1',
            });
        });
        // The DB CHECK requires effectiveTo > effectiveFrom, so backdate the
        // window first, then close it in the past: a genuinely expired row.
        await prisma.businessPrice.updateMany({
            where: { businessProductId: product.id },
            data: { effectiveFrom: new Date(Date.now() - 48 * 3600_000) },
        });
        await prisma.businessPrice.updateMany({
            where: { businessProductId: product.id },
            data: { effectiveTo: new Date(Date.now() - 3600_000) },
        });
        expect((await priceService.resolveGhsCheckoutDecision(prisma, [product.id])).block).toBe(false);
        expect((await placeOrder(biz.id, customer.id, { productId: product.id })).status).toBe(201);
    });

    // ── 7. genuinely USDC-only product ──────────────────────────────────────
    test('7. a product with NO applicable GHS price keeps the explicit USDC path', async () => {
        const { biz, customer, product } = await seedShop({ ghs: false });
        const res = await placeOrder(biz.id, customer.id, { productId: product.id, quantity: 2 });
        expect(res.status).toBe(201);
        const order = await prisma.businessOrder.findFirst({ where: { businessProfileId: biz.id } });
        expect(order).not.toBeNull();
        expect(Number(order.amountUsdc)).toBeCloseTo(100, 2); // factory price 50 x 2
    });

    // ── 8. bypass attempt from a direct API request ────────────────────────
    test('8. client-supplied price/currency/rate cannot defeat the guard', async () => {
        const { biz, customer, product } = await seedShop();
        const res = await placeCheckout(biz.id, customer.id, {
            items: [{ productId: product.id, priceGhs: null, priceUsdc: 1, currency: 'USDC', amount: 1 }],
            priceGhs: null, currency: 'USDC', amount: 1, totalAmount: 1, exchangeRate: 15.5,
            paymentMode: 'DIRECT', idempotencyKey: 'bypass-attempt',
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('GHS_CHECKOUT_UNAVAILABLE');
        expect(await prisma.businessOrder.count({ where: { businessProfileId: biz.id } })).toBe(0);
        expect(await prisma.businessOrder.findFirst({ where: { idempotencyKey: 'bypass-attempt' } })).toBeNull();
    });

    // ── 9. refusal cannot leave a partial record ───────────────────────────
    test('9. a refused request leaves no order, escrow, ticket, item or analytics row', async () => {
        const { biz, customer, product } = await seedShop({ ghs: true, secondProduct: true, escrow: true });
        const before = await counts(biz.id, customer.id);
        const res = await placeCheckout(biz.id, customer.id, {
            items: [{ productId: product.id }], paymentMode: 'ESCROW', idempotencyKey: 'refused-1',
        });
        expect(res.status).toBe(409);
        expect(await counts(biz.id, customer.id)).toEqual(before);
        expect(before).toEqual({ orders: 0, items: 0, escrows: 0, tickets: 0, analytics: 0 });
    });

    // ── 10. mixed basket: one GHS-priced item blocks the whole order ────────
    test('10. a mixed basket is refused entirely, not silently repriced', async () => {
        const { biz, customer, product, other } = await seedShop({ ghs: true, secondProduct: true });
        expect(other).not.toBeNull();
        const res = await placeCheckout(biz.id, customer.id, {
            items: [{ productId: other.id }, { productId: product.id }],
        });
        expect(res.status).toBe(409);
        expect(await prisma.businessOrder.count({ where: { businessProfileId: biz.id } })).toBe(0);
    });

    // ── parity: catalogue and guard share one resolver ─────────────────────
    test('parity. the catalogue priceGhs and the guard agree for every fixture', async () => {
        const { biz, owner, customer, product, other } = await seedShop({ ghs: true, secondProduct: true });
        const decision = await priceService.resolveGhsCheckoutDecision(prisma, [product.id, other.id]);
        expect(decision).toMatchObject({ block: true, code: 'GHS_CHECKOUT_UNAVAILABLE' });
        expect(decision.productIds).toEqual([product.id]);

        const listed = await priceService.resolveEffectiveGhsPrices(prisma, [product.id, other.id]);
        expect(listed.has(product.id)).toBe(true);
        expect(listed.has(other.id)).toBe(false);
        // The catalogue's own serialization of that row is the displayed string.
        expect(priceService.pesewasToGhsString(priceService.toPesewas(listed.get(product.id).amountExact)))
            .toBe('120.50');
        void owner; void customer; void biz;
    });

    // ── WP-1.10A: product-linked business ESCROW ticket path ───────────────
    // POST /api/tickets with businessProfileId + productId + type ESCROW is an
    // ALTERNATE purchase path for the same BusinessProduct: it defaults
    // escrowAmount from product.priceUsdc and creates Ticket + SmartEscrow +
    // BusinessOrder. It must refuse exactly like checkout.
    const ticketController = require('../controllers/ticketController');

    const postTicket = (userId, body) => new Promise((resolve, reject) => {
        const req = {
            app, params: {}, query: {}, body, headers: {},
            user: { id: userId }, get: (k) => app.get(k),
        };
        const res = mkRes();
        const originalJson = res.json.bind(res);
        res.json = (b) => { originalJson(b); resolve({ status: res.statusCode, body: res.body }); return res; };
        Promise.resolve(ticketController.createTicket(req, res)).catch(reject);
    });

    const ticketCounts = async (bizId) => ({
        tickets: await prisma.ticket.count({ where: { businessProfileId: bizId } }),
        escrows: await prisma.smartEscrow.count({
            where: { ticket: { businessProfileId: bizId } },
        }),
        orders: await prisma.businessOrder.count({ where: { businessProfileId: bizId } }),
        messages: await prisma.directMessage.count({
            where: { ticket: { businessProfileId: bizId } },
        }).catch(() => 0),
    });

    test('ticket-1. product-linked ESCROW ticket for a GHS-priced item → 409, no Ticket/escrow/order', async () => {
        const { biz, customer, product } = await seedShop({ ghs: true });
        const before = await ticketCounts(biz.id);

        const res = await postTicket(customer.id, {
            businessProfileId: biz.id, productId: product.id, type: 'ESCROW',
            name: 'Buy item', targetAmount: 50, targetCurrency: 'USDC',
        });

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ success: false, code: 'GHS_CHECKOUT_UNAVAILABLE' });
        expect(await ticketCounts(biz.id)).toEqual(before);
        expect(before).toEqual({ tickets: 0, escrows: 0, orders: 0, messages: 0 });
    });

    test('ticket-2. an explicit escrowAmount cannot route around the product price', async () => {
        const { biz, customer, product } = await seedShop({ ghs: true });
        const res = await postTicket(customer.id, {
            businessProfileId: biz.id, productId: product.id, type: 'ESCROW',
            name: 'Buy item', targetAmount: 50, targetCurrency: 'USDC', escrowAmount: 3,
        });
        expect(res.status).toBe(409);
        expect(await prisma.ticket.count({ where: { businessProfileId: biz.id } })).toBe(0);
    });

    test('ticket-3. a non-ESCROW business ticket about the same product is NOT blocked', async () => {
        const { biz, customer, product } = await seedShop({ ghs: true });
        const res = await postTicket(customer.id, {
            businessProfileId: biz.id, productId: product.id, type: 'BUY',
            name: 'Question about item', targetAmount: 1, targetCurrency: 'USDC',
        });
        // No financial record is created for a non-ESCROW ticket, so GHS
        // containment does not apply and unrelated ticket behaviour is intact.
        expect(res.status).not.toBe(409);
        expect(await prisma.ticket.count({ where: { businessProfileId: biz.id } })).toBe(1);
        expect(await prisma.smartEscrow.count({ where: { ticket: { businessProfileId: biz.id } } })).toBe(0);
    });

    test('ticket-4. product-linked ESCROW ticket for a USDC-only item still works', async () => {
        const { biz, customer, product } = await seedShop({ ghs: false });
        const res = await postTicket(customer.id, {
            businessProfileId: biz.id, productId: product.id, type: 'ESCROW',
            name: 'Buy item', targetAmount: 50, targetCurrency: 'USDC',
        });
        expect(res.status).not.toBe(409);
        expect(await prisma.ticket.count({ where: { businessProfileId: biz.id } })).toBe(1);
    });

    // ── WP-1.10A: idempotent replay must survive a later price change ──────
    test('replay-1. /order: a pre-price order replays on the same key, a new key refuses', async () => {
        const { biz, customer, product } = await seedShop({ ghs: false });
        const payload = { productId: product.id, quantity: 1, idempotencyKey: 'replay-key-1' };

        const first = await placeOrder(biz.id, customer.id, payload);
        expect(first.status).toBe(201);
        const originalId = first.body.data?.order?.id || first.body.data?.id || first.body.order?.id;
        expect(originalId).toBeTruthy();

        // The price becomes GHS-denominated AFTER the order exists.
        await prisma.$transaction(async (tx) => {
            await priceService.setPrice(tx, {
                businessProductId: product.id, amountGhs: '120.50',
                confirmedByType: 'BUSINESS', confirmedById: '1',
            });
        });

        const replay = await placeOrder(biz.id, customer.id, payload);
        expect(replay.status).toBe(200);
        expect(replay.body.data?.idempotent).toBe(true);

        const fresh = await placeOrder(biz.id, customer.id, {
            productId: product.id, quantity: 1, idempotencyKey: 'replay-key-2',
        });
        expect(fresh.status).toBe(409);
        expect(fresh.body.code).toBe('GHS_CHECKOUT_UNAVAILABLE');

        expect(await prisma.businessOrder.count({ where: { businessProfileId: biz.id } })).toBe(1);
        expect(await prisma.smartEscrow.count({ where: { payerId: customer.id } })).toBe(0);
    });

    test('replay-2. /checkout: a pre-price order replays on the same key, a new key refuses', async () => {
        const { biz, customer, product } = await seedShop({ ghs: false, escrow: true });
        const payload = {
            items: [{ productId: product.id, quantity: 1 }],
            paymentMode: 'ESCROW', idempotencyKey: 'replay-checkout-1',
        };

        const first = await placeCheckout(biz.id, customer.id, payload);
        expect(first.status).toBe(201);
        const escrowsAfterFirst = await prisma.smartEscrow.count({ where: { payerId: customer.id } });
        expect(escrowsAfterFirst).toBe(1);

        await prisma.$transaction(async (tx) => {
            await priceService.setPrice(tx, {
                businessProductId: product.id, amountGhs: '120.50',
                confirmedByType: 'BUSINESS', confirmedById: '1',
            });
        });

        const replay = await placeCheckout(biz.id, customer.id, payload);
        expect(replay.status).toBe(200);
        expect(replay.body.data?.idempotent).toBe(true);

        const fresh = await placeCheckout(biz.id, customer.id, {
            items: [{ productId: product.id, quantity: 1 }],
            paymentMode: 'ESCROW', idempotencyKey: 'replay-checkout-2',
        });
        expect(fresh.status).toBe(409);

        expect(await prisma.businessOrder.count({ where: { businessProfileId: biz.id } })).toBe(1);
        expect(await prisma.smartEscrow.count({ where: { payerId: customer.id } })).toBe(1);
    });

    // ── WP-1.10A: ambiguous current identity fails closed ─────────────────
    test('ambiguity-1. the database itself refuses two current DEFAULT rows', async () => {
        const { biz, product } = await seedShop({ ghs: true });
        void biz;
        await expect(prisma.businessPrice.create({
            data: {
                businessProductId: product.id, currency: 'GHS', amountExact: '10.00',
                scope: 'DEFAULT', locationId: null, status: 'ACTIVE',
                confirmedByType: 'BUSINESS', confirmedById: '1', confirmedAt: new Date(),
                effectiveFrom: new Date(),
            },
        })).rejects.toThrow(/unique|constraint/i);
    });

    test('ambiguity-2. classification fails closed when a corrupt row set is presented', async () => {
        // The partial unique index makes this state unreachable through the
        // database (proved above), so the classifier is exercised directly with
        // a two-row client double. This is a unit-level proof of the VERDICT,
        // not a claim about persistence.
        const { product } = await seedShop({ ghs: false });
        const now = new Date();
        const corruptClient = {
            businessPrice: {
                findMany: async () => ([
                    { businessProductId: product.id, effectiveFrom: now, confirmedAt: now, confirmedByType: 'BUSINESS' },
                    { businessProductId: product.id, effectiveFrom: now, confirmedAt: now, confirmedByType: 'ADMIN' },
                ]),
            },
        };
        const decision = await priceService.resolveGhsCheckoutDecision(corruptClient, [product.id]);
        expect(decision.block).toBe(true);
        expect(decision.code).toBe('GHS_PRICE_STATE_UNRESOLVED');
    });

    test('ambiguity-3. a missing pricing surface fails closed rather than assuming no price', async () => {
        const decision = await priceService.resolveGhsCheckoutDecision({}, [123]);
        expect(decision.block).toBe(true);
        expect(decision.code).toBe('GHS_PRICE_STATE_UNRESOLVED');
    });
});
