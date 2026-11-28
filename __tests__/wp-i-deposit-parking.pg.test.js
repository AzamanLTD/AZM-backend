// __tests__/wp-i-deposit-parking.pg.test.js
// =============================================================================
// §WP-I §6 — A STUCK DEPOSIT IS PARKED, NOT RE-ASKED EVERY 60 SECONDS
//
// Real PostgreSQL for every piece of durable state; the provider call itself is
// mocked so each outcome is deterministic and no live Moolre request is made.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[wp-i-deposit-parking] TEST_DATABASE_URL not set — skipping.');

jest.mock('../src/services/moolreCollectionRecoveryService', () => ({
    resolvePendingDeposit: jest.fn(),
}));

describeOrSkip('WP-I deposit parking and backoff (real PostgreSQL, stubbed provider)', () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    const { PrismaClient } = require('@prisma/client');
    const { resolvePendingDeposit } = require('../src/services/moolreCollectionRecoveryService');
    const Worker = require('../workers/depositReconciliationWorker');
    const parking = require('../src/services/depositReconciliationParking');

    let prisma;
    let userId;
    const tag = `park-${Date.now()}`;

    async function deposit(suffix) {
        const row = await prisma.transactionHistory.create({
            data: {
                userId, type: 'DEPOSIT_FIAT', status: 'PENDING', amountGhs: 12, amountUsdc: 12,
                txHash: `${tag}-${suffix}`,
                metadata: { selectedRoute: 'MOOLRE_MOMO_COLLECTION' },
            },
        });
        await prisma.$executeRawUnsafe(
            `UPDATE "TransactionHistory" SET "createdAt" = now() - interval '10 minutes' WHERE "id" = $1`,
            String(row.id),
        );
        return row.id;
    }

    // The worker's real scan is global. A test that lets it touch other suites'
    // deposits would park rows it does not own, so the scan is scoped to this
    // suite's tag through a proxy. Everything else is the real client.
    function scoped(client, prefix) {
        return new Proxy(client, {
            get(target, prop) {
                if (prop === 'transactionHistory') {
                    return new Proxy(target.transactionHistory, {
                        get(tt, m) {
                            if (m === 'findMany') {
                                return (args = {}) => tt.findMany({ ...args, where: { ...(args.where || {}), txHash: { startsWith: prefix } } });
                            }
                            const v = tt[m];
                            return typeof v === 'function' ? v.bind(tt) : v;
                        },
                    });
                }
                const v = target[prop];
                return typeof v === 'function' ? v.bind(target) : v;
            },
        });
    }

    const worker = () => new Worker(scoped(prisma, tag), { fake: true }, null);

    beforeAll(async () => {
        prisma = new PrismaClient();
        await prisma.$connect();
        const u = await prisma.user.create({
            data: { username: tag, email: `${tag}@example.invalid`, password: 'not-a-real-hash' },
        });
        userId = u.id;
    });

    beforeEach(() => { resolvePendingDeposit.mockReset(); });

    afterAll(async () => {
        if (!prisma) return;
        try {
            await prisma.$executeRawUnsafe('DELETE FROM "ReconciliationException" WHERE "entityId" IN (SELECT "id"::text FROM "TransactionHistory" WHERE "txHash" LIKE $1)', `${tag}-%`);
            await prisma.$executeRawUnsafe('DELETE FROM "TransactionHistory" WHERE "txHash" LIKE $1', `${tag}-%`);
            await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "username" = $1', tag);
        } catch (err) { /* best effort */ }
        await prisma.$disconnect();
    });

    test('a deposit already parked is not asked again, and stays PENDING', async () => {
        const id = await deposit('parked');
        await parking.recordAttempt(prisma, { transactionHistoryId: id, outcome: 'CONTRADICTORY_EVIDENCE', reason: 'contradiction', park: true });
        resolvePendingDeposit.mockResolvedValue({ outcome: 'SETTLED', result: {} });

        await worker()._tick();

        expect(resolvePendingDeposit).not.toHaveBeenCalled();
        const row = await prisma.transactionHistory.findUnique({ where: { id } });
        expect(row.status).toBe('PENDING');
    }, 60000);

    test('an unknown provider outcome schedules a durable backoff that survives a restart', async () => {
        const id = await deposit('backoff');
        resolvePendingDeposit.mockResolvedValue({ outcome: 'STATUS_UNAVAILABLE', reason: 'TIMEOUT' });

        await worker()._tick();
        expect(resolvePendingDeposit).toHaveBeenCalledTimes(1);
        const state = await parking.readParking(prisma, id);
        expect(state.attempts).toBe(1);
        expect(state.blocked).toBe(true);
        expect(state.parked).toBe(false);

        // A NEW worker instance is a restart: the schedule must come from the
        // database, not from process memory.
        resolvePendingDeposit.mockClear();
        await worker()._tick();
        expect(resolvePendingDeposit).not.toHaveBeenCalled();
    }, 60000);

    test('after the retry policy the deposit is parked, never marked FAILED', async () => {
        const id = await deposit('exhausted');
        resolvePendingDeposit.mockResolvedValue({ outcome: 'STILL_PENDING' });
        for (let i = 0; i < parking.MAX_ATTEMPTS; i += 1) {
            await parking.recordAttempt(prisma, { transactionHistoryId: id, outcome: 'STILL_PENDING' });
        }
        const state = await parking.readParking(prisma, id);
        expect(state.parked).toBe(true);
        expect(state.nextAttemptAt).toBeNull();

        resolvePendingDeposit.mockClear();
        await worker()._tick();
        expect(resolvePendingDeposit).not.toHaveBeenCalled();
        const row = await prisma.transactionHistory.findUnique({ where: { id } });
        expect(row.status).toBe('PENDING');
    }, 60000);

    test('contradictory evidence parks immediately with no failure notification', async () => {
        const id = await deposit('contradiction');
        resolvePendingDeposit.mockResolvedValue({ outcome: 'CONTRADICTORY_EVIDENCE', reason: 'two events disagree' });
        const notify = { sendNotification: jest.fn() };
        await new Worker(scoped(prisma, tag), { fake: true }, notify)._tick();

        const state = await parking.readParking(prisma, id);
        expect(state.parked).toBe(true);
        expect(state.parkedReason).toBe('DEPOSIT_RECONCILIATION_PARKED');
        expect(notify.sendNotification).not.toHaveBeenCalled();
        const row = await prisma.transactionHistory.findUnique({ where: { id } });
        expect(row.status).toBe('PENDING');
        expect(String(row.amountGhs)).toBe('12');
    }, 60000);

    test('a settled outcome leaves no parking case behind', async () => {
        const id = await deposit('settled');
        resolvePendingDeposit.mockResolvedValue({ outcome: 'SETTLED', result: {} });
        await worker()._tick();
        const state = await parking.readParking(prisma, id);
        expect(state.attempts).toBe(0);
        expect(state.blocked).toBe(false);
    }, 60000);

    test('a required case write that cannot be committed is a hard failure', async () => {
        const blind = {
            $queryRawUnsafe: async () => [{ t: null }],
            $executeRawUnsafe: async () => { throw new Error('must not be reached'); },
        };
        await expect(parking.recordAttempt(blind, { transactionHistoryId: 'x', outcome: 'STILL_PENDING' }))
            .rejects.toMatchObject({ code: 'DEPOSIT_PARKING_CASE_TABLE_MISSING' });
    }, 30000);
});
