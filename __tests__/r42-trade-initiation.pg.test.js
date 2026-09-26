'use strict';

// =============================================================================
// §r42 — TRADE INITIATION REGRESSION (real PostgreSQL).
//
// Independent review finding (PR #311, follow-up to 2d8ea9e): the route
// declared `idempotency({ releaseOn4xx: true })` while initiateTrade() had
// NO in-transaction FinancialOperation transition — a post-commit failure
// surfacing as 4xx would delete the claim and admit a SECOND trade on the
// same key. The declaration was removed; the route now uses the
// conservative default (retain on 4xx) and the controller marks only its
// provably pre-economics guards releasable.
//
// Proofs against the REAL idempotency middleware + REAL initiateTrade
// controller + REAL transaction:
//
//  T1.  Post-commit failure (emitBalanceUpdate throws AFTER the trade
//       $transaction commits) → HTTP 4xx via the outer catch, the claim is
//       RETAINED (IN_PROGRESS), the trade committed exactly ONCE, and a
//       same-key retry can NEVER create a second trade/queue entry.
//  T2.  Concurrent duplicates (same user + endpoint + key + payload) →
//       exactly ONE trade; the loser never enters the trade mutation path
//       (409 IDEMPOTENCY_IN_PROGRESS).
//  T3.  Pre-economic validation 4xx (amount below the ad minimum) → the
//       explicit financialClaimRelease mark releases the claim; the same
//       key stays REUSABLE and a corrected retry succeeds.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');
const { idempotency } = require('../middleware/idempotency');
const { initiateTrade } = require('../controllers/tradeController');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const ENDPOINT = 'POST /api/trades/initiate';

