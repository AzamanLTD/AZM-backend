/**
 * §WP-H — PARKING A PAYOUT AND DISPATCHING IT ARE THE SAME DECISION.
 *
 * A pre-dispatch refusal parks the withdrawal by CAS-ing PENDING ->
 * NEEDS_MANUAL_REVIEW (src/services/nativeGhsWithdrawalService.js,
 * recordPreDispatchRefusal). The auto-payout worker claims the SAME row by CAS-ing
 * PENDING -> PROCESSING. Both are single-winner updates on one column, so the two
 * paths are not independent: whichever CAS lands first decides whether a provider
 * is called.
 *
 * Two failure modes are what this suite exists to exclude:
 *   - parked, then still dispatched   -> a human is told "review this" while money
 *                                        leaves through a provider anyway
 *   - dispatched, then parked over    -> an in-flight payout is re-labelled as
 *                                        never-dispatched, and an operator is sent
 *                                        to chase a transfer that IS in flight
 *
 * Coordination is deterministic: the park holds the row lock, the worker is
 * observed BLOCKED on it in pg_stat_activity, and only then does the park commit.
 * No arbitrary sleep decides the order.
 */
const { PrismaClient } = require('@prisma/client');
const PayoutBatchWorker = require('../workers/payoutBatchWorker');
const { recordPreDispatchRefusal } = require('../src/services/nativeGhsWithdrawalService');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const settings = {
    autoPayoutEnabled: true,
    autoPayoutMaxAmountUsdc: 200,
    autoPayoutThresholdUsdc: 500,
    autoPayoutIntervalMs: 120000,
};
const clients = () => new PrismaClient({ datasources: { db: { url: DB_URL } } });

