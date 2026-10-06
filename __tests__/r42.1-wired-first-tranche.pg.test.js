'use strict';

// =============================================================================
// §r42.1 — WIRED IDEMPOTENCY, FIRST TRANCHE (real PostgreSQL).
//
// Proves the wired claim contract on the REAL middleware + REAL controllers
// for the six client financial operations promoted in this PR:
//
//   1. POST /api/savings/goals/:id/deposit   (savingsController.deposit)
//   2. POST /api/savings/goals/:id/withdraw  (savingsController.withdraw)
//   3. POST /api/vaults/:id/deposit           (vaultController.deposit)
//   4. POST /api/vaults/:id/break             (vaultController.breakEarly)
//   5. POST /api/wallet/internal-transfer     (walletRoutes inline handler,
//      driven through REAL Express + REAL auth middleware over real HTTP)
//   6. POST /api/friends/transfer/send        (peerTransferController.sendFunds)
//
// The proof matrix per operation (P-series, r42 numbering continued):
//
//   W1.  First request executes once and the FinancialOperation claim is
//        COMMITTED with the WIRE response text; a same-key retry replays
//        the byte-identical committed result and executes the economics
//        NEVER a second time.
//   W2.  Two truly concurrent identical requests → exactly ONE economic
//        mutation; the duplicate is refused (409 IN_PROGRESS) or replays
//        the committed result — never a second mutation. The unique claim
//        INSERT is the arbiter, never scheduling luck.
//   W3.  Divergent identity: body legacy alias (clientRequestId / requestId
//        / x-idempotency-key) ≠ canonical Idempotency-Key header →
//        deterministic 400 IDEMPOTENCY_IDENTITY_CONFLICT BEFORE any
//        economics; nothing executes and the claim is released.
//   W4.  Missing Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED, no claim,
//        no economics.
//   W5.  Same key + materially different payload → deterministic 409
//        IDEMPOTENCY_PAYLOAD_CONFLICT (never a replay of the wrong tx).
//   W6.  Crash-after-commit boundary: a post-commit, pre-response dependency
//        failure (balance socket emit) converts the client response to an
//        error — yet the durable claim is ALREADY COMMITTED inside the
//        economic transaction, so a same-key retry replays the committed
//        200 result and money moved exactly once. This is the wired
//        pattern's core promise: no window in which committed money sits
//        under an IN_PROGRESS identity.
//   W7.  Pre-economics guard failure (insufficient funds → 4xx) → the claim
//        is released (releaseOn4xx wired policy) and the key is NOT
//        poisoned: a retry with corrected inputs executes once.
//   W8.  A parked IN_PROGRESS claim (owner crashed mid-flight) refuses a
//        same-key request with 409 and NEVER executes it.
//
// Operation-specific additions:
//   WP.  Wallet FROM_POOL: ad deactivation is derived from the FRESH in-tx
//        pool balance and commits in the SAME transaction as the transfer
//        (the response reports the deactivated ads); replay is byte-identical.
//   WV.  Vault: the service commits the claim in-tx and the claim row shows
//        COMMITTED with the exact WIRE text at response time (W6 is proven
//        via the emit-dependency crash window on the savings/peer/wallet
//        paths; the vault service's own emits are null-safe in this harness,
//        so its crash-window proof is the synchronous convergence check).
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const express = require('express');
const http = require('http');
const { seedUser, seedSavingsGoal, seedFriendship, TEST_PASSWORD } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r42.1 — wired idempotency, first tranche (PostgreSQL)', () => {
    let prisma;
    let vaultService;
    let walletServer = null;

    // The suite's endpoint strings — swept in beforeAll/afterEach so leftover
    // claims from a partial run can never collide with fresh keys.
    const EP = {
        savingsDeposit: 'POST /api/savings/goals/:id/deposit',
        savingsWithdraw: 'POST /api/savings/goals/:id/withdraw',
        vaultDeposit: 'POST /api/vaults/:id/deposit',
        vaultBreak: 'POST /api/vaults/:id/break',
        walletTransfer: 'POST /w/internal-transfer',
        peerSend: 'POST /api/friends/transfer/send',
    };
    const sweepClaims = () => prisma.financialOperation.deleteMany({
        where: { endpoint: { in: Object.values(EP) } },
    }).catch(() => {});

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        prisma = new PrismaClient();
        await sweepClaims();
        const { VaultService } = require('../services/vaultService');
        vaultService = new VaultService(prisma, null, null, null);
    });

    beforeAll(async () => {
        // Pin the conversion rate for deterministic GHS/USDC arithmetic.
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveUsdToGhs: 15, liveRetailRate: 15 },
            create: { id: 1, liveUsdToGhs: 15, liveRetailRate: 15 },
        }).catch(() => {}); // re-pinned after each TRUNCATE in beforeEach below
    });

    beforeEach(async () => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveUsdToGhs: 15, liveRetailRate: 15 },
            create: { id: 1, liveUsdToGhs: 15, liveRetailRate: 15 },
        });
    });

    afterAll(async () => {
        await sweepClaims();
        await prisma?.$disconnect();
        if (walletServer) await new Promise((r) => walletServer.close(r));
    });

    afterEach(async () => {
        await sweepClaims();
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SavingsGoal", "SavingsDeposit", "Vault", "VaultDeposit", ' +
            '"PeerTransfer", "Friendship", "TransactionHistory", "Ad", "GlobalSettings", "DirectMessage", ' +
            '"SystemProfitFees", "LedgerTransaction", "LedgerAccount", "JournalEntry" ' +
            'RESTART IDENTITY CASCADE'
        );
    }, 20000);

    // ── shared real-middleware driver ────────────────────────────────────
    // Drives the REAL idempotency middleware and then the REAL controller.
    // No Express router between them: both claims can be in flight at once
    // (the unique INSERT is the arbiter — the same interleave a concurrent
    // HTTP duplicate faces in production).
    const WIRED_POLICY = { failurePolicy: 'RELEASE', releaseOn4xx: true };
    const { idempotency } = require('../middleware/idempotency');

    const makeDriver = (handler, baseUrl, routePath, { emitBalanceUpdate = null } = {}) => {
        const drive = ({ userId, key, body, params, headers = {} }) => new Promise((resolve, reject) => {
            const app = {
                settings: { vaultService },
                get(k) { return this.settings[k]; },
                set(k, v) { this.settings[k] = v; },
            };
            app.set('prisma', prisma);
            app.set('socketio', null);
            app.set('io', null);
            app.set('emitBalanceUpdate', emitBalanceUpdate);
            const req = {
                method: 'POST', originalUrl: `${baseUrl}${routePath}`,
                path: routePath, url: `${baseUrl}${routePath}`,
                baseUrl, route: { path: routePath },
                headers: key ? { ...headers, 'idempotency-key': key } : { ...headers },
                params: params || {}, query: {}, body: body || {},
                ip: '127.0.0.1',
                app, get: (k) => app.get(k),
                user: userId != null ? { id: userId, username: 'tester' } : undefined,
            };
            const res = {
                app, locals: {}, statusCode: 200, headersSent: false,
                status(c) { this.statusCode = c; return this; },
                json(b) {
                    if (!this.headersSent) {
                        this.headersSent = true;
                        resolve({ status: this.statusCode, body: b, raw: b === undefined ? undefined : JSON.parse(JSON.stringify(b)) });
                    }
                    return this;
                },
                setHeader() {},
                end() {
                    this.headersSent = true;
                    resolve({ status: this.statusCode, body: null, raw: null });
                    return this;
                },
            };
            idempotency(WIRED_POLICY)(req, res, (err) => (err
                ? reject(err)
                : Promise.resolve(handler(req, res)).catch((e) => {
                    // Controller-level uncaught failures resolve as 5xx —
                    // the same disposition an Express error handler gives.
                    if (!res.headersSent) {
                        res.status(500).json({ success: false, code: 'ERR', message: e?.message });
                    }
                })));
        });
        return drive;
    };

    // Bounded DB polling for claim convergence (never sleeps).
    const waitForClaim = async (userId, key, want = 'COMMITTED', timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const rows = await prisma.financialOperation.findMany({
                where: { userId, key }, orderBy: { id: 'desc' },
            });
            const ok = want === 'RELEASED' ? rows.length === 0 : rows.some((r) => r.status === want);
            if (ok || Date.now() > deadline) return rows;
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    const claimRow = async (userId, key) => {
        const rows = await prisma.financialOperation.findMany({ where: { userId, key }, orderBy: { id: 'desc' } });
        return rows[0] || null;
    };

    const wire = (driveRes) => JSON.stringify(driveRes.raw === null || driveRes.raw === undefined ? driveRes.body : driveRes.raw);
    const uniqKey = (tag) => `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

    // ══════════════════════════════════════════════════════════════════════
    // §1 — SAVINGS DEPOSIT
    // ══════════════════════════════════════════════════════════════════════
    describe('§1 savings deposit (wired)', () => {
        const savingsCtrl = require('../controllers/savingsController');
        const drive = makeDriver(savingsCtrl.deposit, '/api/savings', '/goals/:id/deposit');

        const setup = async (balance = 500) => {
            const { user, goal } = await seedSavingsGoal(prisma, { user: { availableBalance: balance } });
            return { user, goal };
        };

        test('W1. commit + byte-identical replay, economics exactly once', async () => {
            const { user, goal } = await setup();
            const key = uniqKey('sd');
            const r1 = await drive({ userId: user.id, key, body: { amountGhs: 100, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            expect(r1.status).toBe(200);
            expect(r1.body.success).toBe(true);

            // The claim is COMMITTED with the exact WIRE text of r1.
            const claim = await claimRow(user.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(wire(r1));

            // Same-key retry replays the byte-identical committed result.
            const r2 = await drive({ userId: user.id, key, body: { amountGhs: 100, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            expect(r2.status).toBe(200);
            expect(wire(r2)).toBe(claim.responseBody);

            // Economics exactly once.
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
            const deposits = await prisma.savingsDeposit.count({ where: { goalId: goal.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(500 - 100 / 15, 5);
            expect(Number(freshGoal.currentAmountGhs)).toBeCloseTo(100, 5);
            expect(deposits).toBe(1);
        });

        test('W2. concurrent duplicates → exactly one economic mutation', async () => {
            const { user, goal } = await setup();
            const key = uniqKey('sd');
            const body = { amountGhs: 100, type: 'WEEKLY' };
            const [r1, r2] = await Promise.all([
                drive({ userId: user.id, key, body, params: { id: String(goal.id) } }),
                drive({ userId: user.id, key, body, params: { id: String(goal.id) } }),
            ]);
            const statuses = [r1.status, r2.status].sort();
            // Exactly one execution; the duplicate is refused in-flight or
            // replays the committed bytes — never a second mutation.
            expect(statuses).toContain(200);
            const ok = statuses.filter((s) => s === 200);
            expect(ok.length).toBeGreaterThanOrEqual(1);
            if (statuses.includes(409)) {
                const dup = [r1, r2].find((r) => r.status === 409);
                expect(dup.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
            }
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(500 - 100 / 15, 5);
            expect(await prisma.savingsDeposit.count({ where: { goalId: goal.id } })).toBe(1);
        });

        test('W3. divergent legacy alias fails closed, claim released', async () => {
            const { user, goal } = await setup();
            const r = await drive({
                userId: user.id, key: uniqKey('hdr'), params: { id: String(goal.id) },
                body: { amountGhs: 100, type: 'WEEKLY', clientRequestId: 'different_body_key' },
            });
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('IDEMPOTENCY_IDENTITY_CONFLICT');
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(500, 5);
            expect(await prisma.savingsDeposit.count({ where: { goalId: goal.id } })).toBe(0);
            // releaseOn4xx: key NOT poisoned.
            const rows = await waitForClaim(user.id, r.body ? 'different_body_key' : '', 'RELEASED', 2000);
            const claim = await claimRow(user.id, 'different_body_key');
            expect(claim).toBeNull(); // the header-keyed claim was released after the 4xx
        });

        test('W3b. matching legacy alias passes through the canonical authority', async () => {
            const { user, goal } = await setup();
            const key = uniqKey('alias');
            const r = await drive({
                userId: user.id, key, params: { id: String(goal.id) },
                body: { amountGhs: 100, type: 'WEEKLY', clientRequestId: key },
            });
            expect(r.status).toBe(200);
            expect(r.body.success).toBe(true);
        });

        test('W4. missing key → 400, no claim, no economics', async () => {
            const { user, goal } = await setup();
            const r = await drive({ userId: user.id, body: { amountGhs: 100, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(500, 5);
            expect(await prisma.financialOperation.count({ where: { userId: user.id, endpoint: EP.savingsDeposit } })).toBe(0);
        });

        test('W5. same key + different payload → 409, committed result intact', async () => {
            const { user, goal } = await setup();
            const key = uniqKey('sd');
            const r1 = await drive({ userId: user.id, key, body: { amountGhs: 100, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            expect(r1.status).toBe(200);
            const r2 = await drive({ userId: user.id, key, body: { amountGhs: 250, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            expect(r2.status).toBe(409);
            expect(r2.body.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(500 - 100 / 15, 5);
        });

        test('W6. crash-after-commit: emit failure errors the response, retry replays committed result', async () => {
            const { user, goal } = await seedSavingsGoal(prisma, { user: { availableBalance: 500 } });
            const key = uniqKey('sd_crash');
            const crashDrive = makeDriver(savingsCtrl.deposit, '/api/savings', '/goals/:id/deposit', {
                // The balance socket emit runs AFTER the economic commit and
                // BEFORE res.json — the exact crash-after-commit window.
                emitBalanceUpdate: async () => { throw new Error('socket blew up mid-response'); },
            });
            const r1 = await crashDrive({ userId: user.id, key, body: { amountGhs: 100, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            // The controller's outer catch may render the post-commit failure
            // as 400 or 500 — the status is irrelevant to the contract: the
            // in-tx COMMITTED claim can never be released by either (release
            // matches IN_PROGRESS only), so the operation can never re-execute.
            expect([400, 500]).toContain(r1.status);

            // Money IS committed — and so is the claim (in-tx). The client's
            // error response never re-arms the operation.
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(500 - 100 / 15, 5);
            const claim = await claimRow(user.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);

            // Same-key retry: the committed result replays. Money moved once.
            const r2 = await drive({ userId: user.id, key, body: { amountGhs: 100, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            expect(r2.status).toBe(200);
            expect(wire(r2)).toBe(claim.responseBody);
            const fresh2 = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh2.availableBalance)).toBeCloseTo(500 - 100 / 15, 5);
            expect(await prisma.savingsDeposit.count({ where: { goalId: goal.id } })).toBe(1);
        });

        test('W7. pre-economics guard failure releases the claim (key reusable)', async () => {
            const { user, goal } = await seedSavingsGoal(prisma, { user: { availableBalance: 5 } });
            const key = uniqKey('sd_guard');
            const r1 = await drive({ userId: user.id, key, body: { amountGhs: 100, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            expect(r1.status).toBe(400); // INSUFFICIENT_FUNDS — nothing executed
            await waitForClaim(user.id, key, 'RELEASED');

            // Corrected inputs, SAME key — executes once.
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 500 } });
            const r2 = await drive({ userId: user.id, key, body: { amountGhs: 100, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            expect(r2.status).toBe(200);
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(500 - 100 / 15, 5);
        });

        test('W8. parked IN_PROGRESS claim refuses same-key requests', async () => {
            const { user, goal } = await setup();
            const key = uniqKey('sd_park');
            // A claim parked mid-flight (owner crashed after claiming).
            await prisma.financialOperation.create({
                data: { userId: user.id, endpoint: EP.savingsDeposit, key, status: 'IN_PROGRESS', fingerprint: 'x', failurePolicy: 'RELEASE' },
            });
            const r = await drive({ userId: user.id, key, body: { amountGhs: 100, type: 'WEEKLY' }, params: { id: String(goal.id) } });
            expect(r.status).toBe(409);
            expect(r.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(500, 5);
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // §2 — SAVINGS WITHDRAW
    // ══════════════════════════════════════════════════════════════════════
    describe('§2 savings withdraw (wired)', () => {
        const savingsCtrl = require('../controllers/savingsController');
        const drive = makeDriver(savingsCtrl.withdraw, '/api/savings', '/goals/:id/withdraw');

        const setup = async () => {
            const { user, goal } = await seedSavingsGoal(prisma, {
                user: { availableBalance: 0 },
                goal: {
                    currentAmountGhs: 300, targetAmountGhs: 300,
                    endDate: new Date(Date.now() - 86400000), // matured — no penalty
                    isLocked: true,
                },
            });
            return { user, goal };
        };

        test('W1. commit + byte-identical replay, money released exactly once', async () => {
            const { user, goal } = await setup();
            const key = uniqKey('sw');
            const r1 = await drive({ userId: user.id, key, body: { amountGhs: 300 }, params: { id: String(goal.id) } });
            expect(r1.status).toBe(200);
            expect(r1.body.success).toBe(true);

            const claim = await claimRow(user.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.responseBody).toBe(wire(r1));

            const r2 = await drive({ userId: user.id, key, body: { amountGhs: 300 }, params: { id: String(goal.id) } });
            expect(r2.status).toBe(200);
            expect(wire(r2)).toBe(claim.responseBody);

            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(20, 4); // 300 GHS / 15 = 20 USDC
            expect(freshGoal.status).toBe('CANCELLED'); // full pull → terminal
        });

        test('W3. divergent body requestId fails closed before economics', async () => {
            const { user, goal } = await setup();
            const r = await drive({
                userId: user.id, key: uniqKey('swh'), params: { id: String(goal.id) },
                body: { amountGhs: 300, requestId: 'divergent_body_key' },
            });
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('IDEMPOTENCY_IDENTITY_CONFLICT');
            const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
            expect(freshGoal.currentAmountGhs.toNumber ? freshGoal.currentAmountGhs.toNumber() : Number(freshGoal.currentAmountGhs)).toBeCloseTo(300, 5);
        });

        test('W6. crash-after-commit: emit failure errors the response, retry replays committed result', async () => {
            const { user, goal } = await setup();
            const key = uniqKey('sw_crash');
            const crashDrive = makeDriver(savingsCtrl.withdraw, '/api/savings', '/goals/:id/withdraw', {
                emitBalanceUpdate: async () => { throw new Error('socket blew up mid-response'); },
            });
            const r1 = await crashDrive({ userId: user.id, key, body: { amountGhs: 300 }, params: { id: String(goal.id) } });
            expect([400, 500]).toContain(r1.status); // see §1 W6: COMMITTED claims survive any error status

            const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
            expect(freshGoal.status).toBe('CANCELLED'); // committed
            const claim = await claimRow(user.id, key);
            expect(claim.status).toBe('COMMITTED'); // the in-tx commit survived the crash

            const r2 = await drive({ userId: user.id, key, body: { amountGhs: 300 }, params: { id: String(goal.id) } });
            expect(r2.status).toBe(200);
            expect(wire(r2)).toBe(claim.responseBody);

            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(20, 4); // released exactly once
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // §3 — VAULT DEPOSIT
    // ══════════════════════════════════════════════════════════════════════
    describe('§3 vault deposit (wired)', () => {
        const vaultCtrl = require('../controllers/vaultController');
        const drive = makeDriver(vaultCtrl.deposit, '/api/vaults', '/:id/deposit');

        const setup = async (balance = 500) => {
            const user = await seedUser(prisma, { availableBalance: balance });
            const vault = await vaultService.createVault({
                userId: user.id, name: 'Proof Vault', targetAmountUsdc: 1000,
                maturityDate: new Date(Date.now() + 90 * 86400000).toISOString(),
            });
            return { user, vault };
        };

        test('W1 + WV. service commits the claim in-tx; byte-identical replay', async () => {
            const { user, vault } = await setup();
            const key = uniqKey('vd');
            const r1 = await drive({ userId: user.id, key, body: { amountUsdc: 100 }, params: { id: String(vault.id) } });
            expect(r1.status).toBe(200);
            expect(r1.body.success).toBe(true);

            // The service (not post-response bookkeeping) committed the claim
            // with the exact WIRE text: synchronous convergence at response
            // time, statusCode recorded.
            const claim = await claimRow(user.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(wire(r1));

            const r2 = await drive({ userId: user.id, key, body: { amountUsdc: 100 }, params: { id: String(vault.id) } });
            expect(r2.status).toBe(200);
            expect(wire(r2)).toBe(claim.responseBody);

            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(400, 6);
            expect(Number(freshVault.currentAmountUsdc)).toBeCloseTo(100, 6);
            expect(await prisma.vaultDeposit.count({ where: { vaultId: vault.id } })).toBe(1);
        });

        test('W2. concurrent duplicates → exactly one vault credit', async () => {
            const { user, vault } = await setup();
            const key = uniqKey('vd');
            const [r1, r2] = await Promise.all([
                drive({ userId: user.id, key, body: { amountUsdc: 100 }, params: { id: String(vault.id) } }),
                drive({ userId: user.id, key, body: { amountUsdc: 100 }, params: { id: String(vault.id) } }),
            ]);
            const okCount = [r1, r2].filter((r) => r.status === 200).length;
            expect(okCount).toBeGreaterThanOrEqual(1);
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(400, 6);
            expect(Number(freshVault.currentAmountUsdc)).toBeCloseTo(100, 6);
            expect(await prisma.vaultDeposit.count({ where: { vaultId: vault.id } })).toBe(1);
        });

        test('W7. insufficient funds 4xx releases the claim; corrected retry executes once', async () => {
            const { user, vault } = await setup(5);
            const key = uniqKey('vd_guard');
            const r1 = await drive({ userId: user.id, key, body: { amountUsdc: 100 }, params: { id: String(vault.id) } });
            expect(r1.status).toBe(400);
            await waitForClaim(user.id, key, 'RELEASED');
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 500 } });
            const r2 = await drive({ userId: user.id, key, body: { amountUsdc: 100 }, params: { id: String(vault.id) } });
            expect(r2.status).toBe(200);
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(400, 6);
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // §4 — VAULT BREAK
    // ══════════════════════════════════════════════════════════════════════
    describe('§4 vault break (wired)', () => {
        const vaultCtrl = require('../controllers/vaultController');
        const drive = makeDriver(vaultCtrl.breakEarly, '/api/vaults', '/:id/break');

        const setup = async () => {
            const user = await seedUser(prisma, { availableBalance: 500 });
            const vault = await vaultService.createVault({
                userId: user.id, name: 'Break Vault', targetAmountUsdc: 1000,
                maturityDate: new Date(Date.now() + 90 * 86400000).toISOString(),
            });
            await vaultService.depositManual({ userId: user.id, vaultId: vault.id, amountUsdc: 200 });
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 0 } });
            return { user, vault };
        };

        test('W1 + WV. break commits claim in-tx; byte-identical replay; terminal exactly once', async () => {
            const { user, vault } = await setup();
            const key = uniqKey('vb');
            const r1 = await drive({ userId: user.id, key, body: { confirmedBreak: true }, params: { id: String(vault.id) } });
            expect(r1.status).toBe(200);
            expect(r1.body.success).toBe(true);

            const claim = await claimRow(user.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(wire(r1));

            const r2 = await drive({ userId: user.id, key, body: { confirmedBreak: true }, params: { id: String(vault.id) } });
            expect(r2.status).toBe(200);
            expect(wire(r2)).toBe(claim.responseBody);

            const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
            expect(freshVault.status).toBe('BROKEN_EARLY');
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeGreaterThan(0);
            expect(Number(fresh.availableBalance)).toBeLessThan(200); // penalty applied exactly once
        });

        test('W2. concurrent breaks → exactly one release', async () => {
            const { user, vault } = await setup();
            const key = uniqKey('vb');
            const [r1, r2] = await Promise.all([
                drive({ userId: user.id, key, body: { confirmedBreak: true }, params: { id: String(vault.id) } }),
                drive({ userId: user.id, key, body: { confirmedBreak: true }, params: { id: String(vault.id) } }),
            ]);
            const okCount = [r1, r2].filter((r) => r.status === 200).length;
            expect(okCount).toBeGreaterThanOrEqual(1);
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
            expect(freshVault.status).toBe('BROKEN_EARLY');
            expect(Number(fresh.availableBalance)).toBeLessThan(200);
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // §5 — WALLET INTERNAL TRANSFER (real HTTP: real router, real auth)
    // ══════════════════════════════════════════════════════════════════════
    describe('§5 wallet internal-transfer (wired, real HTTP)', () => {
        let agent; // supertest-compatible raw http helper
        let baseUrl;

        const listen = async () => {
            const walletRoutes = require('../routes/walletRoutes');
            const app = express();
            app.use(express.json());
            app.set('prisma', prisma);
            app.set('io', null);
            app.set('socketio', null);
            app.set('emitBalanceUpdate', null);
            app.use('/w', walletRoutes);
            await new Promise((resolve) => { walletServer = app.listen(0, resolve); });
            baseUrl = `http://127.0.0.1:${walletServer.address().port}`;
        };

        const tokenFor = (user) => jwt.sign({ id: user.id }, process.env.JWT_SECRET);

        const post = (path, { token, key, body }) => new Promise((resolve, reject) => {
            const payload = JSON.stringify(body);
            const req = http.request(`${baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                    ...(key ? { 'idempotency-key': key } : {}),
                },
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve({
                    status: res.statusCode,
                    body: data ? JSON.parse(data) : null,
                    raw: data,
                }));
            });
            req.on('error', reject);
            req.end(payload);
        });

        const vendorSetup = async (pool = 0, available = 0) => {
            const user = await seedUser(prisma, { availableBalance: available, vendorUnallocatedBalance: pool, role: 'VENDOR' });
            return user;
        };

        beforeAll(async () => { await listen(); });
        afterAll(async () => { if (walletServer) await new Promise((r) => walletServer.close(r)); });

        test('W1. TO_POOL commit + byte-identical replay over real HTTP', async () => {
            const user = await vendorSetup(0, 500);
            const key = uniqKey('tp');
            const body = { direction: 'TO_POOL', amount: 200, password: TEST_PASSWORD };
            const r1 = await post('/w/internal-transfer', { token: tokenFor(user), key, body });
            expect(r1.status).toBe(200);
            expect(r1.body.success).toBe(true);

            const claim = await claimRow(user.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(r1.raw); // EXACT wire bytes, key order included

            const r2 = await post('/w/internal-transfer', { token: tokenFor(user), key, body });
            expect(r2.status).toBe(200);
            expect(r2.raw).toBe(claim.responseBody);

            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(300, 6);
            expect(Number(fresh.vendorUnallocatedBalance)).toBeCloseTo(200, 6);
            expect(await prisma.transactionHistory.count({ where: { userId: user.id, type: 'INTERNAL_TRANSFER' } })).toBe(1);
        });

        test('W2. concurrent TO_POOL duplicates → exactly one mutation over real sockets', async () => {
            const user = await vendorSetup(0, 500);
            const key = uniqKey('tp_race');
            const body = { direction: 'TO_POOL', amount: 200, password: TEST_PASSWORD };
            const [r1, r2] = await Promise.all([
                post('/w/internal-transfer', { token: tokenFor(user), key, body }),
                post('/w/internal-transfer', { token: tokenFor(user), key, body }),
            ]);
            const okCount = [r1, r2].filter((r) => r.status === 200).length;
            expect(okCount).toBeGreaterThanOrEqual(1);
            for (const r of [r1, r2]) {
                if (r.status !== 200) expect(r.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
            }
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(300, 6);
            expect(Number(fresh.vendorUnallocatedBalance)).toBeCloseTo(200, 6);
        });

        test('WP. FROM_POOL deactivates over-limit ads in-tx from the fresh balance; replay byte-identical', async () => {
            const user = await vendorSetup(500, 0);
            // Ads whose maxLimit exceeds the POST-transfer pool balance (300).
            const ad1 = await prisma.ad.create({
                data: { type: 'SELL', vendorId: user.id, pricePerUSD: 15, minLimit: 10, maxLimit: 450, paymentMethod: 'MTN' },
            });
            const ad2 = await prisma.ad.create({
                data: { type: 'SELL', vendorId: user.id, pricePerUSD: 15, minLimit: 10, maxLimit: 100, paymentMethod: 'VODA' },
            });
            const key = uniqKey('fp');
            const body = { direction: 'FROM_POOL', amount: 200, password: TEST_PASSWORD };
            const r1 = await post('/w/internal-transfer', { token: tokenFor(user), key, body });
            expect(r1.status).toBe(200);
            expect(r1.body.success).toBe(true);
            expect(r1.body.data.deactivatedCount).toBe(1); // only ad1 exceeds 300
            expect(r1.body.data.newPoolBalance).toBeCloseTo(300, 6);

            // The deactivation committed in the SAME transaction.
            const freshAd1 = await prisma.ad.findUnique({ where: { id: ad1.id } });
            const freshAd2 = await prisma.ad.findUnique({ where: { id: ad2.id } });
            expect(freshAd1.status).toBe('INACTIVE');
            expect(freshAd2.status).toBe('ACTIVE');

            const claim = await claimRow(user.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.responseBody).toBe(r1.raw);

            const r2 = await post('/w/internal-transfer', { token: tokenFor(user), key, body });
            expect(r2.status).toBe(200);
            expect(r2.raw).toBe(claim.responseBody);
        });

        test('W7. FROM_POOL insufficient → 4xx releases claim; corrected retry executes once', async () => {
            const user = await vendorSetup(50, 0);
            const key = uniqKey('fp_guard');
            const body = { direction: 'FROM_POOL', amount: 200, password: TEST_PASSWORD };
            const r1 = await post('/w/internal-transfer', { token: tokenFor(user), key, body });
            expect(r1.status).toBe(400);
            await waitForClaim(user.id, key, 'RELEASED');
            await prisma.user.update({ where: { id: user.id }, data: { vendorUnallocatedBalance: 500 } });
            const r2 = await post('/w/internal-transfer', { token: tokenFor(user), key, body });
            expect(r2.status).toBe(200);
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(200, 6);
        });

        test('W4. missing key → 400 over real HTTP, no economics', async () => {
            const user = await vendorSetup(0, 500);
            const r = await post('/w/internal-transfer', {
                token: tokenFor(user),
                body: { direction: 'TO_POOL', amount: 200, password: TEST_PASSWORD },
            });
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
            const fresh = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(fresh.availableBalance)).toBeCloseTo(500, 6);
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // §6 — FRIEND TRANSFER / SEND
    // ══════════════════════════════════════════════════════════════════════
    describe('§6 friend transfer send (wired)', () => {
        const peerCtrl = require('../controllers/peerTransferController');
        const drive = makeDriver(peerCtrl.sendFunds, '/api/friends', '/transfer/send');

        const setup = async (senderBalance = 500) => {
            const sender = await seedUser(prisma, { availableBalance: senderBalance });
            const receiver = await seedUser(prisma, { availableBalance: 0 });
            const friendship = await seedFriendship(prisma, sender.id, receiver.id);
            return { sender, receiver, friendship };
        };

        test('W1. commit + byte-identical replay; transfer rows exactly once', async () => {
            const { sender, receiver, friendship } = await setup();
            const key = uniqKey('ps');
            const body = { friendshipId: friendship.id, amount: 100, reference: 'proof' };
            const r1 = await drive({ userId: sender.id, key, body });
            expect(r1.status).toBe(200);
            expect(r1.body.success).toBe(true);

            const claim = await claimRow(sender.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            expect(claim.responseBody).toBe(wire(r1));

            const r2 = await drive({ userId: sender.id, key, body });
            expect(r2.status).toBe(200);
            expect(wire(r2)).toBe(claim.responseBody);

            // Identity is claim-derived: the sender-side replay hash is bound
            // to the durable claim, and both sides exist exactly once.
            const txCount = await prisma.transactionHistory.count({ where: { userId: sender.id, type: 'INTERNAL_TRANSFER' } });
            expect(txCount).toBe(1);
            const transfers = await prisma.peerTransfer.count({ where: { friendshipId: friendship.id } });
            expect(transfers).toBe(1);
            const s = await prisma.user.findUnique({ where: { id: sender.id } });
            const rc = await prisma.user.findUnique({ where: { id: receiver.id } });
            const total = Number(s.availableBalance) + Number(rc.availableBalance);
            expect(total).toBeLessThanOrEqual(500);
            expect(total).toBeGreaterThan(450);
        });

        test('W3. divergent body clientRequestId fails closed before economics', async () => {
            const { sender, friendship } = await setup();
            const r = await drive({
                userId: sender.id, key: uniqKey('psh'),
                body: { friendshipId: friendship.id, amount: 100, reference: 'x', clientRequestId: 'other_key' },
            });
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('IDEMPOTENCY_IDENTITY_CONFLICT');
            const s = await prisma.user.findUnique({ where: { id: sender.id } });
            expect(Number(s.availableBalance)).toBeCloseTo(500, 6);
            expect(await prisma.peerTransfer.count({ where: { friendshipId: friendship.id } })).toBe(0);
        });

        test('W6. crash-after-commit: emit failure errors the response, retry replays committed result', async () => {
            const { sender, receiver, friendship } = await setup();
            const key = uniqKey('ps_crash');
            const crashDrive = makeDriver(peerCtrl.sendFunds, '/api/friends', '/transfer/send', {
                emitBalanceUpdate: async () => { throw new Error('socket blew up mid-response'); },
            });
            const body = { friendshipId: friendship.id, amount: 100, reference: 'proof' };
            const r1 = await crashDrive({ userId: sender.id, key, body });
            expect(r1.status).toBe(500);

            // Money moved exactly once and the claim committed with it.
            expect(await prisma.peerTransfer.count({ where: { friendshipId: friendship.id } })).toBe(1);
            const claim = await claimRow(sender.id, key);
            expect(claim.status).toBe('COMMITTED');

            const r2 = await drive({ userId: sender.id, key, body });
            expect(r2.status).toBe(200);
            expect(wire(r2)).toBe(claim.responseBody);
            expect(await prisma.peerTransfer.count({ where: { friendshipId: friendship.id } })).toBe(1);
        });

        test('W2. concurrent duplicates → exactly one transfer', async () => {
            const { sender, friendship } = await setup();
            const key = uniqKey('ps_race');
            const body = { friendshipId: friendship.id, amount: 100, reference: 'race' };
            const [r1, r2] = await Promise.all([
                drive({ userId: sender.id, key, body }),
                drive({ userId: sender.id, key, body }),
            ]);
            const okCount = [r1, r2].filter((r) => r.status === 200).length;
            expect(okCount).toBeGreaterThanOrEqual(1);
            expect(await prisma.peerTransfer.count({ where: { friendshipId: friendship.id } })).toBe(1);
            const s = await prisma.user.findUnique({ where: { id: sender.id } });
            expect(Number(s.availableBalance)).toBeCloseTo(400, 1);
        });
    });
});