run('r42 — trade initiation idempotency regression (PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
    });
    afterAll(async () => { await prisma?.$disconnect(); });

    beforeEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "FinancialOperation", "Trade", "TradeQueue", "Ad", "GlobalSettings", "TransactionHistory", "User" RESTART IDENTITY CASCADE'
        );
        await prisma.globalSettings.create({ data: { id: 1 } });
    });

    // ── Harness ─────────────────────────────────────────────────────────────
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
                    if (!this.headersSent) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); }
                    return this;
                },
                setHeader() {},
                end() { this.headersSent = true; resolve({ status: this.statusCode, body: null }); return this; },
            };
            // The production mount is idempotency() — required key, retain on
            // 4xx, no releaseOn4xx. protectActive/require2FA are auth concerns
            // upstream of the idempotency claim and are irrelevant here.
            idempotency()(req, res, (err) => (err
                ? reject(err)
                : Promise.resolve(initiateTrade(req, res)).catch((e) => reject(e))));
        });
        return { drive };
    };

    const seed = async () => {
        const buyer = await seedUser(prisma, { kycStatus: 'VERIFIED' });
        const vendor = await seedUser(prisma, { role: 'VENDOR' });
        const ad = await prisma.ad.create({ data: {
            type: 'SELL', crypto: 'USDC', pricePerUSD: 1,
            minLimit: 5, maxLimit: 500, paymentMethod: 'MTN_MOMO',
            status: 'ACTIVE', maxConcurrentTrades: 1, vendorId: vendor.id,
        } });
        return { buyer, vendor, ad };
    };

    // Post-response claim bookkeeping is deliberately fire-and-forget in the
    // middleware: poll for the converged claim state instead of racing it.
    const claimOf = async (userId, key) => prisma.financialOperation.findUnique({
        where: { userId_endpoint_key: { userId, endpoint: ENDPOINT, key } },
    });
    const waitFor = async (fn, timeoutMs = 5000) => {
        const t0 = Date.now();
        for (;;) {
            const v = await fn();
            if (v) return v;
            if (Date.now() - t0 > timeoutMs) return null;
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    // ── T1 ──────────────────────────────────────────────────────────────────
    test('T1. post-commit failure → 4xx RETAINS the claim; trade committed once; same-key retry refused', async () => {
        const { buyer, ad } = await seed();
        // Deterministic post-commit failure: emitBalanceUpdate runs AFTER the
        // $transaction (which creates the trade) has committed.
        const { drive } = buildDriver({
            emitBalanceUpdate: async () => { throw new Error('balance socket pipeline failed'); },
        });

        const first = await drive({ user: buyer.id, key: 'ti-1', body: { adId: ad.id, amountCrypto: 50, amountFiat: 50 } });
        // The outer catch converts the post-commit failure to a 400 — the
        // exact sequence that used to delete the claim under releaseOn4xx.
        expect(first.status).toBe(400);

        // The trade DID commit — exactly once.
        const trades = await prisma.trade.findMany({ where: { userId: buyer.id } });
        expect(trades.length).toBe(1);
        expect(await prisma.tradeQueue.count()).toBe(0);

        // The claim is RETAINED: a same-key retry is deterministically refused
        // and can NEVER create a second trade or queue entry.
        const claim = await claimOf(buyer.id, 'ti-1');
        expect(claim).not.toBeNull();
        expect(claim.status).toBe('IN_PROGRESS');

        const retry = await drive({ user: buyer.id, key: 'ti-1', body: { adId: ad.id, amountCrypto: 50, amountFiat: 50 } });
        expect(retry.status).toBe(409);
        expect(retry.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        expect((await prisma.trade.findMany({ where: { userId: buyer.id } })).length).toBe(1);
        expect(await prisma.tradeQueue.count()).toBe(0);
    }, 20000);

    // ── T2 ──────────────────────────────────────────────────────────────────
    test('T2. concurrent duplicates → exactly ONE trade; the loser never enters the mutation path', async () => {
        const { buyer, ad } = await seed();
        const { drive } = buildDriver();

        const payload = { adId: ad.id, amountCrypto: 50, amountFiat: 50 };
        const results = await Promise.all([
            drive({ user: buyer.id, key: 'ti-2', body: payload }),
            drive({ user: buyer.id, key: 'ti-2', body: payload }),
        ]);

        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([201, 409]);
        const winner = results.find((r) => r.status === 201);
        const loser = results.find((r) => r !== winner);
        expect(loser.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');

        // Exactly one trade; the queue path never engaged.
        expect(await prisma.trade.count({ where: { userId: buyer.id } })).toBe(1);
        expect(await prisma.tradeQueue.count()).toBe(0);

        // The winner's claim converges on COMMITTED (post-response
        // bookkeeping is fire-and-forget — poll, don't race it).
        const claim = await waitFor(async () => {
            const c = await claimOf(buyer.id, 'ti-2');
            return c && c.status === 'COMMITTED' ? c : null;
        });
        expect(claim).not.toBeNull();

        // Wire-identical replay of the committed result, zero new mutation.
        // (The first result holds live Prisma Decimal instances; the replay
        // holds the stored body. Normalize both through the JSON wire —
        // over HTTP a client sees byte-identical payloads.)
        const replay = await drive({ user: buyer.id, key: 'ti-2', body: payload });
        expect(replay.status).toBe(201);
        expect(JSON.parse(JSON.stringify(replay.body))).toEqual(JSON.parse(JSON.stringify(winner.body)));
        expect(await prisma.trade.count({ where: { userId: buyer.id } })).toBe(1);
    }, 20000);

    // ── T3 ──────────────────────────────────────────────────────────────────
    test('T3. pre-economic validation 4xx → explicit release; the key stays reusable', async () => {
        const { buyer, ad } = await seed();
        const { drive } = buildDriver();

        // Amount below the ad's minLimit — a pre-economics guard that runs
        // BEFORE the $transaction and marks the claim releasable.
        const bad = await drive({ user: buyer.id, key: 'ti-3', body: { adId: ad.id, amountCrypto: 1, amountFiat: 1 } });
        expect(bad.status).toBe(400);

        // The claim was RELEASED (deleted) — poll for convergence of the
        // fire-and-forget post-response release.
        expect(await waitFor(async () => (await claimOf(buyer.id, 'ti-3')) === null)).toBe(true);
        expect(await prisma.trade.count()).toBe(0);

        // The SAME key is reusable: a corrected payload executes normally.
        const good = await drive({ user: buyer.id, key: 'ti-3', body: { adId: ad.id, amountCrypto: 50, amountFiat: 50 } });
        expect(good.status).toBe(201);
        expect(await prisma.trade.count({ where: { userId: buyer.id } })).toBe(1);
    }, 20000);
});