describe('§WP-H park vs dispatch (real PostgreSQL, two backends)', () => {
    let admin;
    let parkClient;
    let workerClient;

    beforeAll(async () => {
        if (!DB_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');
        admin = clients(); parkClient = clients(); workerClient = clients();
        await Promise.all([admin.$connect(), parkClient.$connect(), workerClient.$connect()]);
        // Legacy regime: the authority decision itself is proved in
        // wp-h-payout-authority-race / -claim-authorisation. Here the only
        // question is which CAS on the withdrawal row wins.
        await admin.$executeRawUnsafe(`
            INSERT INTO "FiatLiquidityState" (id, "authorityActivatedAt", "updatedAt")
            VALUES (1, NULL, now())
            ON CONFLICT (id) DO UPDATE SET "authorityActivatedAt" = NULL, "updatedAt" = now()`);
        await admin.$executeRawUnsafe(`
            INSERT INTO "SystemFiatPool" (id, balance, "updatedAt")
            VALUES (1, 100000, now())
            ON CONFLICT (id) DO UPDATE SET balance = 100000, "updatedAt" = now()`);
    }, 40000);

    afterAll(async () => {
        await Promise.allSettled([admin.$disconnect(), parkClient.$disconnect(), workerClient.$disconnect()]);
    });

    async function seedWithdrawal() {
        await admin.$executeRawUnsafe(`DELETE FROM "Withdrawal" WHERE status IN ('PENDING','APPROVED')`);
        const user = await admin.user.create({
            data: { email: `wph-park-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
                username: `wphpark${Date.now()}${Math.floor(Math.random() * 1000)}`, password: 'x' },
            select: { id: true },
        });
        const tx = await admin.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_FIAT', status: 'PENDING', amountUsdc: 50,
                txHash: `wph-park-${Date.now()}-${Math.random().toString(36).slice(2)}` },
            select: { id: true, txHash: true },
        });
        const w = await admin.withdrawal.create({
            data: { userId: user.id, amount: 50, destination: '0244000002', network: 'MTN',
                payoutMethod: 'MTN_MOMO', status: 'PENDING', transactionHistoryId: tx.id },
            select: { id: true },
        });
        return { withdrawalId: w.id, reference: tx.txHash, userId: user.id };
    }

    /** Records the row's durable status at the instant provider I/O begins. */
    function recordingAdapter(calls) {
        return {
            initiateTransfer: async (req) => {
                const row = await admin.withdrawal.findUnique({
                    where: { id: req.__seedId }, select: { status: true },
                }).catch(() => null);
                calls.push({ amountGhs: req.amountGhs, referenceId: req.referenceId,
                    statusAtCall: row && row.status });
                return { _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED' };
            },
        };
    }

    /** Waits until some backend is blocked on a lock, i.e. the worker is queued. */
    async function waitForLockWaiter(timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const rows = await admin.$queryRawUnsafe(`
                SELECT pid, wait_event_type
                  FROM pg_stat_activity
                 WHERE datname = current_database()
                   AND wait_event_type = 'Lock'`);
            if (rows.length > 0) return rows;
            await new Promise((r) => setTimeout(r, 25));
        }
        return [];
    }

    test('a park that lands first blocks the dispatch: no provider call, row stays parked', async () => {
        const seed = await seedWithdrawal();
        const calls = [];
        const adapter = recordingAdapter(calls);

        // TWO distinct signals: the park announcing it HOLDS the row lock, and the
        // test permitting it to COMMIT. Collapsing them into one promise makes the
        // transaction await its own release and commit immediately, which silently
        // turns the race into a sequential test (that mistake was made and caught
        // here).
        let announceLockHeld;
        const rowLocked = new Promise((resolve) => { announceLockHeld = resolve; });
        let allowCommit;
        const mayCommit = new Promise((resolve) => { allowCommit = resolve; });

        const parkTx = parkClient.$transaction(async (tx) => {
            await tx.$queryRawUnsafe('SELECT id FROM "Withdrawal" WHERE id = $1 FOR UPDATE', seed.withdrawalId);
            announceLockHeld();
            await mayCommit;
            const held = await tx.withdrawal.updateMany({
                where: { id: seed.withdrawalId, status: 'PENDING' },
                data: { status: 'NEEDS_MANUAL_REVIEW' },
            });
            return held.count;
        }, { timeout: 30000 });

        await rowLocked;

        const worker = new PayoutBatchWorker(workerClient, { emit: () => {} }, adapter, null);
        const workerRun = worker._processBatch(settings, { isManualTrigger: true });

        // Deterministic: the worker must be OBSERVED blocked on the row lock.
        const waiters = await waitForLockWaiter();
        expect(waiters.length).toBeGreaterThan(0);

        // Now let the park commit.
        allowCommit();
        const parkCount = await parkTx;
        await workerRun;

        expect(parkCount).toBe(1);
        const row = await admin.withdrawal.findUnique({
            where: { id: seed.withdrawalId }, select: { status: true },
        });
        expect(row.status).toBe('NEEDS_MANUAL_REVIEW');
        // The decisive assertion: a parked payout is never dispatched.
        expect(calls).toHaveLength(0);
    }, 90000);

    test('a dispatch that lands first is not re-labelled by a later park', async () => {
        const seed = await seedWithdrawal();
        const calls = [];
        const adapter = {
            initiateTransfer: async (req) => {
                const row = await admin.withdrawal.findUnique({
                    where: { id: seed.withdrawalId }, select: { status: true },
                });
                calls.push({ statusAtCall: row.status, referenceId: req.referenceId });
                return { _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED' };
            },
        };

        const worker = new PayoutBatchWorker(workerClient, { emit: () => {} }, adapter, null);
        await worker._processBatch(settings, { isManualTrigger: true });
        expect(calls).toHaveLength(1);
        // Provider I/O only ever happens after the claim committed PROCESSING.
        expect(calls[0].statusAtCall).toBe('PROCESSING');

        // Now the park arrives late. Its CAS can only match PENDING, so it must
        // lose and must SAY it lost rather than reporting a hold it never took.
        const evidence = await recordPreDispatchRefusal(admin, {
            reference: seed.reference,
            rowId: (await admin.withdrawal.findUnique({
                where: { id: seed.withdrawalId }, select: { transactionHistoryId: true },
            })).transactionHistoryId,
            code: 'DESTINATION_NAME_MISMATCH',
            disposition: 'REFUSED_PRE_DISPATCH',
            hold: true,
        });

        // recordPreDispatchRefusal returns the durable hold verdict, not the
        // evidence object it writes.
        expect(evidence.held).toBe(false);
        expect(evidence.mirrorStatus).toBe('PROCESSING');

        const row = await admin.withdrawal.findUnique({
            where: { id: seed.withdrawalId }, select: { status: true },
        });
        // An in-flight payout is not silently re-labelled as never-dispatched.
        expect(row.status).toBe('PROCESSING');
        // And the late park did not cause a second provider call.
        expect(calls).toHaveLength(1);
    }, 90000);
});
