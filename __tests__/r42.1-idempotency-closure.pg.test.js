'use strict';

// =============================================================================
// §r42.1 — SHARED FINANCIAL IDEMPOTENCY CLOSURE (real PostgreSQL).
//
// Second wired tranche. Five money-moving endpoints were promoted from the
// "middleware-protected, claim commits post-response" class to the WIRED
// contract: the FinancialOperation claim commits to COMMITTED with the exact
// wire responseBody INSIDE the endpoint's economic $transaction, so the
// economics and the committed-response identity commit or roll back together.
//
//   E1. POST /api/escrow/fund         — payer locks USDC principal + fee
//   E2. POST /api/azm-convert         — AZM → USDC redemption from profit pool
//   E3. POST /api/azm-gifts/send      — P2P AZM gift/tip transfer
//   E4. POST /api/order-book/orders   — order placement (AZM/USDC reserve + match)
//   E5. POST /api/p2p/complete        — P2P trade settlement (escrow release)
//
// Every route mounts idempotency({ releaseOn4xx: true }) — valid ONLY because
// the claim commits inside the economic transaction: a post-response
// IN_PROGRESS claim is durable proof the transaction rolled back, so the key
// is safely releasable. A post-commit failure surfacing as 4xx can no longer
// delete a committed claim (the in-tx COMMITTED state wins the CAS).
//
// Failure/recovery matrix proven here per endpoint (where the semantics
// exist):
//   A. first execution — exactly one economic mutation; claim COMMITTED;
//      stored responseBody IS the exact wire response.
//   B. same-key replay — byte-identical wire response; no second mutation.
//   C. concurrent duplicates — one execution; loser 409 IN_PROGRESS.
//   E. divergent payload — deterministic 409 IDEMPOTENCY_PAYLOAD_CONFLICT;
//      original committed operation untouched.
//   F. missing key — deterministic 400 IDEMPOTENCY_KEY_REQUIRED; no claim;
//      no economics.
//   G. pre-economic 4xx — claim released; the SAME key retries successfully
//      once corrected.
//   H. crash-after-commit — money committed exactly once; the claim is already
//      COMMITTED; same-key retry replays; economics never re-execute.
//   I. parked IN_PROGRESS claim — same key refuses (409); no blind execution.
//
// Matrix D (divergent legacy alias) is structurally N/A for this tranche: none
// of the five endpoints accepts a legacy clientRequestId/requestId body
// identity — the canonical Idempotency-Key header is the only request identity
// (asserted below by fingerprinting the alias field into the payload, which
// makes it part of the material-payload comparison, not an alternative
// identity path).
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { seedUser, seedEscrowTicket, seedPaidTrade } = require('./helpers/factories');
const { idempotency } = require('../middleware/idempotency');
const escrowController = require('../controllers/escrowController');
const conversionController = require('../controllers/azmConversionController');
const giftController = require('../controllers/azmGiftController');
const orderBookController = require('../controllers/orderBookController');
const p2pController = require('../controllers/p2p.controller');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const EP = {
    escrow: 'POST /api/escrow/fund',
    convert: 'POST /api/azm-convert',
    gift: 'POST /api/azm-gifts/send',
    order: 'POST /api/order-book/orders',
    p2p: 'POST /api/p2p/complete',
};

