// __tests__/azm-idempotency-concurrency.test.js
// =============================================================================
// AZM ledger idempotency — real-PostgreSQL concurrency tests
//
// The P0 defect: creditAzm()/_debitAzmWithClient() relied on a read-then-write
// JSON-metadata pre-check with NO database-level uniqueness on the dedup
// identity, so two concurrent identical requests could both miss the pre-check
// and BOTH mutate User.azmBalance. The fix: dedicated `dedupKey` column +
// @@unique([userId, source, dedupKey]) on AzmRewardLog and AzmSpendLog, with
// the service layer converging unique-conflicts to the existing idempotent
// result semantics.
//
// These tests fire REAL concurrent Promise.all() calls against real PostgreSQL
// (the CI Postgres service) and assert row counts and final balances from the
// DB — not mocks. SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedAzmBalance } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[azm-idempotency] TEST_DATABASE_URL not set — skipping.');

function makeIo() {
    const emissions = [];
    const io = {
        to: (room) => ({
            emit: (event, payload) => emissions.push({ room, event, payload })
        })
    };
    return { io, emissions };
}

// A metadata object whose spread (inside the transaction, AFTER the balance
// mutation) throws — forcing a post-mutation transaction failure without
// touching service internals or DB fixtures.
function poisonedMetadata() {
    const m = {};
    Object.defineProperty(m, 'boom', {
        enumerable: true,
        get() { throw new Error('boom after balance mutation'); }
    });
    return m;
}

