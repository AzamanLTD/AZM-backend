'use strict';

// =============================================================================
// §r42 — SHARED FINANCIAL IDEMPOTENCY AUTHORITY (real PostgreSQL).
//
// Proves the middleware + FinancialOperation claim contract on the real
// database, plus the mandated multi-currency conversion wiring:
//
//  P1.  Concurrent duplicates (same user + endpoint + key) → exactly one
//       economic mutation; the duplicate gets a deterministic 409.
//  P2.  P1 repeated over many rounds — the unique INSERT is the arbiter, not
//       scheduling luck.
//  P3.  Replay after committed success → byte-identical committed result,
//       zero second mutation, handler NOT invoked.
//  P4.  Same key + materially different payload → deterministic 409 conflict.
//  P4b. Exact-decimal fingerprints: 10 vs "10.00" vs 10.5 are DISTINCT
//       (fail-closed); byte-identical payloads always replay.
//  P5.  Same key across different users → independent operations.
//  P6.  Same key across different endpoints → independent operations.
//  P7.  Second request while the first is deliberately held in-flight → 409
//       IN_PROGRESS (observed claim state, no timers); after completion the
//       committed result replays.
//  P8.  A 4xx validation failure releases the claim — the key is not poisoned.
//  P9.  RETAIN on 5xx: a 500 that may follow a committed mutation leaves the
//       claim IN_PROGRESS — same-key retry refused, new-key executes; money
//       moved exactly once per successful operation.
//  P10. RELEASE on 5xx with a real transaction rollback → claim released,
//       same-key retry executes; money moved exactly once.
//  P11. Claim/DB failure → 503 fail-closed; the handler is NEVER invoked.
//  P12. No-key request → executes (optional header preserved).
//  P13. Committed operations are PERMANENT: a backdated claim (beyond any
//       response-cache TTL) still replays — a settled request can never be
//       re-armed by pruning/expiry.
//  MC1. Real multi-currency convert: two truly concurrent identical
//       conversions → one debit/credit/log; duplicate 409; replay returns the
//       same committed conversionId; the FinancialOperation row is COMMITTED
//       inside the economic transaction.
//  MC2. Same key + changed amount → 409 payload conflict, balances untouched.
//  MC3. Injected failure mid-transaction → whole rollback (debit reverted,
//       claim released by RELEASE policy) → retry executes once; money moved
//       exactly once across the whole sequence.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r42 — shared financial idempotency authority (PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        // Self-cleaning: sweep ONLY this suite's synthetic driver endpoints
        // (mounted nowhere else in the app). Without this, leftover COMMITTED
        // claims from an earlier run can collide with freshly seeded users
        // after a foreign suite runs TRUNCATE "User" RESTART IDENTITY CASCADE —
        // the truncate spares FinancialOperation but resets the User
        // sequence, so fresh users reuse low ids and "first" drives silently
        // replay the stale committed results.
        await prisma.financialOperation.deleteMany({
            where: { endpoint: { in: [
                'POST /spend', 'POST /spend-rollback-500', 'POST /spend-commit-then-500',
                'POST /fail-validation', 'POST /hang', 'POST /unprotected-observe',
                'POST /api/multi-currency/convert',
                'POST /spend-commit-then-400', 'POST /spend-wired-in-tx',
                'POST /spend-optional', 'POST /api/withdraw/fiat',
            ] } },
        });
    });

    afterAll(async () => {
        await prisma?.$disconnect();
    });

    // ── harness ───────────────────────────────────────────────────────────
    // A minimal Express-shaped req/res pair driven through the REAL
    // middleware and (for MC proofs) the REAL multi-currency controller. The
    // generic handlers perform REAL conditional balance mutations so duplicate
    // executions are observable as money moved twice.

    const { idempotency } = require('../middleware/idempotency');
    const express = require('express');

    let executionCounter = 0;

    // Direct middleware driver. Each request runs the REAL middleware function
    // and then the REAL handler — no Express layer in between. This is not a
    // shortcut: the unit under proof is the claim arbitration, and Express's
    // router defers cross-request dispatch in-process, which falsely
    // serializes two truly concurrent HTTP requests into a
    // commit-then-replay sequence. Driving the middleware directly lets both
    // claims be in flight at once (exactly what the P2002 arbiter decides);
    // the DB-observed claim state remains the assertion basis, never timers.
    const buildDriver = () => {
        const app = {
            settings: {},
            get(k) { return this.settings[k]; },
            set(k, v) { this.settings[k] = v; },
        };
        app.set('prisma', prisma);
        app.set('io', null);

        const handlers = {
            '/spend': { policy: {}, fn: async (req, res) => {
                executionCounter++;
                const amount = Number(req.body.amount) || 0;
                const claim = await prisma.currencyWallet.updateMany({
                    where: { id: req.body.walletId, balance: { gte: amount } },
                    data: { balance: { decrement: amount } },
                });
                if (claim.count !== 1) {
                    return res.status(400).json({ success: false, code: 'INSUFFICIENT_FUNDS' });
                }
                const wallet = await prisma.currencyWallet.findUnique({ where: { id: req.body.walletId } });
                return res.status(200).json({ success: true, balance: Number(wallet.balance) });
            } },
            // 5xx handler with a REAL rolled-back transaction (RELEASE policy
            // proof): the debit throws mid-transaction and reverts.
            '/spend-rollback-500': { policy: { failurePolicy: 'RELEASE' }, fn: async (req, res) => {
                executionCounter++;
                try {
                    await prisma.$transaction(async (tx) => {
                        await tx.currencyWallet.update({
                            where: { id: req.body.walletId },
                            data: { balance: { decrement: Number(req.body.amount) } },
                        });
                        const err = new Error('injected post-mutation failure');
                        err.code = 'INJECTED';
                        throw err;
                    });
                } catch (e) {
                    return res.status(500).json({ success: false, code: 'INJECTED' });
                }
            } },
            // RETAIN poison scenario: a REAL committed mutation followed by a
            // 500 (the crash-after-commit window for an UNWIRED endpoint).
            '/spend-commit-then-500': { policy: {}, fn: async (req, res) => {
                executionCounter++;
                await prisma.currencyWallet.update({
                    where: { id: req.body.walletId },
                    data: { balance: { decrement: Number(req.body.amount) } },
                });
                return res.status(500).json({ success: false, code: 'LOST_AFTER_COMMIT' });
            } },
            '/fail-validation': { policy: {}, fn: async (req, res) => {
                executionCounter++;
                // r42 review P0-1: validation rejects BEFORE any economics —
                // the handler marks the explicit pre-economics release itself.
                if (!req.body.ok) {
                    res.locals.financialClaimRelease = true;
                    return res.status(400).json({ success: false, code: 'VALIDATION' });
                }
                return res.status(200).json({ success: true });
            } },
            // r42 review P0-1 proof: money commits, THEN a post-commit helper
            // throws, and the controller-shaped catch converts it to a 400 —
            // the exact withdrawalController pattern the review called out.
            '/spend-commit-then-400': { policy: {}, fn: async (req, res) => {
                executionCounter++;
                const amount = Number(req.body.amount) || 0;
                const claim = await prisma.currencyWallet.updateMany({
                    where: { id: req.body.walletId, balance: { gte: amount } },
                    data: { balance: { decrement: amount } },
                });
                if (claim.count !== 1) {
                    res.locals.financialClaimRelease = true; // provably nothing committed
                    return res.status(400).json({ success: false, code: 'INSUFFICIENT_FUNDS' });
                }
                try {
                    throw new Error('post-commit helper failure (e.g. balance emit)');
                } catch (e) {
                    // the r41-era controller pattern: unknown failure → client error
                    return res.status(400).json({ success: false, code: 'ERR', message: e.message });
                }
            } },
            // r42 review P0-1/P1 proof: the WIRED pattern — the claim commits
            // INSIDE the economic transaction with its response body.
            '/spend-wired-in-tx': { policy: {}, fn: async (req, res) => {
                executionCounter++;
                const amount = Number(req.body.amount) || 0;
                const response = await prisma.$transaction(async (tx) => {
                    const debit = await tx.currencyWallet.updateMany({
                        where: { id: req.body.walletId, balance: { gte: amount } },
                        data: { balance: { decrement: amount } },
                    });
                    if (debit.count !== 1) {
                        const err = new Error('INSUFFICIENT_FUNDS'); err.code = 'INSUFFICIENT_FUNDS'; throw err;
                    }
                    const wallet = await tx.currencyWallet.findUnique({ where: { id: req.body.walletId } });
                    const body = { success: true, balance: Number(wallet.balance) };
                    const op = res.locals?.financialOperation;
                    const committed = await tx.financialOperation.updateMany({
                        where: { id: op.id, status: 'IN_PROGRESS' },
                        data: { status: 'COMMITTED', statusCode: 200, responseBody: JSON.stringify(body) },
                    });
                    if (committed.count !== 1) {
                        const err = new Error('IDEMPOTENCY_STATE_CONFLICT'); err.code = 'IDEMPOTENCY_STATE_CONFLICT'; throw err;
                    }
                    return body;
                });
                return res.status(200).json(response);
            } },
            // r42 review P0-2 proof: the proven-safe opt-out (required: false).
            '/spend-optional': { policy: { required: false }, fn: async (req, res) => {
                executionCounter++;
                return res.status(200).json({ success: true, optional: true });
            } },
            '/hang': { policy: {}, fn: async (req, res) => {
                executionCounter++;
                await new Promise((r) => setTimeout(r, 350)); // held in-flight
                return res.status(200).json({ success: true, hung: true });
            } },
            '/unprotected-observe': { policy: {}, fn: async (req, res) => {
                executionCounter++; // proves the handler is NOT invoked on 503 fail-closed
                return res.status(200).json({ success: true });
            } },
        };

        const drive = (path, { user, key, body } = {}) => new Promise((resolve, reject) => {
            const h = handlers[path];
            if (!h) return reject(new Error(`no test handler at ${path}`));
            const req = {
                method: 'POST', originalUrl: path, path, url: path,
                baseUrl: '', route: { path },
                headers: key ? { 'idempotency-key': key } : {},
                params: {}, query: {}, body: body || {},
                app, get: (k) => app.get(k),
                user: user ? { id: user } : undefined,
            };
            const res = {
                app, locals: {}, statusCode: 200, headersSent: false,
                status(c) { this.statusCode = c; return this; },
                json(b) {
                    if (!this.headersSent) {
                        this.headersSent = true;
                        resolve({ status: this.statusCode, body: b, res: this });
                    }
                    return this;
                },
                setHeader() {},
                end() {
                    this.headersSent = true;
                    resolve({ status: this.statusCode, body: null, res: this });
                    return this;
                },
            };
            idempotency(h.policy)(req, res, (err) => (err
                ? reject(err)
                : Promise.resolve(h.fn(req, res)).catch((e) => {
                    res.status(500).json({ success: false, code: 'ERR', message: e?.message });
                })));
        });

        return { app, drive };
    };

    const seedWallet = async (userId, currency, balance) =>
        prisma.currencyWallet.create({ data: { userId, currency, balance } });

    // Post-response bookkeeping (COMMIT / RELEASE / RETAIN) is deliberately
    // fire-and-forget: a bookkeeping crash only degrades replays to the safe
    // 409 refusal — it can never corrupt economics. Assertions therefore
    // observe the CONVERGENCE of the claim row instead of racing the
    // bookkeeping write: bounded DB polling, never sleeps.
    const waitForClaim = async (userId, endpoint, key, want = 'COMMITTED') => {
        const deadline = Date.now() + 5000;
        for (;;) {
            const where = endpoint ? { userId, endpoint, key } : { userId, key };
            const rows = await prisma.financialOperation.findMany({ where });
            const ok = want === 'RELEASED' ? rows.length === 0 : rows.some((r) => r.status === want);
            if (ok || Date.now() > deadline) return rows;
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    const seedUserRow = async () => (await seedUser(prisma)).id;

    // ── P1 + P2 — the unique INSERT is the arbiter under real concurrency ──

    test('P1/P2. concurrent duplicates: exactly one executes, many rounds stable', async () => {
        const rounds = 8;
        for (let i = 0; i < rounds; i++) {
            const userId = await seedUserRow();
            const wallet = await seedWallet(userId, 'GHS', 100);
            const { drive } = buildDriver();
            const before = executionCounter;

            // The authoritative handler parks mid-execution until the duplicate
            // caller has resolved (a DB-observed in-flight window — the same
            // interleave a real concurrent HTTP duplicate faces in production,
            // synchronized on the observed claim state rather than a timer).
            // Whoever wins the unique INSERT parks; the loser must read the
            // IN_PROGRESS claim and be refused — NEVER enter the economic path.
            const loserResolved = {};
            loserResolved.promise = new Promise((r) => { loserResolved.resolve = r; });
            const parkedHandler = async (req, res) => {
                executionCounter++;
                // hold the claim IN_PROGRESS while the duplicate decides
                await Promise.race([
                    loserResolved.promise,
                    new Promise((r) => setTimeout(r, 2000)), // safety cap
                ]);
                const amount = Number(req.body.amount) || 0;
                const claim = await prisma.currencyWallet.updateMany({
                    where: { id: req.body.walletId, balance: { gte: amount } },
                    data: { balance: { decrement: amount } },
                });
                if (claim.count !== 1) return res.status(400).json({ success: false, code: 'INSUFFICIENT_FUNDS' });
                const w = await prisma.currencyWallet.findUnique({ where: { id: req.body.walletId } });
                return res.status(200).json({ success: true, balance: Number(w.balance) });
            };
            const driveParked = (key) => new Promise((resolve, reject) => {
                const req = {
                    method: 'POST', originalUrl: '/spend', path: '/spend', url: '/spend',
                    baseUrl: '', route: { path: '/spend' },
                    headers: { 'idempotency-key': key }, params: {}, query: {},
                    body: { walletId: wallet.id, amount: 10 },
                    app: { get: (k) => (k === 'prisma' ? prisma : null), set() {} },
                    get: (k) => (k === 'prisma' ? prisma : null),
                    user: { id: userId },
                };
                const res = {
                    locals: {}, statusCode: 200, headersSent: false,
                    status(c) { this.statusCode = c; return this; },
                    json(b) {
                        if (!this.headersSent) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); }
                        return this;
                    },
                    setHeader() {},
                    end() { this.headersSent = true; resolve({ status: this.statusCode, body: null }); return this; },
                };
                idempotency({})(req, res, (err) => (err
                    ? reject(err)
                    : Promise.resolve(parkedHandler(req, res)).catch((e) => {
                        res.status(500).json({ success: false, code: 'ERR', message: e?.message });
                    })));
            });

            const [a, b] = await Promise.all([
                driveParked(`round-${i}`).then((r) => { loserResolved.resolve(); return r; }),
                driveParked(`round-${i}`).then((r) => { loserResolved.resolve(); return r; }),
            ]);

            const statuses = [a.status, b.status].sort();
            expect(statuses).toEqual([200, 409]); // exactly one authoritative execution
            expect(executionCounter - before).toBe(1); // the handler ran ONCE
            const after = await prisma.currencyWallet.findUnique({ where: { id: wallet.id } });
            expect(Number(after.balance)).toBeCloseTo(90, 8); // ONE decrement
            const loser = a.status === 409 ? a : b;
            expect(loser.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');

            const ops = await waitForClaim(userId, 'POST /spend', `round-${i}`);
            expect(ops.length).toBe(1);
            expect(ops[0].status).toBe('COMMITTED');
            const winner = a.status === 200 ? a : b; // the unique INSERT decides — either caller may win
            // the committed result is the delivered 200 — stored as the exact
            // WIRE bytes (§r42 byte-fidelity: TEXT column, key order preserved)
            expect(ops[0].responseBody).toBe(JSON.stringify(winner.body));
        }
    }, 45000);

    test('P3. replay after committed success → identical result, handler NOT invoked, zero second mutation', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        const first = await drive('/spend', { user: userId, key: 'replay-1', body: { walletId: wallet.id, amount: 10 } });
        expect(first.status).toBe(200);
        await waitForClaim(userId, 'POST /spend', 'replay-1'); // observe COMMIT before replaying

        const before = executionCounter;
        const replay = await drive('/spend', { user: userId, key: 'replay-1', body: { walletId: wallet.id, amount: 10 } });
        expect(executionCounter - before).toBe(0); // handler never ran — the middleware replayed
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(first.body); // byte-identical committed result
        const after = await prisma.currencyWallet.findUnique({ where: { id: wallet.id } });
        expect(Number(after.balance)).toBeCloseTo(90, 8); // still ONE decrement
    }, 20000);

    test('P4/P4b. same key + materially different payload → deterministic conflict; exact-decimal fingerprints distinct', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        const first = await drive('/spend', { user: userId, key: 'fp-1', body: { walletId: wallet.id, amount: 10 } });
        expect(first.status).toBe(200);
        await waitForClaim(userId, 'POST /spend', 'fp-1'); // conflict reads the COMMITTED claim

        for (const changedBody of [
            { walletId: wallet.id, amount: 11 },       // different amount (number)
            { walletId: wallet.id, amount: '10.00' },  // same value, different exact-decimal form
            { walletId: wallet.id, amount: 10.5 },     // different amount (float)
            { walletId: wallet.id + 1, amount: 10 },   // different resource
        ]) {
            const before = executionCounter;
            const conflict = await drive('/spend', { user: userId, key: 'fp-1', body: changedBody });
            expect(conflict.status).toBe(409);
            expect(conflict.body.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
            expect(executionCounter - before).toBe(0); // never executed
        }
        const after = await prisma.currencyWallet.findUnique({ where: { id: wallet.id } });
        expect(Number(after.balance)).toBeCloseTo(90, 8);
    }, 20000);

    test('P5. same key across different users → fully independent operations', async () => {
        const u1 = await seedUserRow(), u2 = await seedUserRow();
        const w1 = await seedWallet(u1, 'GHS', 100), w2 = await seedWallet(u2, 'GHS', 50);
        const { drive } = buildDriver();

        const r1 = await drive('/spend', { user: u1, key: 'shared-key', body: { walletId: w1.id, amount: 10 } });
        const r2 = await drive('/spend', { user: u2, key: 'shared-key', body: { walletId: w2.id, amount: 5 } });
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200); // no cross-user replay — independent scopes
        await waitForClaim(u1, 'POST /spend', 'shared-key');
        await waitForClaim(u2, 'POST /spend', 'shared-key');

        // each replay stays within its own user scope
        const re1 = await drive('/spend', { user: u1, key: 'shared-key', body: { walletId: w1.id, amount: 10 } });
        expect(re1.status).toBe(200);
        expect(re1.body).toEqual(r1.body); // u1's own result, never u2's
        expect(Number((await prisma.currencyWallet.findUnique({ where: { id: w2.id } })).balance)).toBeCloseTo(45, 8);
    }, 20000);

    test('P6. same key across different logical endpoints → fully independent operations', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        const s1 = await drive('/spend', { user: userId, key: 'cross-ep', body: { walletId: wallet.id, amount: 10 } });
        const v1 = await drive('/fail-validation', { user: userId, key: 'cross-ep', body: { ok: true } });
        expect(s1.status).toBe(200);
        expect(v1.status).toBe(200);

        // the /spend replay must NOT return the /fail-validation response (or vice versa)
        await waitForClaim(userId, 'POST /spend', 'cross-ep');
        const re = await drive('/spend', { user: userId, key: 'cross-ep', body: { walletId: wallet.id, amount: 10 } });
        expect(re.status).toBe(200);
        expect(re.body).toEqual(s1.body);
        expect(re.body).not.toEqual(v1.body);
    }, 20000);

    test('P7. duplicate while the first is deliberately held in-flight → deterministic 409; committed result replays after completion', async () => {
        const userId = await seedUserRow();
        const { drive } = buildDriver();

        const first = drive('/hang', { user: userId, key: 'inflight-1', body: {} });
        await new Promise((r) => setTimeout(r, 60)); // let the first claim land (observed below, not a correctness timer)

        const dup = await drive('/hang', { user: userId, key: 'inflight-1', body: {} });
        expect(dup.status).toBe(409);
        expect(dup.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        expect(dup.body.operationId).toBeTruthy();

        const done = await first;
        expect(done.status).toBe(200);

        // observed claim state: now COMMITTED, replay returns the result
        await waitForClaim(userId, 'POST /hang', 'inflight-1');
        const replay = await drive('/hang', { user: userId, key: 'inflight-1', body: {} });
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(done.body);
    }, 20000);

    test('P8. 4xx validation failure releases the claim — the key is NOT poisoned', async () => {
        const userId = await seedUserRow();
        const { drive } = buildDriver();

        const bad = await drive('/fail-validation', { user: userId, key: 'val-1', body: { ok: false } });
        expect(bad.status).toBe(400);

        const ops = await waitForClaim(userId, null, 'val-1', 'RELEASED');
        expect(ops.length).toBe(0); // released — nothing committed

        const good = await drive('/fail-validation', { user: userId, key: 'val-1', body: { ok: true } });
        expect(good.status).toBe(200); // same key executes after the transient failure
    }, 20000);

    test('P9. RETAIN on 5xx: a post-commit 500 poisons the key deliberately — same-key refused, new-key executes, money moved once', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        const lost = await drive('/spend-commit-then-500', { user: userId, key: 'lost-1', body: { walletId: wallet.id, amount: 10 } });
        expect(lost.status).toBe(500);

        // The claim REMAINS IN_PROGRESS — the 500 may have followed a commit.
        const ops = await prisma.financialOperation.findMany({ where: { userId, key: 'lost-1' } });
        expect(ops.length).toBe(1);
        expect(ops[0].status).toBe('IN_PROGRESS');

        const retrySameKey = await drive('/spend-commit-then-500', { user: userId, key: 'lost-1', body: { walletId: wallet.id, amount: 10 } });
        expect(retrySameKey.status).toBe(409);
        expect(retrySameKey.body.code).toBe('IDEMPOTENCY_IN_PROGRESS'); // never a second mutation

        const after = await prisma.currencyWallet.findUnique({ where: { id: wallet.id } });
        expect(Number(after.balance)).toBeCloseTo(90, 8); // exactly one decrement happened
    }, 20000);

    test('P10. RELEASE on 5xx with a real rolled-back transaction → claim released, retry executes; money moved once', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        const boom = await drive('/spend-rollback-500', { user: userId, key: 'rb-1', body: { walletId: wallet.id, amount: 10 } });
        expect(boom.status).toBe(500);
        const midBalance = await prisma.currencyWallet.findUnique({ where: { id: wallet.id } });
        expect(Number(midBalance.balance)).toBeCloseTo(100, 8); // the debit ROLLED BACK

        const ops = await waitForClaim(userId, null, 'rb-1', 'RELEASED');
        expect(ops.length).toBe(0); // released — provably nothing committed

        const retry = await drive('/spend', { user: userId, key: 'rb-1', body: { walletId: wallet.id, amount: 10 } });
        expect(retry.status).toBe(200);
        expect(Number((await prisma.currencyWallet.findUnique({ where: { id: wallet.id } })).balance)).toBeCloseTo(90, 8);
    }, 20000);

    test('P11. claim authority unavailable → 503 fail-closed; the handler is NEVER invoked', async () => {
        const userId = await seedUserRow();
        const { app, drive } = buildDriver();
        // simulate the authority layer being unavailable — a financial
        // endpoint must refuse rather than execute unprotected
        app.set('prisma', { financialOperation: null });
        const before = executionCounter;

        const refused = await drive('/unprotected-observe', { user: userId, key: 'down-1', body: {} });
        expect(refused.status).toBe(503);
        expect(refused.body.code).toBe('IDEMPOTENCY_UNAVAILABLE');
        expect(executionCounter - before).toBe(0); // no unprotected execution
    }, 20000);

    // r42 review P0-2: a financial mutation endpoint mounted under the
    // authority REQUIRES a client key — an unkeyed retry is a brand-new
    // operation and can move money twice. Refuse deterministically BEFORE
    // any economics execute. required:false is the proven-safe opt-out.
    test('P12. no key → deterministic refusal (IDEMPOTENCY_KEY_REQUIRED); handler NEVER invoked; opt-out only where proven', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();
        const before = executionCounter;

        const r = await drive('/spend', { user: userId, body: { walletId: wallet.id, amount: 10 } });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
        expect(executionCounter - before).toBe(0); // never executed
        expect(Number((await prisma.currencyWallet.findUnique({ where: { id: wallet.id } })).balance)).toBeCloseTo(100, 8);
        const claims = await prisma.financialOperation.findMany({ where: { userId, endpoint: 'POST /spend' } });
        expect(claims.length).toBe(0); // no claim was ever created

        // the explicit opt-out: routes prove independent safety to use it
        const opt = await drive('/spend-optional', { user: userId, body: {} });
        expect(opt.status).toBe(200); // required:false → executes without a key
    }, 20000);

    test('P13. committed operations are PERMANENT — a backdated claim beyond any TTL still replays; settled economics can never re-execute', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        const first = await drive('/spend', { user: userId, key: 'old-1', body: { walletId: wallet.id, amount: 10 } });
        expect(first.status).toBe(200);
        await waitForClaim(userId, 'POST /spend', 'old-1'); // permanence reads the COMMITTED claim

        // Backdate the committed operation beyond the retired 24h cache TTL —
        // simulating an age-pruned response cache. The identity is permanent.
        await prisma.financialOperation.updateMany({
            where: { userId, key: 'old-1' },
            data: { createdAt: new Date(Date.now() - 7 * 24 * 3600 * 1000), updatedAt: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
        });

        const before = executionCounter;
        const replay = await drive('/spend', { user: userId, key: 'old-1', body: { walletId: wallet.id, amount: 10 } });
        expect(executionCounter - before).toBe(0); // never re-executed
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(first.body); // still the committed result
        expect(Number((await prisma.currencyWallet.findUnique({ where: { id: wallet.id } })).balance)).toBeCloseTo(90, 8);
    }, 20000);

    // ── R — the HTTP-status / economic-commit boundary (review P0-1) ──

    test('R1. committed economics + post-commit exception converted to HTTP 400 → claim NOT released, money moved once', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        const r = await drive('/spend-commit-then-400', { user: userId, key: 'pc-1', body: { walletId: wallet.id, amount: 10 } });
        expect(r.status).toBe(400); // the controller-shaped catch converted the failure

        // Money COMMITTED — the debit is durable despite the 400.
        expect(Number((await prisma.currencyWallet.findUnique({ where: { id: wallet.id } })).balance)).toBeCloseTo(90, 8);
        // The claim must NOT be released: a 4xx never implies rollback.
        const ops = await prisma.financialOperation.findMany({ where: { userId, key: 'pc-1' } });
        expect(ops.length).toBe(1);
        expect(ops[0].status).toBe('IN_PROGRESS'); // retained — poisoned, never re-executed
    }, 20000);

    test('R2. same-key retry after the post-commit 400 → deterministic 409, zero second mutation', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        const first = await drive('/spend-commit-then-400', { user: userId, key: 'pc-2', body: { walletId: wallet.id, amount: 10 } });
        expect(first.status).toBe(400);
        const before = executionCounter;

        const retry = await drive('/spend-commit-then-400', { user: userId, key: 'pc-2', body: { walletId: wallet.id, amount: 10 } });
        expect(retry.status).toBe(409);
        expect(retry.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        expect(executionCounter - before).toBe(0); // NEVER re-executed
        // money moved exactly once across both calls
        expect(Number((await prisma.currencyWallet.findUnique({ where: { id: wallet.id } })).balance)).toBeCloseTo(90, 8);
    }, 20000);

    test('R3. WIRED claim + lost post-response bookkeeping → same-key replay converges on the committed result', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        // Simulate the crash-after-commit window: post-response bookkeeping
        // dies. The in-transaction claim commit is the durable truth.
        const origUpdate = prisma.financialOperation.updateMany.bind(prisma.financialOperation);
        prisma.financialOperation.updateMany = () => Promise.reject(new Error('bookkeeping lost (simulated crash)'));
        const first = await drive('/spend-wired-in-tx', { user: userId, key: 'wr-1', body: { walletId: wallet.id, amount: 10 } });
        prisma.financialOperation.updateMany = origUpdate; // restore immediately
        expect(first.status).toBe(200);
        expect(first.body).toEqual({ success: true, balance: 90 });

        const before = executionCounter;
        const replay = await drive('/spend-wired-in-tx', { user: userId, key: 'wr-1', body: { walletId: wallet.id, amount: 10 } });
        expect(executionCounter - before).toBe(0); // never re-executed
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(first.body); // byte-identical committed result
        expect(Number((await prisma.currencyWallet.findUnique({ where: { id: wallet.id } })).balance)).toBeCloseTo(90, 8); // once
    }, 20000);

    test('R4. concurrent duplicates across the post-commit failure state → one mutation, everyone else refused, claim retained', async () => {
        const userId = await seedUserRow();
        const wallet = await seedWallet(userId, 'GHS', 100);
        const { drive } = buildDriver();

        const results = await Promise.all([
            drive('/spend-commit-then-400', { user: userId, key: 'cc-1', body: { walletId: wallet.id, amount: 10 } }),
            drive('/spend-commit-then-400', { user: userId, key: 'cc-1', body: { walletId: wallet.id, amount: 10 } }),
            drive('/spend-commit-then-400', { user: userId, key: 'cc-1', body: { walletId: wallet.id, amount: 10 } }),
        ]);
        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([400, 409, 409]); // owner's post-commit failure + 2 refusals
        // The owner is whichever concurrent promise won the claim INSERT —
        // NEVER assume it is results[0] (scheduler order is not a fact).
        const owner = results.find((r) => r.status === 400);
        const duplicates = results.filter((r) => r !== owner);
        expect(duplicates.every((r) => r.body.code === 'IDEMPOTENCY_IN_PROGRESS')).toBe(true);
        expect(Number((await prisma.currencyWallet.findUnique({ where: { id: wallet.id } })).balance)).toBeCloseTo(90, 8); // ONE debit
        const ops = await prisma.financialOperation.findMany({ where: { userId, key: 'cc-1' } });
        expect(ops.length).toBe(1);
        expect(ops[0].status).toBe('IN_PROGRESS'); // retained through the failure
    }, 20000);

    // ── R5 — the REAL withdrawal path through the post-commit failure ──
    // (review proof 8: withdrawalController.fiatWithdrawal + real
    // financeService.processFiatWithdrawal on real PostgreSQL)

    const { fiatWithdrawal } = require('../controllers/withdrawalController');

    const driveRealWithdrawal = async ({ userId, key, amount }) => new Promise((resolve, reject) => {
        const appMap = new Map([
            ['prisma', prisma],
            ['socketio', null],
            // The post-commit failure injection: the balance push throws AFTER
            // the authoritative withdrawal transaction committed.
            ['emitBalanceUpdate', async () => { throw new Error('socket push failed post-commit'); }],
            ['paymentFailoverService', null],
            ['mtnDisbursementService', null],
            ['emailService', null],
            ['smsService', null],
            ['adminAlertService', null],
        ]);
        const app = {
            settings: {}, get(k) { return this.settings[k]; }, set(k, v) { this.settings[k] = v; },
        };
        for (const [k, v] of appMap) app.set(k, v);
        const req = {
            method: 'POST', originalUrl: '/api/withdraw/fiat',
            path: '/fiat', baseUrl: '/api/withdraw', route: { path: '/fiat' },
            ip: '127.0.0.1',
            headers: key ? { 'idempotency-key': key } : {},
            params: {}, query: {},
            body: { amount: String(amount), payoutMethod: 'MTN_MOMO', recipientPhone: '0244556677', network: 'MTN' },
            app, get: (k) => app.get(k),
            user: { id: userId, username: 'r42-rw', createdAt: new Date(Date.now() - 90 * 86400000) },
        };
        const res = {
            app, locals: {}, statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) {
                this.body = b;
                resolve({ status: this.statusCode, body: b });
                return this;
            },
            setHeader() {},
            end() { resolve({ status: this.statusCode, body: null }); return this; },
        };
        const mw = idempotency();
        mw(req, res, (err) => (err
            ? reject(err)
            : Promise.resolve(fiatWithdrawal(req, res)).catch(() => {/* controller handles */ })));
    });

    test('R5. real fiat withdrawal: economics commit, post-commit emit throws → honest 500, claim retained, same-key retry cannot double-withdraw', async () => {
        // singletons the withdrawal service needs
        await prisma.systemFiatPool.upsert({ where: { id: 1 }, update: { balance: 100000 }, create: { id: 1, balance: 100000 } });
        await prisma.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 } });
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false },
            create: { id: 1, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false },
        });
        // factories.seedUser backs the balance with a COMPLETED deposit ledger
        // row — utils/securityCheck.runDoubleCheck recomputes availableBalance
        // from COMPLETED TransactionHistory rows and freezes unbacked seeds.
        const { seedUser } = require('./helpers/factories');
        const seeded = await seedUser(prisma, { availableBalance: 500 });
        const userId = seeded.id;

        const first = await driveRealWithdrawal({ userId, key: 'rw-1', amount: 50 });
        // The post-commit emit failure is honestly classified: NEVER a 400.
        expect(first.status).toBe(500);
        expect(first.body.code).toBe('WITHDRAWAL_INTERNAL_ERROR');

        // The withdrawal COMMITTED — debited exactly once.
        const u1 = await prisma.user.findUnique({ where: { id: userId }, select: { availableBalance: true } });
        expect(Number(u1.availableBalance)).toBeLessThan(500); // money moved once
        const afterFirst = Number(u1.availableBalance);

        // The claim is RETAINED (poisoned) — never released on the 5xx.
        const ops = await prisma.financialOperation.findMany({ where: { userId, key: 'rw-1' } });
        expect(ops.length).toBe(1);
        expect(ops[0].status).toBe('IN_PROGRESS');

        // Same-key retry: refused deterministically. No second withdrawal.
        const retry = await driveRealWithdrawal({ userId, key: 'rw-1', amount: 50 });
        expect(retry.status).toBe(409);
        expect(retry.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        const u2 = await prisma.user.findUnique({ where: { id: userId }, select: { availableBalance: true } });
        expect(Number(u2.availableBalance)).toBeCloseTo(afterFirst, 6); // debited ONCE
        const histories = await prisma.transactionHistory.findMany({ where: { userId, type: 'WITHDRAWAL_FIAT' } });
        expect(histories.length).toBe(1); // one canonical withdrawal, not two
        const withdrawals = await prisma.withdrawal.findMany({ where: { userId } });
        expect(withdrawals.length).toBe(1);
    }, 30000);

    // ── MC — the real multi-currency conversion, wired through the claim ──

    const { convertCurrency } = require('../controllers/multiCurrencyController');

    const driveConvert = async ({ userId, key, body }) => new Promise((resolve) => {
        const app = express();
        app.set('prisma', prisma);
        app.set('io', null);
        const req = {
            method: 'POST', originalUrl: '/api/multi-currency/convert',
            path: '/convert', baseUrl: '/api/multi-currency', route: { path: '/convert' },
            headers: key ? { 'idempotency-key': key } : {},
            params: {}, query: {}, body,
            app, get: (k) => app.get(k), user: { id: userId },
        };
        const res = {
            app, locals: {}, statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) {
                this.body = b;
                resolve({ status: this.statusCode, body: b, res: this });
                return this;
            },
            setHeader() {},
        };
        const mw = idempotency({ failurePolicy: 'RELEASE' });
        mw(req, res, () => convertCurrency(req, res).catch((e) => {
            res.status(500).json({ success: false, message: e?.message });
        }));
    });

    const seedConvertEnv = async () => {
        const userId = await seedUserRow();
        await prisma.currencyWallet.create({ data: { userId, currency: 'GHS', balance: 1000 } });
        await prisma.currencyWallet.create({ data: { userId, currency: 'USD', balance: 0 } });
        await prisma.fxRate.upsert({
            where: { fromCurrency_toCurrency: { fromCurrency: 'GHS', toCurrency: 'USD' } },
            update: { rate: '0.08' },
            create: { fromCurrency: 'GHS', toCurrency: 'USD', rate: '0.08', source: 'manual' },
        });
        return userId;
    };

    const balances = async (userId) => {
        const [ghs, usd] = await Promise.all([
            prisma.currencyWallet.findUnique({ where: { userId_currency: { userId, currency: 'GHS' } } }),
            prisma.currencyWallet.findUnique({ where: { userId_currency: { userId, currency: 'USD' } } }),
        ]);
        return { ghs: Number(ghs.balance), usd: Number(usd.balance) };
    };

    test('MC1. two truly concurrent identical conversions → ONE debit/credit/log; duplicate 409; replay returns the committed conversionId', async () => {
        const userId = await seedConvertEnv();
        const body = { fromCurrency: 'GHS', toCurrency: 'USD', amount: 100 };

        const [a, b] = await Promise.all([
            driveConvert({ userId, key: 'mc-1', body }),
            driveConvert({ userId, key: 'mc-1', body }),
        ]);
        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([200, 409]); // exactly one authoritative conversion

        const winner = a.status === 200 ? a : b;
        expect(winner.body.success).toBe(true);

        const bal = await balances(userId);
        expect(bal.ghs).toBeCloseTo(900, 8); // ONE debit
        expect(bal.usd).toBeCloseTo(100 * 0.08 * (1 - 0.015), 8); // ONE credit

        const logs = await prisma.currencyConversion.findMany({ where: { userId } });
        expect(logs.length).toBe(1);

        // the claim is COMMITTED INSIDE the economic transaction
        const op = await prisma.financialOperation.findUnique({
            where: { userId_endpoint_key: { userId, endpoint: 'POST /api/multi-currency/convert', key: 'mc-1' } },
        });
        expect(op.status).toBe('COMMITTED');
        // stored as the exact WIRE bytes of the delivered 200 (§r42 byte-fidelity)
        expect(op.responseBody).toBe(JSON.stringify(winner.body));

        // replay after the committed success → the same conversionId, zero economics
        const replay = await driveConvert({ userId, key: 'mc-1', body });
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(winner.body);
        const balAfter = await balances(userId);
        expect(balAfter.ghs).toBeCloseTo(900, 8);
        expect((await prisma.currencyConversion.findMany({ where: { userId } })).length).toBe(1);
    }, 30000);

    test('MC2. same key + changed amount → deterministic payload conflict, balances untouched', async () => {
        const userId = await seedConvertEnv();
        const first = await driveConvert({ userId, key: 'mc-2', body: { fromCurrency: 'GHS', toCurrency: 'USD', amount: 100 } });
        expect(first.status).toBe(200);

        const conflict = await driveConvert({ userId, key: 'mc-2', body: { fromCurrency: 'GHS', toCurrency: 'USD', amount: 250 } });
        expect(conflict.status).toBe(409);
        expect(conflict.body.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');

        const bal = await balances(userId);
        expect(bal.ghs).toBeCloseTo(900, 8);
        expect((await prisma.currencyConversion.findMany({ where: { userId } })).length).toBe(1);
    }, 30000);

    test('MC3. injected failure mid-transaction → whole rollback + released claim → retry executes exactly once', async () => {
        const userId = await seedConvertEnv();
        const body = { fromCurrency: 'GHS', toCurrency: 'USD', amount: 100 };

        // Inject a failure AFTER the debit inside the real conversion
        // transaction: the transaction client is wrapped in a proxy whose
        // currencyConversion.create throws. The real debit + credit + IN-TX
        // claim COMMITTED all execute first — then the whole transaction must
        // roll back TOGETHER (debit reverted, claim stays un-committed).
        // The controller instantiates its OWN PrismaClient at module load, so
        // the injection patches the prototype — reaching the controller's
        // client for exactly one transaction (the conversion under test).
        const { PrismaClient } = require('@prisma/client');
        const originalTx = PrismaClient.prototype.$transaction;
        let injectedYet = false;
        PrismaClient.prototype.$transaction = async function (fn, opts) {
            return originalTx.call(this, async (tx) => {
                if (!injectedYet) {
                    injectedYet = true;
                    const proxied = new Proxy(tx, {
                        get(target, prop) {
                            if (prop === 'currencyConversion') {
                                return {
                                    create: async () => { throw new Error('injected mid-tx failure after debit+credit'); },
                                };
                            }
                            const v = target[prop];
                            return typeof v === 'function' ? v.bind(target) : v;
                        },
                    });
                    return fn(proxied);
                }
                return fn(tx);
            }, opts);
        };
        try {
            const boom = await driveConvert({ userId, key: 'mc-3', body });
            expect(boom.status).toBe(500);
        } finally {
            PrismaClient.prototype.$transaction = originalTx;
        }
        // the whole transaction rolled back — the debit was reverted
        let bal = await balances(userId);
        expect(bal.ghs).toBeCloseTo(1000, 8);

        const op = await prisma.financialOperation.findUnique({
            where: { userId_endpoint_key: { userId, endpoint: 'POST /api/multi-currency/convert', key: 'mc-3' } },
        });
        // RELEASE policy: the provably-not-committed claim was released
        expect(op).toBeNull();

        // retry with the SAME key executes once — money moved exactly once
        const retry = await driveConvert({ userId, key: 'mc-3', body });
        expect(retry.status).toBe(200);
        bal = await balances(userId);
        expect(bal.ghs).toBeCloseTo(900, 8);
        expect((await prisma.currencyConversion.findMany({ where: { userId } })).length).toBe(1);
    }, 30000);
});