run('r42.1 — shared idempotency closure, second wired tranche (PostgreSQL)', () => {
    let prisma;

    // CI machines are slower: a just-resolved supertest call can leave a
    // Prisma pool connection still draining its last writes while this
    // suite's wide TRUNCATE grabs table locks one by one, and PostgreSQL
    // reports 40P01 (deadlock) between the two. Draining the event loop
    // and retrying once the straggler finishes is enough to settle it.
    const drain = () => new Promise((resolve) => setImmediate(resolve));
    const TRUNCATE = 'TRUNCATE TABLE "FinancialOperation", "SmartEscrow", "Ticket", "TicketMessage", "Friendship", "User", '
        + '"TransactionHistory", "AdminProfitLog", "SystemProfitFees", "GlobalSettings", "AzmGift", '
        + '"AzmSpendLog", "AzmRewardLog", "AzmConversionLog", "OrderBookOrder", "Trade", "TradeQueue", "Ad", '
        + '"LedgerTransaction", "JournalEntry", "AuditLog", "Notification", '
        // Integration hygiene (rebase onto the #317-era main): the wired
        // settlement paths also touch the shared ledger account lattice
        // and the fiat liquidity authority. Leaving rows
        // behind changes foreign suites' fee/ledger behavior (observed: the
        // r41 transit suite reading a leaked profit-fee balance as a
        // "side effect" of its own cancelled funding). Clean what we dirty.
        + '"LedgerAccount", "FiatLiquidityState" RESTART IDENTITY CASCADE';
    const truncateWithRetry = async () => {
        await drain();
        for (let attempt = 1; ; attempt++) {
            try {
                await prisma.$executeRawUnsafe(TRUNCATE);
                return;
            } catch (err) {
                const isDeadlock = err?.code === 'P2034'
                    || /40P01/.test(String(err?.message || ''))
                    || /40P01/.test(JSON.stringify(err?.meta || ''));
                if (attempt >= 5 || !isDeadlock) throw err;
                await new Promise((r) => setTimeout(r, 250 * attempt));
            }
        }
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
    });
    afterAll(async () => { await prisma?.$disconnect(); });

    // Suite hygiene: the last test's seed rows (trades, escrows, users) must
    // not leak into the shared test DB and break other suites' cleanups.
    afterEach(async () => {
        await truncateWithRetry();
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
        await prisma.systemProfitFees.upsert({
            where: { id: 1 },
            update: { balance: 100000 },
            create: { id: 1, balance: 100000 },
        });
    });

    beforeEach(async () => {
        await truncateWithRetry();
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
        await prisma.systemProfitFees.upsert({
            where: { id: 1 },
            update: { balance: 100000 },
            create: { id: 1, balance: 100000 },
        });
    });

    // ── harness ─────────────────────────────────────────────────────────────
    const stubIo = (opts = {}) => {
        const emit = opts.throwOnEmit
            ? () => { throw new Error('socket pipeline failed'); }
            : () => {};
        return { to: () => ({ emit }) };
    };

    // Builds a driver: REAL idempotency middleware (matching the production
    // mount policy) → REAL controller. `wire` is the exact JSON the client
    // would receive. `breakJson` simulates a response-delivery failure.
    const buildDriver = ({ endpoint, path, handler, appSettings = {}, policy = idempotency({ releaseOn4xx: true }) }) => {
        const app = {
            settings: {}, get(k) { return this.settings[k]; }, set(k, v) { this.settings[k] = v; },
        };
        app.set('prisma', prisma);
        app.set('socketio', stubIo());
        app.set('io', stubIo());
        app.set('emitBalanceUpdate', async () => {});
        app.set('pushIfOffline', async () => {});
        app.set('notificationService', { sendNotification: async () => {} });
        for (const [k, v] of Object.entries(appSettings)) app.set(k, v);

        const drive = ({ user, key, body, breakJson = false }) => new Promise((resolve, reject) => {
            const req = {
                method: 'POST', originalUrl: path, path, url: path,
                baseUrl: '', route: { path },
                headers: key ? { 'idempotency-key': key } : {},
                params: {}, query: {}, body: body || {},
                app, get: (k) => app.get(k),
                ip: '127.0.0.1',
                user: { id: user, username: `u${user}` },
            };
            let broke = false;
            const res = {
                app, locals: {}, statusCode: 200, headersSent: false,
                status(c) { this.statusCode = c; return this; },
                json(b) {
                    if (!this.headersSent) {
                        this.headersSent = true;
                        if (breakJson) { broke = true; reject(new Error('RESPONSE_DELIVERY_FAILED')); return this; }
                        resolve({ status: this.statusCode, body: b, wire: JSON.stringify(b) });
                    }
                    return this;
                },
                setHeader() {},
                end() { this.headersSent = true; resolve({ status: this.statusCode, body: null }); return this; },
            };
            Promise.resolve(policy(req, res, (err) => (err
                ? reject(err)
                : Promise.resolve(handler(req, res)).catch((e) => { if (!broke) reject(e); }))));
        });
        return { drive };
    };

    const claimOf = (userId, endpoint, key) => prisma.financialOperation.findUnique({
        where: { userId_endpoint_key: { userId, endpoint, key } },
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
    const wireOf = (status, body) => JSON.stringify(body);

    // ══════════════════════════════════════════════════════════════════════
    // E1. POST /api/escrow/fund
    // ══════════════════════════════════════════════════════════════════════
    describe('§1 escrow fund (wired)', () => {
        const driver = () => buildDriver({
            endpoint: EP.escrow, path: '/api/escrow/fund', handler: escrowController.fundEscrow,
        });
        const seed = () => seedEscrowTicket(prisma, 'DRAFT', { amountUsdc: 50, feeUsdc: 0.25 });

        test('A. first execution: one funding; claim COMMITTED with the exact wire body', async () => {
            const { payer, escrow } = await seed();
            const { drive } = driver();
            const first = await drive({ user: payer.id, key: 'esc-a-1', body: { escrowId: escrow.id } });
            expect(first.status).toBe(200);
            expect(first.body.success).toBe(true);

            // Exactly one economic execution.
            const fresh = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(fresh.status).toBe('FUNDED');
            const payerRow = await prisma.user.findUnique({ where: { id: payer.id } });
            expect(Number(payerRow.availableBalance)).toBeCloseTo(149.75, 8); // 200 − 50 − 0.25
            expect(Number(payerRow.escrowLockedBalance)).toBeCloseTo(50, 8);
            expect(await prisma.transactionHistory.count({ where: { type: 'TICKET_ESCROW_FUND' } })).toBe(1);

            // The claim committed INSIDE the transaction with the EXACT wire bytes.
            const claim = await claimOf(payer.id, EP.escrow, 'esc-a-1');
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(first.wire);
        }, 20000);

        test('B. same-key replay: byte-identical; economics never re-execute', async () => {
            const { payer, escrow } = await seed();
            const { drive } = driver();
            const first = await drive({ user: payer.id, key: 'esc-b-1', body: { escrowId: escrow.id } });
            const replay = await drive({ user: payer.id, key: 'esc-b-1', body: { escrowId: escrow.id } });
            expect(replay.status).toBe(200);
            expect(replay.wire).toBe(first.wire); // byte-identical at the wire representation
            expect(await prisma.transactionHistory.count({ where: { type: 'TICKET_ESCROW_FUND' } })).toBe(1);
            const payerRow = await prisma.user.findUnique({ where: { id: payer.id } });
            expect(Number(payerRow.availableBalance)).toBeCloseTo(149.75, 8);
        }, 20000);

        test('C. concurrent duplicates: exactly one funding', async () => {
            const { payer, escrow } = await seed();
            const { drive } = driver();
            const results = await Promise.all([
                drive({ user: payer.id, key: 'esc-c-1', body: { escrowId: escrow.id } }),
                drive({ user: payer.id, key: 'esc-c-1', body: { escrowId: escrow.id } }),
            ]);
            const statuses = results.map((r) => r.status).sort();
            expect(statuses).toEqual([200, 409]);
            expect(results.find((r) => r.status === 409).body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
            expect(await prisma.transactionHistory.count({ where: { type: 'TICKET_ESCROW_FUND' } })).toBe(1);
            const payerRow = await prisma.user.findUnique({ where: { id: payer.id } });
            expect(Number(payerRow.availableBalance)).toBeCloseTo(149.75, 8);
        }, 20000);

        test('E. divergent payload: deterministic 409; committed original untouched', async () => {
            const { payer, escrow } = await seed();
            const other = await seed();
            const { drive } = driver();
            await drive({ user: payer.id, key: 'esc-e-1', body: { escrowId: escrow.id } });
            const conflict = await drive({ user: payer.id, key: 'esc-e-1', body: { escrowId: other.escrow.id } });
            expect(conflict.status).toBe(409);
            expect(conflict.body.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
            // The committed operation is untouched; the other escrow never funded.
            expect((await prisma.smartEscrow.findUnique({ where: { id: other.escrow.id } })).status).toBe('DRAFT');
            expect((await claimOf(payer.id, EP.escrow, 'esc-e-1')).status).toBe('COMMITTED');
        }, 20000);

        test('F. missing key: deterministic refusal, no claim, no economics', async () => {
            const { payer, escrow } = await seed();
            const { drive } = driver();
            const refused = await drive({ user: payer.id, key: null, body: { escrowId: escrow.id } });
            expect(refused.status).toBe(400);
            expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
            expect(await prisma.financialOperation.count()).toBe(0);
            expect((await prisma.smartEscrow.findUnique({ where: { id: escrow.id } })).status).toBe('DRAFT');
        }, 20000);

        test('G. pre-economic 4xx: claim released; SAME key retries successfully', async () => {
            // Payer cannot afford the escrow → deterministic 400 pre-commit.
            // (Balance moves WITH its backing ledger row so the pre-flight
            // runDoubleCheck audit stays sound.)
            const { payer, escrow } = await seedEscrowTicket(prisma, 'DRAFT', { amountUsdc: 50, feeUsdc: 0.25 });
            const setPayerBalance = (amount) => Promise.all([
                prisma.user.update({ where: { id: payer.id }, data: { availableBalance: amount } }),
                prisma.transactionHistory.updateMany({
                    where: { userId: payer.id, type: 'DEPOSIT_CRYPTO' },
                    data: { amountUsdc: amount },
                }),
            ]);
            await setPayerBalance(1);
            const { drive } = driver();
            const poor = await drive({ user: payer.id, key: 'esc-g-1', body: { escrowId: escrow.id } });
            expect(poor.status).toBe(400);
            // The claim was released — the key is NOT poisoned. (The release
            // is deliberately fire-and-forget in the middleware: poll for
            // the converged state instead of racing it.)
            const released = await waitFor(async () => {
                const n = await prisma.financialOperation.count({ where: { key: 'esc-g-1' } });
                return n === 0 ? true : null;
            });
            expect(released).toBe(true);
            // Corrected retry with the SAME key executes exactly once.
            await setPayerBalance(200);
            const retry = await drive({ user: payer.id, key: 'esc-g-1', body: { escrowId: escrow.id } });
            expect(retry.status).toBe(200);
            expect((await prisma.smartEscrow.findUnique({ where: { id: escrow.id } })).status).toBe('FUNDED');
            expect(await prisma.transactionHistory.count({ where: { type: 'TICKET_ESCROW_FUND' } })).toBe(1);
        }, 20000);

        test('H. crash after commit: funding committed once; same-key retry replays', async () => {
            const { payer, escrow } = await seed();
            // Post-commit dependency failure: the realtime socket pipeline
            // throws AFTER the funding transaction (and the in-tx claim
            // commit) are already durable.
            const { drive } = buildDriver({
                endpoint: EP.escrow, path: '/api/escrow/fund', handler: escrowController.fundEscrow,
                appSettings: { socketio: stubIo({ throwOnEmit: true }) },
            });
            // The post-commit failure surfaces as 500 — but the funding and
            // the in-tx claim commit are already durable.
            const first = await drive({ user: payer.id, key: 'esc-h-1', body: { escrowId: escrow.id } });
            expect(first.status).toBe(500);

            expect((await prisma.smartEscrow.findUnique({ where: { id: escrow.id } })).status).toBe('FUNDED');
            const payerRow = await prisma.user.findUnique({ where: { id: payer.id } });
            expect(Number(payerRow.availableBalance)).toBeCloseTo(149.75, 8);

            // The claim is ALREADY COMMITTED (in-tx) — the crash cannot undo it.
            const claim = await claimOf(payer.id, EP.escrow, 'esc-h-1');
            expect(claim.status).toBe('COMMITTED');

            // Same-key retry replays the committed result; economics never re-run.
            const ok = driver();
            const retry = await ok.drive({ user: payer.id, key: 'esc-h-1', body: { escrowId: escrow.id } });
            expect(retry.status).toBe(200);
            expect(JSON.parse(claim.responseBody)).toEqual(retry.body);
            expect(await prisma.transactionHistory.count({ where: { type: 'TICKET_ESCROW_FUND' } })).toBe(1);
        }, 20000);

        test('I. parked IN_PROGRESS claim: same key refuses, never executes blindly', async () => {
            const { payer, escrow } = await seed();
            // Simulate an owner that claimed the operation and died before
            // the economic execution.
            await prisma.financialOperation.create({
                data: { userId: payer.id, endpoint: EP.escrow, key: 'esc-i-1', status: 'IN_PROGRESS', fingerprint: 'x', failurePolicy: 'RETAIN' },
            });
            const { drive } = driver();
            const refused = await drive({ user: payer.id, key: 'esc-i-1', body: { escrowId: escrow.id } });
            expect(refused.status).toBe(409);
            expect(refused.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
            expect((await prisma.smartEscrow.findUnique({ where: { id: escrow.id } })).status).toBe('DRAFT');
            expect(await prisma.transactionHistory.count({ where: { type: 'TICKET_ESCROW_FUND' } })).toBe(0);
        }, 20000);
    });

    // ══════════════════════════════════════════════════════════════════════
    // E2. POST /api/azm-convert
    // ══════════════════════════════════════════════════════════════════════
    describe('§2 AZM→USDC conversion (wired)', () => {
        const driver = () => buildDriver({
            endpoint: EP.convert, path: '/api/azm-convert', handler: conversionController.convertAzmToUsdc,
        });
        const seed = async () => {
            const user = await seedUser(prisma, { azmBalance: 1000, availableBalance: 0 });
            return { user };
        };

        test('A. first execution: one redemption; claim COMMITTED with the exact wire body', async () => {
            const { user } = await seed();
            const { drive } = driver();
            const first = await drive({ user: user.id, key: 'cv-a-1-0001', body: { azmAmount: 100 } });
            expect(first.status).toBe(200);
            expect(first.body.success).toBe(true);

            // One redemption: AZM burned, USDC credited, pool drained — once.
            const row = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(row.azmBalance)).toBeCloseTo(900, 8);
            expect(Number(row.availableBalance)).toBeCloseTo(0.1, 8); // 100 × 0.001
            expect(await prisma.azmConversionLog.count()).toBe(1);
            const pool = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
            expect(Number(pool.balance)).toBeCloseTo(99999.9, 6);

            const claim = await claimOf(user.id, EP.convert, 'cv-a-1-0001');
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(first.wire);
        }, 20000);

        test('B. same-key replay: byte-identical; economics never re-execute', async () => {
            const { user } = await seed();
            const { drive } = driver();
            const first = await drive({ user: user.id, key: 'cv-b-1-0001', body: { azmAmount: 100 } });
            const replay = await drive({ user: user.id, key: 'cv-b-1-0001', body: { azmAmount: 100 } });
            expect(replay.status).toBe(200);
            expect(replay.wire).toBe(first.wire);
            expect(await prisma.azmConversionLog.count()).toBe(1);
            const row = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(row.azmBalance)).toBeCloseTo(900, 8);
        }, 20000);

        test('C. concurrent duplicates: exactly one redemption', async () => {
            const { user } = await seed();
            const { drive } = driver();
            const results = await Promise.all([
                drive({ user: user.id, key: 'cv-c-1-0001', body: { azmAmount: 100 } }),
                drive({ user: user.id, key: 'cv-c-1-0001', body: { azmAmount: 100 } }),
            ]);
            const statuses = results.map((r) => r.status).sort();
            expect(statuses).toEqual([200, 409]);
            expect(await prisma.azmConversionLog.count()).toBe(1);
        }, 20000);

        test('F. missing key: deterministic refusal, no claim, no economics', async () => {
            const { user } = await seed();
            const { drive } = driver();
            const refused = await drive({ user: user.id, key: null, body: { azmAmount: 100 } });
            expect(refused.status).toBe(400);
            expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
            expect(await prisma.financialOperation.count()).toBe(0);
            expect(await prisma.azmConversionLog.count()).toBe(0);
        }, 20000);

        test('G. pre-economic 4xx: claim released; SAME key retries successfully', async () => {
            const { user } = await seed();
            const { drive } = driver();
            // Below MIN_CONVERT → deterministic pre-economics 400.
            const bad = await drive({ user: user.id, key: 'cv-g-1-0001', body: { azmAmount: 5 } });
            expect(bad.status).toBe(400);
            expect(await prisma.financialOperation.count({ where: { key: 'cv-g-1-0001' } })).toBe(0);
            // Corrected retry with the SAME key executes exactly once.
            const retry = await drive({ user: user.id, key: 'cv-g-1-0001', body: { azmAmount: 100 } });
            expect(retry.status).toBe(200);
            expect(await prisma.azmConversionLog.count()).toBe(1);
        }, 20000);

        test('H. crash after commit: redemption committed once; same-key retry replays', async () => {
            const { user } = await seed();
            // Post-commit dependency failure: the socket pipeline throws AFTER
            // the conversion transaction (and in-tx claim commit) are durable.
            const { drive } = buildDriver({
                endpoint: EP.convert, path: '/api/azm-convert', handler: conversionController.convertAzmToUsdc,
                appSettings: { io: stubIo({ throwOnEmit: true }) },
            });
            const first = await drive({ user: user.id, key: 'cv-h-1-0001', body: { azmAmount: 100 } });
            // The post-commit failure surfaces as 500 — the redemption and
            // the in-tx claim commit are already durable.
            expect(first.status).toBe(500);

            expect(await prisma.azmConversionLog.count()).toBe(1);
            const row = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(row.azmBalance)).toBeCloseTo(900, 8);

            const claim = await claimOf(user.id, EP.convert, 'cv-h-1-0001');
            expect(claim.status).toBe('COMMITTED');

            const ok = driver();
            const retry = await ok.drive({ user: user.id, key: 'cv-h-1-0001', body: { azmAmount: 100 } });
            expect(retry.status).toBe(200);
            expect(JSON.parse(claim.responseBody)).toEqual(retry.body);
            expect(await prisma.azmConversionLog.count()).toBe(1);
        }, 20000);

        test('I. parked IN_PROGRESS claim: same key refuses, never executes blindly', async () => {
            const { user } = await seed();
            await prisma.financialOperation.create({
                data: { userId: user.id, endpoint: EP.convert, key: 'cv-i-1-0001', status: 'IN_PROGRESS', fingerprint: 'x', failurePolicy: 'RETAIN' },
            });
            const { drive } = driver();
            const refused = await drive({ user: user.id, key: 'cv-i-1-0001', body: { azmAmount: 100 } });
            expect(refused.status).toBe(409);
            expect(refused.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
            expect(await prisma.azmConversionLog.count()).toBe(0);
        }, 20000);
    });

    // ══════════════════════════════════════════════════════════════════════
    // E3. POST /api/azm-gifts/send
    // ══════════════════════════════════════════════════════════════════════
    describe('§3 AZM gift send (wired)', () => {
        const driver = () => buildDriver({
            endpoint: EP.gift, path: '/api/azm-gifts/send', handler: giftController.sendGift,
        });
        const seed = async () => {
            const sender = await seedUser(prisma, { azmBalance: 500 });
            const receiver = await seedUser(prisma, { azmBalance: 0 });
            return { sender, receiver };
        };
        const payload = (receiverId) => ({ receiverId, amount: 25, type: 'GIFT' });

        test('A. first execution: one transfer; claim COMMITTED with the exact wire body', async () => {
            const { sender, receiver } = await seed();
            const { drive } = driver();
            const first = await drive({ user: sender.id, key: 'gift-a-1-0001', body: payload(receiver.id) });
            expect(first.status).toBe(200);
            expect(first.body.success).toBe(true);

            expect(await prisma.azmGift.count()).toBe(1);
            const s = await prisma.user.findUnique({ where: { id: sender.id } });
            const r = await prisma.user.findUnique({ where: { id: receiver.id } });
            expect(Number(s.azmBalance)).toBeCloseTo(475, 8);
            expect(Number(r.azmBalance)).toBeCloseTo(25, 8);
            expect(await prisma.azmSpendLog.count({ where: { source: 'GIFT_TIP' } })).toBe(1);

            const claim = await claimOf(sender.id, EP.gift, 'gift-a-1-0001');
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(first.wire);
        }, 20000);

        test('B. same-key replay: byte-identical; economics never re-execute', async () => {
            const { sender, receiver } = await seed();
            const { drive } = driver();
            const first = await drive({ user: sender.id, key: 'gift-b-1-0001', body: payload(receiver.id) });
            const replay = await drive({ user: sender.id, key: 'gift-b-1-0001', body: payload(receiver.id) });
            expect(replay.status).toBe(200);
            expect(replay.wire).toBe(first.wire);
            expect(await prisma.azmGift.count()).toBe(1);
            const s = await prisma.user.findUnique({ where: { id: sender.id } });
            expect(Number(s.azmBalance)).toBeCloseTo(475, 8);
        }, 20000);

        test('C. concurrent duplicates: exactly one transfer', async () => {
            const { sender, receiver } = await seed();
            const { drive } = driver();
            const results = await Promise.all([
                drive({ user: sender.id, key: 'gift-c-1-0001', body: payload(receiver.id) }),
                drive({ user: sender.id, key: 'gift-c-1-0001', body: payload(receiver.id) }),
            ]);
            const statuses = results.map((r) => r.status).sort();
            expect(statuses).toEqual([200, 409]);
            expect(await prisma.azmGift.count()).toBe(1);
            const r = await prisma.user.findUnique({ where: { id: receiver.id } });
            expect(Number(r.azmBalance)).toBeCloseTo(25, 8);
        }, 20000);

        test('E. divergent payload: deterministic 409; committed original untouched', async () => {
            const { sender, receiver } = await seed();
            const other = await seedUser(prisma, { azmBalance: 0 });
            const { drive } = driver();
            await drive({ user: sender.id, key: 'gift-e-1-0001', body: payload(receiver.id) });
            const conflict = await drive({ user: sender.id, key: 'gift-e-1-0001', body: payload(other.id) });
            expect(conflict.status).toBe(409);
            expect(conflict.body.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
            expect((await claimOf(sender.id, EP.gift, 'gift-e-1-0001')).status).toBe('COMMITTED');
            expect(await prisma.azmGift.count()).toBe(1);
            expect(Number((await prisma.user.findUnique({ where: { id: other.id } })).azmBalance)).toBeCloseTo(0, 8);
        }, 20000);

        test('F. missing key: deterministic refusal, no claim, no economics', async () => {
            const { sender, receiver } = await seed();
            const { drive } = driver();
            const refused = await drive({ user: sender.id, key: null, body: payload(receiver.id) });
            expect(refused.status).toBe(400);
            expect(refused.body.message).toMatch(/Idempotency-Key/i);
            expect(await prisma.financialOperation.count()).toBe(0);
            expect(await prisma.azmGift.count()).toBe(0);
        }, 20000);

        test('G. pre-economic 4xx: claim released; SAME key retries successfully', async () => {
            const { sender, receiver } = await seed();
            const { drive } = driver();
            // Invalid amount → deterministic pre-economics 400.
            const bad = await drive({ user: sender.id, key: 'gift-g-1-0001', body: { receiverId: receiver.id, amount: -5, type: 'GIFT' } });
            expect(bad.status).toBe(400);
            expect(await prisma.financialOperation.count({ where: { key: 'gift-g-1-0001' } })).toBe(0);
            // Corrected retry with the SAME key executes exactly once.
            const retry = await drive({ user: sender.id, key: 'gift-g-1-0001', body: payload(receiver.id) });
            expect(retry.status).toBe(200);
            expect(await prisma.azmGift.count()).toBe(1);
        }, 20000);

        test('H. response-delivery failure: transfer committed once; same-key retry replays', async () => {
            const { sender, receiver } = await seed();
            const { drive } = driver();
            // Simulate a response-delivery failure: the client never sees the
            // 200 although the transaction (economics + in-tx claim commit)
            // is durable.
            await expect(drive({ user: sender.id, key: 'gift-h-1-0001', body: payload(receiver.id), breakJson: true }))
                .rejects.toThrow('RESPONSE_DELIVERY_FAILED');

            expect(await prisma.azmGift.count()).toBe(1);
            const s = await prisma.user.findUnique({ where: { id: sender.id } });
            expect(Number(s.azmBalance)).toBeCloseTo(475, 8);

            const claim = await claimOf(sender.id, EP.gift, 'gift-h-1-0001');
            expect(claim.status).toBe('COMMITTED');

            const retry = await drive({ user: sender.id, key: 'gift-h-1-0001', body: payload(receiver.id) });
            expect(retry.status).toBe(200);
            expect(JSON.parse(claim.responseBody)).toEqual(retry.body);
            expect(await prisma.azmGift.count()).toBe(1);
        }, 20000);

        test('I. parked IN_PROGRESS claim: same key refuses, never executes blindly', async () => {
            const { sender, receiver } = await seed();
            await prisma.financialOperation.create({
                data: { userId: sender.id, endpoint: EP.gift, key: 'gift-i-1-0001', status: 'IN_PROGRESS', fingerprint: 'x', failurePolicy: 'RETAIN' },
            });
            const { drive } = driver();
            const refused = await drive({ user: sender.id, key: 'gift-i-1-0001', body: payload(receiver.id) });
            expect(refused.status).toBe(409);
            expect(refused.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
            expect(await prisma.azmGift.count()).toBe(0);
        }, 20000);
    });

    // ══════════════════════════════════════════════════════════════════════
    // E4. POST /api/order-book/orders
    // ══════════════════════════════════════════════════════════════════════
    describe('§4 order-book placement (wired)', () => {
        const driver = () => buildDriver({
            endpoint: EP.order, path: '/api/order-book/orders', handler: orderBookController.placeOrder,
        });
        const seed = async () => {
            const seller = await seedUser(prisma, { azmBalance: 100 });
            return { seller };
        };
        const sellPayload = { side: 'SELL', type: 'LIMIT', price: 0.0015, quantity: 10 };

        test('A. first execution: one placement; claim COMMITTED with the exact wire body', async () => {
            const { seller } = await seed();
            const { drive } = driver();
            const first = await drive({ user: seller.id, key: 'ob-a-1-0001', body: sellPayload });
            expect(first.status).toBe(200);
            expect(first.body.success).toBe(true);

            expect(await prisma.orderBookOrder.count()).toBe(1);
            const s = await prisma.user.findUnique({ where: { id: seller.id } });
            expect(Number(s.azmBalance)).toBeCloseTo(90, 8); // AZM reserved

            const claim = await claimOf(seller.id, EP.order, 'ob-a-1-0001');
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(first.wire);
        }, 20000);

        test('B. same-key replay: byte-identical; economics never re-execute', async () => {
            const { seller } = await seed();
            const { drive } = driver();
            const first = await drive({ user: seller.id, key: 'ob-b-1-0001', body: sellPayload });
            const replay = await drive({ user: seller.id, key: 'ob-b-1-0001', body: sellPayload });
            expect(replay.status).toBe(200);
            expect(replay.wire).toBe(first.wire);
            expect(await prisma.orderBookOrder.count()).toBe(1);
            const s = await prisma.user.findUnique({ where: { id: seller.id } });
            expect(Number(s.azmBalance)).toBeCloseTo(90, 8);
        }, 20000);

        test('C. concurrent duplicates: exactly one placement', async () => {
            const { seller } = await seed();
            const { drive } = driver();
            const results = await Promise.all([
                drive({ user: seller.id, key: 'ob-c-1-0001', body: sellPayload }),
                drive({ user: seller.id, key: 'ob-c-1-0001', body: sellPayload }),
            ]);
            const statuses = results.map((r) => r.status).sort();
            expect(statuses).toEqual([200, 409]);
            expect(await prisma.orderBookOrder.count()).toBe(1);
        }, 20000);

        test('F. missing key: deterministic refusal, no claim, no economics', async () => {
            const { seller } = await seed();
            const { drive } = driver();
            const refused = await drive({ user: seller.id, key: null, body: sellPayload });
            expect(refused.status).toBe(400);
            expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
            expect(await prisma.financialOperation.count()).toBe(0);
            expect(await prisma.orderBookOrder.count()).toBe(0);
        }, 20000);

        test('G. pre-economic 4xx: claim released; SAME key retries successfully', async () => {
            const { seller } = await seed();
            const { drive } = driver();
            // Invalid side → deterministic pre-economics 400.
            const bad = await drive({ user: seller.id, key: 'ob-g-1-0001', body: { side: 'NOPE', type: 'LIMIT', price: 1, quantity: 10 } });
            expect(bad.status).toBe(400);
            expect(await prisma.financialOperation.count({ where: { key: 'ob-g-1-0001' } })).toBe(0);
            // Corrected retry with the SAME key executes exactly once.
            const retry = await drive({ user: seller.id, key: 'ob-g-1-0001', body: sellPayload });
            expect(retry.status).toBe(200);
            expect(await prisma.orderBookOrder.count()).toBe(1);
        }, 20000);

        test('H. response-delivery failure: placement committed once; same-key retry replays', async () => {
            const { seller } = await seed();
            const { drive } = driver();
            await expect(drive({ user: seller.id, key: 'ob-h-1-0001', body: sellPayload, breakJson: true }))
                .rejects.toThrow('RESPONSE_DELIVERY_FAILED');

            expect(await prisma.orderBookOrder.count()).toBe(1);
            const s = await prisma.user.findUnique({ where: { id: seller.id } });
            expect(Number(s.azmBalance)).toBeCloseTo(90, 8);

            const claim = await claimOf(seller.id, EP.order, 'ob-h-1-0001');
            expect(claim.status).toBe('COMMITTED');

            const retry = await drive({ user: seller.id, key: 'ob-h-1-0001', body: sellPayload });
            expect(retry.status).toBe(200);
            expect(JSON.parse(claim.responseBody)).toEqual(retry.body);
            expect(await prisma.orderBookOrder.count()).toBe(1);
        }, 20000);

        test('I. parked IN_PROGRESS claim: same key refuses, never executes blindly', async () => {
            const { seller } = await seed();
            await prisma.financialOperation.create({
                data: { userId: seller.id, endpoint: EP.order, key: 'ob-i-1-0001', status: 'IN_PROGRESS', fingerprint: 'x', failurePolicy: 'RETAIN' },
            });
            const { drive } = driver();
            const refused = await drive({ user: seller.id, key: 'ob-i-1-0001', body: sellPayload });
            expect(refused.status).toBe(409);
            expect(refused.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
            expect(await prisma.orderBookOrder.count()).toBe(0);
        }, 20000);
    });

    // ══════════════════════════════════════════════════════════════════════
    // E5. POST /api/p2p/complete
    // ══════════════════════════════════════════════════════════════════════
    describe('§5 P2P trade settlement (wired)', () => {
        const driver = () => buildDriver({
            endpoint: EP.p2p, path: '/api/p2p/complete', handler: p2pController.completeTrade,
        });

        test('A. first execution: one settlement; claim COMMITTED with the exact wire body', async () => {
            const t = await seedPaidTrade(prisma);
            const { drive } = driver();
            const first = await drive({ user: t.vendorId, key: 'p2p-a-1-0001', body: { tradeId: t.tradeId } });
            expect(first.status).toBe(200);
            expect(first.body.success).toBe(true);

            // Exactly one settlement: trade COMPLETED once, escrow drained
            // once, buyer credited once, admin margin once.
            const trade = await prisma.trade.findUnique({ where: { id: t.tradeId } });
            expect(trade.status).toBe('COMPLETED');
            const buyer = await prisma.user.findUnique({ where: { id: t.buyerId } });
            const vendor = await prisma.user.findUnique({ where: { id: t.vendorId } });
            expect(Number(buyer.availableBalance)).toBeGreaterThan(0);
            expect(Number(vendor.escrowLockedBalance)).toBeCloseTo(0, 8);
            expect(await prisma.transactionHistory.count({ where: { type: 'P2P_TRADE' } })).toBe(1);

            const claim = await claimOf(t.vendorId, EP.p2p, 'p2p-a-1-0001');
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(first.wire);
        }, 20000);

        test('B. same-key replay: byte-identical; economics never re-execute', async () => {
            const t = await seedPaidTrade(prisma);
            const { drive } = driver();
            const first = await drive({ user: t.vendorId, key: 'p2p-b-1-0001', body: { tradeId: t.tradeId } });
            const replay = await drive({ user: t.vendorId, key: 'p2p-b-1-0001', body: { tradeId: t.tradeId } });
            expect(replay.status).toBe(200);
            expect(replay.wire).toBe(first.wire);
            expect(await prisma.transactionHistory.count({ where: { type: 'P2P_TRADE' } })).toBe(1);
        }, 20000);

        test('C. concurrent duplicates: exactly one settlement', async () => {
            const t = await seedPaidTrade(prisma);
            const { drive } = driver();
            const results = await Promise.all([
                drive({ user: t.vendorId, key: 'p2p-c-1-0001', body: { tradeId: t.tradeId } }),
                drive({ user: t.vendorId, key: 'p2p-c-1-0001', body: { tradeId: t.tradeId } }),
            ]);
            const statuses = results.map((r) => r.status).sort();
            expect(statuses).toEqual([200, 409]);
            expect(await prisma.transactionHistory.count({ where: { type: 'P2P_TRADE' } })).toBe(1);
            const vendor = await prisma.user.findUnique({ where: { id: t.vendorId } });
            expect(Number(vendor.escrowLockedBalance)).toBeCloseTo(0, 8);
        }, 20000);

        test('F. missing key: deterministic refusal, no claim, no economics', async () => {
            const t = await seedPaidTrade(prisma);
            const { drive } = driver();
            const refused = await drive({ user: t.vendorId, key: null, body: { tradeId: t.tradeId } });
            expect(refused.status).toBe(400);
            expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
            expect(await prisma.financialOperation.count()).toBe(0);
            expect((await prisma.trade.findUnique({ where: { id: t.tradeId } })).status).toBe('PAID');
        }, 20000);

        test('H. post-commit failure surfacing as 4xx: claim stays COMMITTED; retry replays', async () => {
            const t = await seedPaidTrade(prisma);
            // Post-commit dependency failure: emitBalanceUpdate runs AFTER the
            // settlement $transaction (and the in-tx claim commit) are
            // durable, and the outer catch converts it to a 4xx — the exact
            // sequence that would have DELETED a committed claim under a
            // post-response-only authority. The wired in-tx commit wins.
            const { drive } = buildDriver({
                endpoint: EP.p2p, path: '/api/p2p/complete', handler: p2pController.completeTrade,
                appSettings: { emitBalanceUpdate: async () => { throw new Error('balance socket pipeline failed'); } },
            });
            const first = await drive({ user: t.vendorId, key: 'p2p-h-1-0001', body: { tradeId: t.tradeId } });
            expect(first.status).toBe(400);

            // The settlement DID commit — exactly once.
            expect((await prisma.trade.findUnique({ where: { id: t.tradeId } })).status).toBe('COMPLETED');
            expect(await prisma.transactionHistory.count({ where: { type: 'P2P_TRADE' } })).toBe(1);
            const vendor = await prisma.user.findUnique({ where: { id: t.vendorId } });
            expect(Number(vendor.escrowLockedBalance)).toBeCloseTo(0, 8);

            // The claim is COMMITTED — releaseOn4xx cannot delete it.
            const claim = await claimOf(t.vendorId, EP.p2p, 'p2p-h-1-0001');
            expect(claim.status).toBe('COMMITTED');

            // Same-key retry replays the committed result byte-identically;
            // the trade is NEVER settled twice.
            const ok = driver();
            const retry = await ok.drive({ user: t.vendorId, key: 'p2p-h-1-0001', body: { tradeId: t.tradeId } });
            expect(retry.status).toBe(200);
            expect(retry.wire).toBe(claim.responseBody);
            expect(await prisma.transactionHistory.count({ where: { type: 'P2P_TRADE' } })).toBe(1);
        }, 20000);

        test('I. parked IN_PROGRESS claim: same key refuses, never executes blindly', async () => {
            const t = await seedPaidTrade(prisma);
            await prisma.financialOperation.create({
                data: { userId: t.vendorId, endpoint: EP.p2p, key: 'p2p-i-1-0001', status: 'IN_PROGRESS', fingerprint: 'x', failurePolicy: 'RETAIN' },
            });
            const { drive } = driver();
            const refused = await drive({ user: t.vendorId, key: 'p2p-i-1-0001', body: { tradeId: t.tradeId } });
            expect(refused.status).toBe(409);
            expect(refused.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
            expect((await prisma.trade.findUnique({ where: { id: t.tradeId } })).status).toBe('PAID');
            expect(await prisma.transactionHistory.count({ where: { type: 'P2P_TRADE' } })).toBe(0);
        }, 20000);
    });

    // ── Matrix D (structural): no legacy alias identity path on this tranche ──
    test('D. canonical identity only: a legacy-style alias field is material payload, never an alternative identity', async () => {
        const t = await seedPaidTrade(prisma);
        const { drive } = buildDriver({
            endpoint: EP.p2p, path: '/api/p2p/complete', handler: p2pController.completeTrade,
        });
        // Complete with a body carrying a legacy-style clientRequestId — the
        // header stays the ONE authority; the field is fingerprinted material.
        const first = await drive({
            user: t.vendorId, key: 'p2p-d-1-0001',
            body: { tradeId: t.tradeId, clientRequestId: 'legacy-alias-xyz' },
        });
        expect(first.status).toBe(200);
        // Same key + same tradeId but a DIFFERENT alias value is a materially
        // different payload → deterministic 409, never a second settlement.
        const conflict = await drive({
            user: t.vendorId, key: 'p2p-d-1-0001',
            body: { tradeId: t.tradeId, clientRequestId: 'other-alias' },
        });
        expect(conflict.status).toBe(409);
        expect(conflict.body.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
        expect(await prisma.transactionHistory.count({ where: { type: 'P2P_TRADE' } })).toBe(1);
    }, 20000);
});