describeOrSkip('AZM ledger idempotency (real concurrency)', () => {
    let prisma, AzmRewardService, AzmSpendService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV     = 'test';
        process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient }   = require('@prisma/client');
        prisma            = new PrismaClient();
        AzmRewardService  = require('../services/azmRewardService').AzmRewardService;
        AzmSpendService   = require('../services/azmSpendService').AzmSpendService;
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User","AzmRewardLog","AzmSpendLog","TransactionHistory" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    const creditArgs = (userId, key) => ({
        userId,
        amount: 5,
        source: 'TRADE_COMPLETE',
        reason: 'concurrent test credit',
        metadata: { tradeId: 1234 },
        dedupKey: key
    });

    const debitArgs = (userId, key) => ({
        userId,
        amount: 30,
        source: 'FEE_DISCOUNT',
        reason: 'concurrent test debit',
        metadata: { tierId: 'tier_25' },
        dedupKey: key
    });

    const balance = async (userId) =>
        Number((await prisma.user.findUnique({ where: { id: userId }, select: { azmBalance: true } })).azmBalance);

    // ── 1. Concurrent identical creditAzm ─────────────────────────────────────
    test('1: two concurrent identical creditAzm calls credit exactly once, log once, emit once', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 100);
        const { io, emissions } = makeIo();
        const svc = new AzmRewardService(prisma, io);

        const [a, b] = await Promise.all([
            svc.creditAzm(creditArgs(userId, 'trade_1234')),
            svc.creditAzm(creditArgs(userId, 'trade_1234'))
        ]);

        const results = [a, b];
        expect(results.filter(r => r.credited)).toHaveLength(1);
        expect(results.filter(r => !r.credited)).toHaveLength(1);

        // Loser converges to the winner's idempotent result (same logId).
        const winner = results.find(r => r.credited);
        const loser  = results.find(r => !r.credited);
        expect(loser.logId).toBe(winner.logId);
        expect(Number(loser.newBalance)).toBe(Number(winner.newBalance));

        // DB truth: exactly one reward log, balance increased exactly once.
        const logs = await prisma.azmRewardLog.findMany({ where: { userId, source: 'TRADE_COMPLETE' } });
        expect(logs).toHaveLength(1);
        expect(await balance(userId)).toBe(105);

        // Exactly one socket emission (winner only — never a losing/replay call).
        expect(emissions).toHaveLength(1);
        expect(emissions[0].event).toBe('azm_reward');
    }, 30000);

    // ── 2. Concurrent identical debitAzm ──────────────────────────────────────
    test('2: two concurrent identical debitAzm calls debit exactly once, log once, emit once', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 100);
        const { io, emissions } = makeIo();
        const svc = new AzmSpendService(prisma, io);

        const results = await Promise.all([
            svc.debitAzm(debitArgs(userId, 'fee_discount_W-1')),
            svc.debitAzm(debitArgs(userId, 'fee_discount_W-1'))
        ]);

        expect(results.filter(r => r.debited)).toHaveLength(1);
        expect(results.filter(r => !r.debited)).toHaveLength(1);

        const winner = results.find(r => r.debited);
        const loser  = results.find(r => !r.debited);
        expect(loser.logId).toBe(winner.logId);
        expect(Number(loser.newBalance)).toBe(Number(winner.newBalance));

        const logs = await prisma.azmSpendLog.findMany({ where: { userId, source: 'FEE_DISCOUNT' } });
        expect(logs).toHaveLength(1);
        expect(await balance(userId)).toBe(70);

        expect(emissions).toHaveLength(1);
        expect(emissions[0].event).toBe('azm_spend');
    }, 30000);

    // ── 3. Sequential replay after commit (credit) ────────────────────────────
    test('3: creditAzm replay after commit returns the existing idempotent result', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 100);
        const { io, emissions } = makeIo();
        const svc = new AzmRewardService(prisma, io);

        const first = await svc.creditAzm(creditArgs(userId, 'trade_5678'));
        expect(first.credited).toBe(true);

        const replay = await svc.creditAzm(creditArgs(userId, 'trade_5678'));
        expect(replay.credited).toBe(false);
        expect(replay.logId).toBe(first.logId);
        expect(Number(replay.newBalance)).toBe(Number(first.newBalance));

        expect(await prisma.azmRewardLog.count({ where: { userId, source: 'TRADE_COMPLETE' } })).toBe(1);
        expect(await balance(userId)).toBe(105);
        expect(emissions).toHaveLength(1);
    }, 30000);

    // ── 4. Sequential replay after commit (spend) ─────────────────────────────
    test('4: debitAzm replay after commit returns the existing idempotent result', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 100);
        const { io, emissions } = makeIo();
        const svc = new AzmSpendService(prisma, io);

        const first = await svc.debitAzm(debitArgs(userId, 'fee_discount_W-2'));
        expect(first.debited).toBe(true);

        const replay = await svc.debitAzm(debitArgs(userId, 'fee_discount_W-2'));
        expect(replay.debited).toBe(false);
        expect(replay.logId).toBe(first.logId);

        expect(await prisma.azmSpendLog.count({ where: { userId, source: 'FEE_DISCOUNT' } })).toBe(1);
        expect(await balance(userId)).toBe(70);
        expect(emissions).toHaveLength(1);
    }, 30000);

    // ── 5. Same dedup key, different users ────────────────────────────────────
    test('5: same dedupKey for different users credits both independently', async () => {
        const u1 = await seedAzmBalance(prisma, 100);
        const u2 = await seedAzmBalance(prisma, 200);
        const svc = new AzmRewardService(prisma, makeIo().io);

        const [r1, r2] = await Promise.all([
            svc.creditAzm(creditArgs(u1.id, 'trade_shared')),
            svc.creditAzm(creditArgs(u2.id, 'trade_shared'))
        ]);

        expect(r1.credited).toBe(true);
        expect(r2.credited).toBe(true);
        expect(r1.logId).not.toBe(r2.logId);
        expect(await balance(u1.id)).toBe(105);
        expect(await balance(u2.id)).toBe(205);
    }, 30000);

    // ── 6. Same user, different dedup keys ────────────────────────────────────
    test('6: same user with different dedupKeys credits both independently', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 100);
        const svc = new AzmRewardService(prisma, makeIo().io);

        const [r1, r2] = await Promise.all([
            svc.creditAzm(creditArgs(userId, 'trade_a')),
            svc.creditAzm(creditArgs(userId, 'trade_b'))
        ]);

        expect(r1.credited).toBe(true);
        expect(r2.credited).toBe(true);
        expect(r1.logId).not.toBe(r2.logId);
        expect(await balance(userId)).toBe(110);
    }, 30000);

    // ── 7. Post-mutation transaction failure rolls back the credit ─────────────
    test('7: a transaction failing after the balance mutation rolls back — no orphaned dedup claim (credit)', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 100);
        const svc = new AzmRewardService(prisma, makeIo().io);

        // creditAzm is fire-and-forget: the post-mutation failure is caught and
        // swallowed (credited:false), but the TRANSACTION must have rolled back.
        const failed = await svc.creditAzm({
            ...creditArgs(userId, 'trade_boom'),
            metadata: poisonedMetadata()
        });
        expect(failed.credited).toBe(false);
        expect(failed.logId).toBe(null);

        // Nothing committed: balance unchanged, no log row, no dedup claim.
        expect(await balance(userId)).toBe(100);
        expect(await prisma.azmRewardLog.count({ where: { userId } })).toBe(1); // the seed backing row only
        expect(await prisma.azmRewardLog.count({ where: { dedupKey: 'trade_boom' } })).toBe(0);

        // No orphaned claim: the same dedupKey still credits successfully.
        const retry = await svc.creditAzm(creditArgs(userId, 'trade_boom'));
        expect(retry.credited).toBe(true);
        expect(await balance(userId)).toBe(105);
    }, 30000);

    // ── 8. Post-mutation transaction failure rolls back the debit ───────────────
    test('8: a transaction failing after the balance mutation rolls back — no orphaned dedup claim (debit)', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 100);
        const svc = new AzmSpendService(prisma, makeIo().io);

        await expect(svc.debitAzm({
            ...debitArgs(userId, 'fee_discount_boom'),
            metadata: poisonedMetadata()
        })).rejects.toThrow('boom after balance mutation');

        expect(await balance(userId)).toBe(100);
        expect(await prisma.azmSpendLog.count({ where: { dedupKey: 'fee_discount_boom' } })).toBe(0);

        const retry = await svc.debitAzm(debitArgs(userId, 'fee_discount_boom'));
        expect(retry.debited).toBe(true);
        expect(await balance(userId)).toBe(70);
    }, 30000);
});
