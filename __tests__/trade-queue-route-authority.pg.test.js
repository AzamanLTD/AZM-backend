// =============================================================================
// PR #360 — ROUTE-LEVEL trade-initiation authority (2026-10-20 review).
//
// The independent review found POST /api/ai/queue/initiate mounted with
// `protect` alone while queueController.initiateTradeWithQueue calls
// tradeController.initiateTrade directly on the available-capacity and
// capacity-freed paths — a direct JS call that does NOT execute the canonical
// route's protectActive / require2FA / idempotency stack, and leaves the
// idempotency disposition flags operating without any durable claim.
//
// The mount now runs the same guards as POST /api/trades/initiate, and the
// idempotency authority carries the EXPLICIT canonical identity
// 'POST /api/trades/initiate' so one logical trade = one durable claim across
// BOTH entry paths.
//
// This suite exercises the REAL middleware stack — a real Express app mounts
// the production route files (routes/tradeRoutes.js, routes/aiRoutes.js) with
// real protect / checkBan / require2FA / idempotency middleware, real JWTs,
// and a real PostgreSQL database — over real HTTP (fetch against a live
// listener). Coverage required by the review:
//   R1. missing idempotency-key refusal (no claim, no mutation)
//   R2. 2FA denial with zero mutation
//   R3. banned-user denial with zero mutation
//   R4. same-key CONCURRENT duplicates → exactly one trade; loser 409
//   R5. queue-only response CONVERGES on same-key retry (replay, one entry)
//   R6. queue-entry idempotency under a NEW key (already-queued, one entry)
//   R7. capacity-freed fallback → at most one trade, zero WAITING entries
//   R8. ad-inactive pre-economics 400 releases the claim (key reusable)
//   R9. shared identity across entry paths: a key committed on the canonical
//       route REPLAYS on the queue route — no second independent operation
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const express = require('express');
const speakeasy = require('speakeasy');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
const JWT_SECRET = 'test_secret_at_least_32_chars_long_xxxxx';
const TEST_PASSWORD = 'TestPass1!secure'; // factories.TEST_PASSWORD

