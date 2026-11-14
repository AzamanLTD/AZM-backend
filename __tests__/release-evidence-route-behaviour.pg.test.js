// __tests__/release-evidence-route-behaviour.pg.test.js
// =============================================================================
// ROUTE-LEVEL RECOVERY EVIDENCE FOR THE TWO REMAINING RELEASE MOUNTS
//
// The release registry declares POST /api/friends/transfer/send and
// POST /api/withdraw/ghs as RELEASE-on-5xx with an atomic claim+commit. That
// claim was supported only by the static commit-site proof plus a behaviour
// test that was not itself a replay test. This suite closes the gap with the
// three properties the release policy actually promises, per route, on the
// real disposable PostgreSQL harness:
//
//   1. same-key replay cannot repeat the economic operation (byte-identical
//      replay of the COMMITTED wire body, one movement, one provider call);
//   2. concurrent duplicates cannot produce a second movement;
//   3. a committed operation stays committed across a post-commit failure and
//      a same-key retry replays it instead of re-executing.
//
// Each route is driven through its REAL Express router, REAL auth/2FA and REAL
// shared idempotency middleware over HTTP; only the provider port is a fake.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[release-evidence-route-behaviour] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    process.env.GHS_RISK_AMOUNT_POLICY = '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
}

(hasDb ? describe : describe.skip)('release-mount route behaviour (real PostgreSQL)', () => {
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    const SUITE_POLICY = '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
    const RATE = 12.5;
    const DEST = '233241234567';

    let prisma;
    let seedUser;
    let seedFriendship;
    let TEST_PASSWORD;

    const tokenFor = (user) => jwt.sign({ id: user.id, role: user.role || 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const buildApp = ({ emitBalanceUpdate = () => {}, dispatcher = null } = {}) => {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', emitBalanceUpdate);
        app.set('io', null);
        app.set('socketio', null);
        if (dispatcher) app.set('paymentFailoverService', dispatcher);
        app.use((req, _res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/friends', require('../routes/friendRoutes'));
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        return app;
    };

    const uniqKey = (tag) => `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

    const claimRow = async (userId, key) => {
        const rows = await prisma.financialOperation.findMany({ where: { userId, key }, orderBy: { id: 'desc' } });
        return rows[0] || null;
    };
    const waitForClaim = async (userId, key, want = 'COMMITTED', timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const rows = await prisma.financialOperation.findMany({ where: { userId, key }, orderBy: { id: 'desc' } });
            if (rows.some((r) => r.status === want) || Date.now() > deadline) return rows;
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, seedFriendship, TEST_PASSWORD } = require('./helpers/factories'));
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    beforeEach(() => { process.env.GHS_RISK_AMOUNT_POLICY = SUITE_POLICY; });
    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "PeerTransfer", "Friendship", "TransactionHistory", "Withdrawal", '
            + '"FinancialOperation", "LedgerTransaction", "LedgerAccount", "JournalEntry", '
            + '"GlobalSettings", "FiatLiquidityState", "FiatLiquidityReservation" RESTART IDENTITY CASCADE'
        ).catch(() => {});
    });

    // ══════════════════════════════════════════════════════════════════════
    // §A — POST /api/friends/transfer/send  (RELEASE on 5xx)
    // ══════════════════════════════════════════════════════════════════════
    describe('§A POST /api/friends/transfer/send', () => {
        const setup = async () => {
            const sender = await seedUser(prisma, { availableBalance: 500 });
            const receiver = await seedUser(prisma, { availableBalance: 0 });
            const friendship = await seedFriendship(prisma, sender.id, receiver.id);
            return { sender, receiver, friendship };
        };
        const send = (app, user, key, body) => request(app)
            .post('/api/friends/transfer/send')
            .set('Authorization', `Bearer ${tokenFor(user)}`)
            .set('Idempotency-Key', key)
            .send({ password: TEST_PASSWORD, ...body });

        const economics = async (senderId, receiverId, friendshipId) => {
            const sender = await prisma.user.findUnique({ where: { id: senderId }, select: { availableBalance: true } });
            const receiver = await prisma.user.findUnique({ where: { id: receiverId }, select: { availableBalance: true } });
            // One movement writes one row per side; the sender side is the
            // economic operation being counted.
            const movements = await prisma.transactionHistory.count({
                where: { userId: senderId, type: 'INTERNAL_TRANSFER' },
            });
            return {
                sender: new Prisma.Decimal(sender.availableBalance).toFixed(8),
                receiver: new Prisma.Decimal(receiver.availableBalance).toFixed(8),
                movements,
                transfers: await prisma.peerTransfer.count({ where: { friendshipId } }),
            };
        };

        test('A1. same-key replay cannot repeat the economic operation', async () => {
            const { sender, receiver, friendship } = await setup();
            const app = buildApp();
            const key = uniqKey('peer');
            const body = { friendshipId: friendship.id, amount: 100, reference: 'replay-proof' };

            const first = await send(app, sender, key, body);
            expect(first.status).toBe(200);
            expect(first.body.success).toBe(true);
            const afterFirst = await economics(sender.id, receiver.id, friendship.id);
            expect(afterFirst.transfers).toBe(1);

            const claim = await claimRow(sender.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);

            const second = await send(app, sender, key, body);
            expect(second.status).toBe(200);
            // Byte-identical replay of the committed wire result.
            expect(JSON.stringify(second.body)).toBe(claim.responseBody);
            expect(await economics(sender.id, receiver.id, friendship.id)).toEqual(afterFirst);
        });

        test('A2. concurrent duplicates cannot produce a second movement', async () => {
            const { sender, receiver, friendship } = await setup();
            const app = buildApp();
            const key = uniqKey('peer');
            const body = { friendshipId: friendship.id, amount: 100, reference: 'concurrent-proof' };

            const [a, b] = await Promise.all([
                send(app, sender, key, body),
                send(app, sender, key, body),
            ]);
            const statuses = [a.status, b.status].sort();
            expect(statuses[0]).toBe(200);
            // The duplicate either replays (200) or is refused while the claim
            // is IN_PROGRESS (409) — never a second movement.
            expect([200, 409]).toContain(statuses[1]);

            await waitForClaim(sender.id, key);
            const economicsAfter = await economics(sender.id, receiver.id, friendship.id);
            expect(economicsAfter.transfers).toBe(1);
            expect(economicsAfter.movements).toBe(1);
            expect(economicsAfter.sender).toBe('400.00000000');
            expect(economicsAfter.receiver).toBe('100.00000000');
        });

        test('A3. a committed operation stays committed across a post-commit failure', async () => {
            const { sender, receiver, friendship } = await setup();
            // The balance-update emit runs AFTER the money transaction commits.
            // Making it throw tests exactly the window the policy is about: the
            // claim must already be durable, with the wire body.
            const app = buildApp({ emitBalanceUpdate: () => { throw new Error('socket unavailable'); } });
            const key = uniqKey('peer');
            const body = { friendshipId: friendship.id, amount: 25, reference: 'post-commit-proof' };

            const failed = await send(app, sender, key, body);
            expect(failed.status).toBeGreaterThanOrEqual(500);

            const claim = await waitForClaim(sender.id, key).then((rows) => rows[0]);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(200);
            const committed = JSON.parse(claim.responseBody);
            expect(committed.success).toBe(true);

            const afterFailure = await economics(sender.id, receiver.id, friendship.id);
            expect(afterFailure.transfers).toBe(1);

            // Recovery: the same key replays the committed result; money moves once.
            const healthy = buildApp();
            const retry = await send(healthy, sender, key, body);
            expect(retry.status).toBe(200);
            expect(JSON.stringify(retry.body)).toBe(claim.responseBody);
            expect(await economics(sender.id, receiver.id, friendship.id)).toEqual(afterFailure);
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // §B — POST /api/withdraw/ghs  (RELEASE on 5xx)
    // ══════════════════════════════════════════════════════════════════════
    describe('§B POST /api/withdraw/ghs', () => {
        const setSettings = async (extra = {}) => {
            const data = {
                liveRetailRate: RATE, liveUsdToGhs: RATE, liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(), lastRateSync: new Date(),
                fiatLiquidityAuthorityEnabled: true,
                modelBSettlementEnabled: false, nativeGhsSettlementEnabled: false,
                nativeGhsWithdrawalEnabled: true,
                autoPayoutEnabled: true, autoPayoutMaxAmountUsdc: 200, autoPayoutThresholdUsdc: 100,
                ...extra,
            };
            await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
            await prisma.fiatLiquidityState.upsert({
                where: { id: 1 },
                update: { availableGhs: 500000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
                create: { id: 1, availableGhs: 500000 },
            });
        };

        const dispatcherFake = ({ fail = false } = {}) => ({
            initiateTransfer: jest.fn(async () => {
                if (fail) throw new Error('provider transport failure');
                return { success: true, transactionId: `MOO-${randomUUID()}`, _provider: 'mtn', status: 'ACCEPTED' };
            }),
        });

        const ghsPost = (app, user, key, body = {}) => request(app)
            .post('/api/withdraw/ghs')
            .set('Authorization', `Bearer ${tokenFor(user)}`)
            .set('Idempotency-Key', key)
            .send({ password: TEST_PASSWORD, destination: DEST, network: 'MTN', ...body });

        const economics = async (userId) => {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { nativeGhsBalance: true, availableBalance: true },
            });
            return {
                nativeGhs: new Prisma.Decimal(user.nativeGhsBalance).toFixed(2),
                available: new Prisma.Decimal(user.availableBalance).toFixed(8),
                withdrawals: await prisma.withdrawal.count({ where: { userId } }),
                history: await prisma.transactionHistory.count({
                    where: { userId, type: 'WITHDRAWAL_FIAT' },
                }),
            };
        };

        // The dispatch leg moves the reserved GHS RESERVED → IN_TRANSIT after
        // the response, so the per-state split is not stable evidence. What
        // must never change is the TOTAL held for this payout.
        const heldGhs = async () => {
            const state = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
            return new Prisma.Decimal(state.reservedGhs).plus(new Prisma.Decimal(state.inTransitGhs)).toFixed(2);
        };

        test('B1. same-key replay cannot repeat the economic operation', async () => {
            await setSettings();
            const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
            const dispatcher = dispatcherFake();
            const app = buildApp({ dispatcher });
            const key = uniqKey('ghs');
            const body = { amountGhs: '50.00' };

            const first = await ghsPost(app, user, key, body);
            expect(first.status).toBe(202);
            expect(first.body.success).toBe(true);
            const afterFirst = await economics(user.id);
            expect(afterFirst.withdrawals).toBe(1);

            const claim = await claimRow(user.id, key);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(202);

            const second = await ghsPost(app, user, key, body);
            expect(second.status).toBe(202);
            expect(JSON.stringify(second.body)).toBe(claim.responseBody);
            expect(await economics(user.id)).toEqual(afterFirst);
            expect(await heldGhs()).toBe('50.00');
            // The provider saw exactly one payout instruction.
            expect(dispatcher.initiateTransfer).toHaveBeenCalledTimes(1);
        });

        test('B2. concurrent duplicates cannot produce a second movement', async () => {
            await setSettings();
            const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
            const dispatcher = dispatcherFake();
            const app = buildApp({ dispatcher });
            const key = uniqKey('ghs');
            const body = { amountGhs: '50.00' };

            const [a, b] = await Promise.all([ghsPost(app, user, key, body), ghsPost(app, user, key, body)]);
            const statuses = [a.status, b.status].sort((x, y) => x - y);
            expect(statuses[0]).toBe(202);
            expect([202, 409]).toContain(statuses[1]);

            await waitForClaim(user.id, key);
            const after = await economics(user.id);
            expect(after.withdrawals).toBe(1);
            expect(after.history).toBe(1);
            expect(dispatcher.initiateTransfer.mock.calls.length).toBeLessThanOrEqual(1);
        });

        test('B3. a committed operation stays committed across a post-commit provider failure', async () => {
            await setSettings();
            const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
            const dispatcher = dispatcherFake({ fail: true });
            const app = buildApp({ dispatcher });
            const key = uniqKey('ghs');
            const body = { amountGhs: '50.00' };

            const res = await ghsPost(app, user, key, body);
            // Acceptance is committed before dispatch is attempted.
            expect(res.status).toBe(202);

            const claim = await waitForClaim(user.id, key).then((rows) => rows[0]);
            expect(claim.status).toBe('COMMITTED');
            expect(claim.statusCode).toBe(202);
            const afterFailure = await economics(user.id);
            expect(afterFailure.withdrawals).toBe(1);

            // A same-key retry replays the committed acceptance and never
            // re-executes the debit or a second payout attempt.
            const retry = await ghsPost(buildApp({ dispatcher }), user, key, body);
            expect(retry.status).toBe(202);
            expect(JSON.stringify(retry.body)).toBe(claim.responseBody);
            expect(await economics(user.id)).toEqual(afterFailure);
            expect(await heldGhs()).toBe('50.00');
            expect(dispatcher.initiateTransfer).toHaveBeenCalledTimes(1);
        });
    });
});
