// =============================================================================
// PR #360 final follow-up (2026-10-20) — real-PostgreSQL regression proofs for
//
//   A. IDENTITY DISPOSITION of the locked ad-inactive rejection in
//      tradeController.initiateTrade: a request refused by the in-transaction
//      status recheck is PROVABLY PRE-ECONOMIC, so its §r42 idempotency claim
//      must be RELEASED (not poisoned IN_PROGRESS), and the same key stays
//      reusable for a corrected retry. The locked recheck and locking behavior
//      are unchanged; duplicate/replay guarantees stay owned by the r42 suite.
//
//   B. QUEUE-ADMISSION CAPACITY RECHECK in
//      queueController.initiateTradeWithQueue: when a trade slot frees up
//      between the optimistic busy count and the locked admission, NO WAITING
//      entry is created — the buyer proceeds through the canonical
//      trade-initiation path instead of being left waiting despite available
//      capacity.
//
// Deterministic orchestration uses jest.spyOn side-effects (deactivate the ad
// during the handler's pre-transaction settings read; fake the optimistic busy
// count while the locked in-transaction recount sees the truth). No production
// code is monkey-patched — only client-method observation, restored after each
// test. Self-cleaning rows via unique prefixes.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');
const { idempotency } = require('../middleware/idempotency');
const { initiateTrade } = require('../controllers/tradeController');
const queueController = require('../controllers/queueController');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r360-final — admission capacity + ad-inactive idempotency (PostgreSQL)', () => {
    let prisma;
    const seededUsers = [];
    const seededAds = [];

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) {
            // Children first (FK orders): conversation → transaction history
            // → trades/queue → ads → claims → users. The canonical trade
            // path writes TransactionHistory and trade-scoped Conversation
            // rows, so both must go before their users.
            const trades = await prisma.trade.findMany({
                where: { OR: [{ userId: { in: seededUsers } }, { vendorId: { in: seededUsers } }] },
                select: { id: true },
            });
            const tradeIds = trades.map((t) => String(t.id));
            if (tradeIds.length > 0) {
                await prisma.conversation.deleteMany({ where: { tradeId: { in: tradeIds } } });
            }
            await prisma.transactionHistory.deleteMany({
                where: { OR: [{ userId: { in: seededUsers } }, { initiatedByUserId: { in: seededUsers } }] },
            });
            await prisma.trade.deleteMany({ where: { OR: [{ userId: { in: seededUsers } }, { vendorId: { in: seededUsers } }] } });
            await prisma.tradeQueue.deleteMany({ where: { buyerId: { in: seededUsers } } });
            await prisma.ad.deleteMany({ where: { id: { in: seededAds } } });
            await prisma.financialOperation.deleteMany({ where: { userId: { in: seededUsers } } });
            await prisma.user.deleteMany({ where: { id: { in: seededUsers } } });
            await prisma.$disconnect();
        }
    });

    const buildDriver = (opts = {}) => {
        const app = {
            settings: {}, get(k) { return this.settings[k]; }, set(k, v) { this.settings[k] = v; },
        };
        app.set('prisma', prisma);
        app.set('socketio', { to: () => ({ emit: () => {} }) });
        app.set('emitBalanceUpdate', opts.emitBalanceUpdate || (async () => {}));
        const drive = ({ user, key, body }) => new Promise((resolve, reject) => {
            const req = {
                method: 'POST', originalUrl: '/api/trades/initiate',
                path: '/api/trades/initiate', url: '/api/trades/initiate',
                baseUrl: '', route: { path: '/api/trades/initiate' },
                headers: key ? { 'idempotency-key': key } : {},
                params: {}, query: {}, body: body || {},
                app, get: (k) => app.get(k),
                user: { id: user },
            };
            const res = {
                app, locals: {}, statusCode: 200, headersSent: false,
                status(c) { this.statusCode = c; return this; },
                json(b) {
                    if (!this.headersSent) {
                        this.headersSent = true;
                        resolve({ status: this.statusCode, body: b });
                    }
                    return this;
                },
                setHeader() {},
                end() { this.headersSent = true; resolve({ status: this.statusCode, body: null }); return this; },
            };
            idempotency()(req, res, (err) => (err
                ? reject(err)
                : Promise.resolve(initiateTrade(req, res)).catch((e) => reject(e))));
        });
        return { drive };
    };

    // Non-idempotent driver for the /queue/initiate admission surface (its
    // production mount carries NO idempotency middleware).
    const driveQueue = ({ user, body }) => new Promise((resolve, reject) => {
        const app = { settings: {}, get(k) { return this.settings[k]; }, set(k, v) { this.settings[k] = v; } };
        app.set('prisma', prisma);
        app.set('socketio', { to: () => ({ emit: () => {} }) });
        const req = {
            method: 'POST', originalUrl: '/api/queue/initiate',
            path: '/api/queue/initiate', url: '/api/queue/initiate',
            baseUrl: '', route: { path: '/api/queue/initiate' },
            headers: {}, params: {}, query: {}, body,
            app, get: (k) => app.get(k),
            user: { id: user },
        };
        const res = {
            app, locals: {}, statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { if (!this.headersSent) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); } return this; },
            setHeader() {},
            end() { this.headersSent = true; resolve({ status: this.statusCode, body: null }); return this; },
        };
        Promise.resolve(queueController.initiateTradeWithQueue(req, res)).catch((e) => reject(e));
    });

    const seed = async () => {
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
        const buyer = await seedUser(prisma, { kycStatus: 'VERIFIED' });
        const vendor = await seedUser(prisma, { role: 'VENDOR' });
        const ad = await prisma.ad.create({ data: {
            type: 'SELL', crypto: 'USDC', pricePerUSD: 1,
            minLimit: 5, maxLimit: 500, paymentMethod: 'MTN_MOMO',
            status: 'ACTIVE', maxConcurrentTrades: 1, vendorId: vendor.id,
        } });
        seededUsers.push(buyer.id, vendor.id);
        seededAds.push(ad.id);
        return { buyer, vendor, ad };
    };

    const waitFor = async (fn, timeoutMs = 5000) => {
        const t0 = Date.now();
        for (;;) {
            const v = await fn();
            if (v !== undefined && v !== null) return v;
            if (Date.now() - t0 > timeoutMs) return null;
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    const claimOf = (userId, key) => prisma.financialOperation.findUnique({
        where: { userId_endpoint_key: { userId, endpoint: 'POST /api/trades/initiate', key } },
    });

    // ── A. ad-inactive rejection releases its §r42 claim ────────────────────
    test('A. locked ad-inactive rejection → 400 + claim RELEASED; same key reusable; no trade/queue created', async () => {
        const { buyer, vendor, ad } = await seed();
        const { drive } = buildDriver();
        const key = `r360-a-${Date.now()}`;

        // Deterministic interleave: the ad is ACTIVE at the handler's
        // optimistic status check (line ~142) and goes inactive DURING the
        // pre-transaction GlobalSettings read — so the FIRST statement of the
        // economic transaction (the locked recheck) sees a non-ACTIVE ad and
        // returns { adInactive: true } with zero mutations.
        const originalSettingsFind = prisma.globalSettings.findUnique.bind(prisma.globalSettings);
        const spy = jest.spyOn(prisma.globalSettings, 'findUnique')
            .mockImplementation(async (...args) => {
                await prisma.ad.update({ where: { id: ad.id }, data: { status: 'OFFLINE' } });
                return originalSettingsFind(...args);
            });

        let out;
        try {
            out = await drive({ user: buyer.id, key, body: { adId: ad.id, amountCrypto: 50, amountFiat: 50 } });
        } finally {
            spy.mockRestore();
        }

        expect(out.status).toBe(400);
        expect(out.body.message).toBe('This advertisement is not active.');

        // Nothing economic happened.
        const trades = await prisma.trade.count({ where: { userId: buyer.id, vendorId: vendor.id } });
        const entries = await prisma.tradeQueue.count({ where: { buyerId: buyer.id } });
        expect(trades).toBe(0);
        expect(entries).toBe(0);

        // The claim must CONVERGE to released (row deleted), not poisoned
        // IN_PROGRESS. The release is made durable before the response is
        // sent, but poll anyway.
        const claimAfterRelease = await waitFor(async () => {
            const c = await claimOf(buyer.id, key);
            return c === null ? 'RELEASED' : null;
        });
        expect(claimAfterRelease).toBe('RELEASED');

        // Reactivate the ad; the SAME key must be reusable — the corrected
        // retry executes fresh instead of a 409 IDEMPOTENCY_IN_PROGRESS.
        await prisma.ad.update({ where: { id: ad.id }, data: { status: 'ACTIVE' } });
        const retry = await drive({ user: buyer.id, key, body: { adId: ad.id, amountCrypto: 50, amountFiat: 50 } });
        expect([201, 200]).toContain(retry.status);
        expect(retry.body.success).toBe(true);
        const tradesAfterRetry = await prisma.trade.count({ where: { userId: buyer.id, vendorId: vendor.id } });
        expect(tradesAfterRetry).toBe(1);
    });

    // ── A2. an already-inactive ad at the optimistic check never even claims
    //        long enough to poison a key (pre-economic 4xx before the tx).
    test('A2. pre-economics optimistic rejection stays claim-free/released — guarantees intact', async () => {
        const { buyer, vendor, ad } = await seed();
        const { drive } = buildDriver();
        const key = `r360-a2-${Date.now()}`;

        await prisma.ad.update({ where: { id: ad.id }, data: { status: 'OFFLINE' } });
        const out = await drive({ user: buyer.id, key, body: { adId: ad.id, amountCrypto: 50, amountFiat: 50 } });
        expect(out.status).toBe(400);
        const converged = await waitFor(async () => {
            const c = await claimOf(buyer.id, key);
            return c === null ? 'RELEASED' : null;
        });
        expect(converged).toBe('RELEASED');
        expect(await prisma.trade.count({ where: { userId: buyer.id, vendorId: vendor.id } })).toBe(0);
    });

    // ── B. freed capacity does NOT create a WAITING entry ────────────────────
    test('B. slot freed between optimistic count and locked recheck → canonical trade created, NO queue entry', async () => {
        const { buyer, vendor, ad } = await seed();

        // Deterministic interleave: the OUTER optimistic count reports the
        // vendor busy (fake 1 active trade), but the locked in-transaction
        // recount sees the truth (0 < maxConcurrentTrades=1) — the exact
        // free-up window Finding B describes. Only the outer call is faked;
        // the transaction client (tx.trade.count) is a distinct delegate and
        // runs the real query.
        const spy = jest.spyOn(prisma.trade, 'count')
            .mockImplementationOnce(async () => 1);

        try {
            const out = await driveQueue({ user: buyer.id, body: { adId: ad.id, amountCrypto: 50, amountFiat: 50 } });
            // The canonical path answers — capacity was available.
            expect(out.status).toBe(201);
            expect(out.body.success).toBe(true);
        } finally {
            spy.mockRestore();
        }

        // The buyer got a TRADE, not a WAITING entry.
        const trades = await prisma.trade.count({ where: { userId: buyer.id, vendorId: vendor.id } });
        const entries = await prisma.tradeQueue.count({ where: { buyerId: buyer.id } });
        expect(trades).toBe(1);
        expect(entries).toBe(0);
    });

    // ── B2. a genuinely busy vendor still queues (admission intact) ─────────
    test('B2. genuinely busy vendor (locked recount confirms) → WAITING entry created, dedup + position intact', async () => {
        const { buyer, vendor, ad } = await seed();

        // Seed one real in-progress trade: capacity genuinely full.
        const busyBuyer = await seedUser(prisma, { kycStatus: 'VERIFIED' });
        seededUsers.push(busyBuyer.id);
        await prisma.trade.create({ data: {
            userId: busyBuyer.id, vendorId: vendor.id,
            crypto: 'USDC', amountCrypto: 50, amountFiat: 50, currency: 'USD',
            type: 'SELL', rate: 1, paymentMethod: 'MTN_MOMO',
            status: 'PENDING_PAYMENT',
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } });

        const out = await driveQueue({ user: buyer.id, body: { adId: ad.id, amountCrypto: 50, amountFiat: 50 } });
        expect(out.status).toBe(200);
        expect(out.body.queued).toBe(true);
        expect(out.body.queuePosition).toBe(1);

        const entries = await prisma.tradeQueue.count({ where: { buyerId: buyer.id, status: 'WAITING' } });
        expect(entries).toBe(1);

        // Dedup preserved: a second admission is a no-op (already queued).
        const again = await driveQueue({ user: buyer.id, body: { adId: ad.id, amountCrypto: 50, amountFiat: 50 } });
        expect(again.body.message).toBe('You are already in the queue for this ad.');
        const entriesAfter = await prisma.tradeQueue.count({ where: { buyerId: buyer.id, status: 'WAITING' } });
        expect(entriesAfter).toBe(1);
    });
});