run('r360-routes — queue-initiation shares the canonical trade authority (real stack)', () => {
    let prisma;
    let server;
    let base;
    const seededUsers = [];
    const seededAds = [];

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.JWT_SECRET = JWT_SECRET;
        prisma = new PrismaClient();
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

        // Real app, real production routers, real middleware order. The
        // production mount also carries rate limiters — transport concerns
        // outside the authority under test, deliberately omitted here.
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('socketio', { to: () => ({ emit: () => {} }) });
        app.set('emitBalanceUpdate', async () => {});
        app.use('/api/trades', require('../routes/tradeRoutes'));
        app.use('/api/ai', require('../routes/aiRoutes'));
        server = app.listen(0);
        base = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        if (server) await new Promise((r) => server.close(r));
        if (prisma) {
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

    // ── helpers ────────────────────────────────────────────────────────────
    const tokenOf = (user) => jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '1h' });
    const call = (path, { user, key, body }) => fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOf(user)}`,
            ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    const seed = async (overrides = {}) => {
        const buyer = await seedUser(prisma, { kycStatus: 'VERIFIED', ...overrides.buyer });
        const vendor = await seedUser(prisma, { role: 'VENDOR', ...overrides.vendor });
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
    const claimCount = (userId) => prisma.financialOperation.count({ where: { userId } });
    const tradesOf = (userId, vendorId) => prisma.trade.count({ where: { userId, vendorId } });
    const queueOf = (userId) => prisma.tradeQueue.count({ where: { buyerId: userId } });
    const keyBody = (adId, extra = {}) => ({ adId, amountCrypto: 50, amountFiat: 50, paymentMethod: 'MTN_MOMO', password: TEST_PASSWORD, ...extra });

    // ── R1. missing idempotency key ────────────────────────────────────────
    test('R1. no Idempotency-Key → deterministic 400 refusal before any claim or mutation', async () => {
        const { buyer, vendor, ad } = await seed();
        const out = await call('/api/ai/queue/initiate', { user: buyer, body: keyBody(ad.id) });
        expect(out.status).toBe(400);
        expect(out.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
        expect(await claimCount(buyer.id)).toBe(0);
        expect(await tradesOf(buyer.id, vendor.id)).toBe(0);
        expect(await queueOf(buyer.id)).toBe(0);
    });

    // ── R2. 2FA denial with zero mutation ──────────────────────────────────
    test('R2. 2FA-enabled user without totpToken → 401 2FA_REQUIRED, zero claim/mutation', async () => {
        const secret = speakeasy.generateSecret({ length: 20 });
        const { buyer, vendor, ad } = await seed({ buyer: { isTwoFactorEnabled: true, twoFactorSecret: secret.base32 } });
        const out = await call('/api/ai/queue/initiate', { user: buyer, key: `r360-r2-${Date.now()}`, body: keyBody(ad.id) });
        expect(out.status).toBe(401);
        expect(out.body.code).toBe('2FA_REQUIRED');
        expect(await claimCount(buyer.id)).toBe(0);
        expect(await tradesOf(buyer.id, vendor.id)).toBe(0);
        expect(await queueOf(buyer.id)).toBe(0);
    });

    // ── R3. banned-user denial with zero mutation ───────────────────────────
    test('R3. banned user → protectActive refusal before any claim or mutation', async () => {
        const { buyer, vendor, ad } = await seed({ buyer: { banStatus: 'BANNED_INDEF' } });
        const out = await call('/api/ai/queue/initiate', { user: buyer, key: `r360-r3-${Date.now()}`, body: keyBody(ad.id) });
        expect(out.status).toBe(403);
        expect(await claimCount(buyer.id)).toBe(0);
        expect(await tradesOf(buyer.id, vendor.id)).toBe(0);
        expect(await queueOf(buyer.id)).toBe(0);
    });

    // ── R4. concurrent same-key duplicates → exactly one trade ─────────────
    test('R4. two CONCURRENT /queue/initiate with one key, capacity available → exactly ONE trade; loser refused', async () => {
        const { buyer, vendor, ad } = await seed();
        const key = `r360-r4-${Date.now()}`;
        const body = keyBody(ad.id);
        const [a, b] = await Promise.all([
            call('/api/ai/queue/initiate', { user: buyer, key, body }),
            call('/api/ai/queue/initiate', { user: buyer, key, body }),
        ]);
        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([201, 409]);
        expect(await tradesOf(buyer.id, vendor.id)).toBe(1);
        expect(await queueOf(buyer.id)).toBe(0);
    });

    // ── R5. queue-only response converges on same-key retry ────────────────
    test('R5. busy vendor → queued 200; SAME-key retry replays the stored response, exactly one entry', async () => {
        const { buyer, vendor, ad } = await seed();
        const busy = await seedUser(prisma, { kycStatus: 'VERIFIED' });
        seededUsers.push(busy.id);
        await prisma.trade.create({ data: {
            userId: busy.id, vendorId: vendor.id,
            crypto: 'USDC', amountCrypto: 50, amountFiat: 50, currency: 'USD',
            type: 'SELL', rate: 1, paymentMethod: 'MTN_MOMO',
            status: 'PENDING_PAYMENT',
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } });

        const key = `r360-r5-${Date.now()}`;
        const body = keyBody(ad.id);
        const first = await call('/api/ai/queue/initiate', { user: buyer, key, body });
        expect(first.status).toBe(200);
        expect(first.body.queued).toBe(true);

        // The 200 bookkeeping marks the claim COMMITTED (post-response,
        // fire-and-forget) — poll for convergence before the retry.
        const converged = await waitFor(async () => {
            const c = await prisma.financialOperation.findFirst({
                where: { userId: buyer.id, key, status: 'COMMITTED' },
            });
            return c ? 'COMMITTED' : null;
        });
        expect(converged).toBe('COMMITTED');

        const retry = await call('/api/ai/queue/initiate', { user: buyer, key, body });
        expect(retry.status).toBe(200);
        expect(retry.body).toEqual(first.body); // byte-meaningful replay
        expect(await queueOf(buyer.id)).toBe(1); // still exactly one entry
    });

    // ── R6. queue-entry idempotency under a NEW key ────────────────────────
    test('R6. already queued with a DIFFERENT key → 200 already-queued, still one entry', async () => {
        const { buyer, vendor, ad } = await seed();
        const busy = await seedUser(prisma, { kycStatus: 'VERIFIED' });
        seededUsers.push(busy.id);
        await prisma.trade.create({ data: {
            userId: busy.id, vendorId: vendor.id,
            crypto: 'USDC', amountCrypto: 50, amountFiat: 50, currency: 'USD',
            type: 'SELL', rate: 1, paymentMethod: 'MTN_MOMO',
            status: 'PENDING_PAYMENT',
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } });

        const first = await call('/api/ai/queue/initiate', { user: buyer, key: `r360-r6a-${Date.now()}`, body: keyBody(ad.id) });
        expect(first.status).toBe(200);
        const second = await call('/api/ai/queue/initiate', { user: buyer, key: `r360-r6b-${Date.now()}`, body: keyBody(ad.id) });
        expect(second.status).toBe(200);
        expect(second.body.message).toBe('You are already in the queue for this ad.');
        expect(await queueOf(buyer.id)).toBe(1);
        expect(await tradesOf(buyer.id, vendor.id)).toBe(0);
    });

    // ── R7. capacity-freed fallback: at most one trade, zero WAITING ───────
    test('R7. capacity freed under the admission lock → one trade via the real route, zero WAITING entries; replay holds', async () => {
        const { buyer, vendor, ad } = await seed();
        // Deterministic interleave: the OUTER optimistic count reports busy
        // while the locked recount sees the truth (capacity available).
        const spy = jest.spyOn(prisma.trade, 'count').mockImplementationOnce(async () => 1);
        const key = `r360-r7-${Date.now()}`;
        const body = keyBody(ad.id);
        let first;
        try {
            first = await call('/api/ai/queue/initiate', { user: buyer, key, body });
        } finally {
            spy.mockRestore();
        }
        expect(first.status).toBe(201);
        expect(first.body.success).toBe(true);
        expect(await tradesOf(buyer.id, vendor.id)).toBe(1);
        expect(await queueOf(buyer.id)).toBe(0);

        const converged = await waitFor(async () => {
            const c = await prisma.financialOperation.findFirst({
                where: { userId: buyer.id, key, status: 'COMMITTED' },
            });
            return c ? 'COMMITTED' : null;
        });
        expect(converged).toBe('COMMITTED');
        const retry = await call('/api/ai/queue/initiate', { user: buyer, key, body });
        expect(retry.status).toBe(201); // replay of the stored trade response
        expect(await tradesOf(buyer.id, vendor.id)).toBe(1); // at most one
        expect(await queueOf(buyer.id)).toBe(0);
    });

    // ── R8. ad-inactive pre-economics 400 releases the claim ───────────────
    test('R8. inactive ad via the queue route → 400, claim RELEASED, key reusable after reactivation', async () => {
        const { buyer, vendor, ad } = await seed();
        await prisma.ad.update({ where: { id: ad.id }, data: { status: 'OFFLINE' } });
        const key = `r360-r8-${Date.now()}`;
        const out = await call('/api/ai/queue/initiate', { user: buyer, key, body: keyBody(ad.id) });
        expect(out.status).toBe(400);

        const released = await waitFor(async () => {
            const c = await prisma.financialOperation.findFirst({ where: { userId: buyer.id, key } });
            return c === null ? 'RELEASED' : null;
        });
        expect(released).toBe('RELEASED');
        expect(await tradesOf(buyer.id, vendor.id)).toBe(0);
        expect(await queueOf(buyer.id)).toBe(0);

        await prisma.ad.update({ where: { id: ad.id }, data: { status: 'ACTIVE' } });
        const retry = await call('/api/ai/queue/initiate', { user: buyer, key, body: keyBody(ad.id) });
        expect([201, 200]).toContain(retry.status);
        expect(retry.body.success).toBe(true);
        expect(await tradesOf(buyer.id, vendor.id)).toBe(1);
    });

    // ── R9. shared identity across BOTH entry paths ────────────────────────
    test('R9. key committed on the CANONICAL route REPLAYS on the queue route — one identity, no second operation', async () => {
        const { buyer, vendor, ad } = await seed();
        const key = `r360-r9-${Date.now()}`;
        const body = keyBody(ad.id);
        const canonical = await call('/api/trades/initiate', { user: buyer, key, body });
        expect(canonical.status).toBe(201);
        expect(await tradesOf(buyer.id, vendor.id)).toBe(1);

        const converged = await waitFor(async () => {
            const c = await prisma.financialOperation.findFirst({
                where: { userId: buyer.id, key, status: 'COMMITTED' },
            });
            return c ? 'COMMITTED' : null;
        });
        expect(converged).toBe('COMMITTED');

        // Same key + same body on the QUEUE entry path: the shared explicit
        // identity must make this a REPLAY of the committed operation — never
        // a second independent claim that could create a second trade.
        const viaQueue = await call('/api/ai/queue/initiate', { user: buyer, key, body });
        expect(viaQueue.status).toBe(201);
        expect(viaQueue.body).toEqual(canonical.body);
        expect(await tradesOf(buyer.id, vendor.id)).toBe(1);
        expect(await queueOf(buyer.id)).toBe(0);
        // Exactly ONE durable claim for this logical operation across paths.
        expect(await prisma.financialOperation.count({ where: { userId: buyer.id, key } })).toBe(1);
    });
});
