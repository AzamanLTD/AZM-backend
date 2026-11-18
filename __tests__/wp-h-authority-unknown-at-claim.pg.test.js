/**
 * §WP-H — AN UNPROVABLE AUTHORITY STATE MUST NOT DISPATCH.
 *
 * readMode() fails closed with a typed error rather than collapsing to "legacy
 * USDC" when the regime cannot be read (fiatLiquidityActivationService.js:111-124).
 * TWO codes exist for that refusal, depending on the regime:
 *   AUTHORITY_STATE_UNAVAILABLE — tri-state (authorityState.requireAuthorityState)
 *   AUTHORITY_MODE_UNKNOWN      — default regime (fiatLiquidityActivation.readMode)
 *
 * The worker handled only the first. In the default regime the second escaped
 * _processBatch entirely, so an unreadable read aborted the whole batch instead of
 * recording a refusal. That is what this suite pins: the batch parks, nothing is
 * claimed, no provider is called, and the row does not move.
 *
 * SCOPE, STATED HONESTLY: this injects an unreadable authority state for EVERY
 * read, so the refusal that fires is the worker's FIRST authority read (the
 * preflight in _processBatch). It does not isolate the claim transaction's own
 * read: readMode issues raw SQL there, so a Prisma-delegate proxy misses it, and a
 * jest spy on the service function is not reached because the worker holds that
 * reference from module load (both measured). The claim-boundary injection is
 * therefore still owed; what is proved here is that the unprovable-state refusal
 * can no longer escape the worker.
 */
const { PrismaClient } = require('@prisma/client');
const PayoutBatchWorker = require('../workers/payoutBatchWorker');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const hasDb = Boolean(DB_URL);
const run = hasDb ? describe : describe.skip;

const settings = {
    autoPayoutEnabled: true,
    autoPayoutMaxAmountUsdc: 200,
    autoPayoutThresholdUsdc: 500,
    autoPayoutIntervalMs: 120000,
};
const clients = () => new PrismaClient({ datasources: { db: { url: DB_URL } } });

/** Every authority read inside a transaction fails. */
function withUnreadableAuthority(client) {
    return new Proxy(client, {
        get(target, prop) {
            if (prop === '$transaction') {
                return async (fn, opts) => target.$transaction(
                    (tx) => fn(new Proxy(tx, {
                        get(t, p) {
                            if (p === 'fiatLiquidityState') {
                                return {
                                    findUnique: async () => {
                                        throw new Error('injected: authority state unreadable');
                                    },
                                };
                            }
                            const value = t[p];
                            return typeof value === 'function' ? value.bind(t) : value;
                        },
                    })),
                    opts,
                );
            }
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

run('§WP-H authority UNKNOWN (real PostgreSQL)', () => {
    let admin;
    let workerClient;

    beforeAll(async () => {
        admin = clients(); workerClient = clients();
        await Promise.all([admin.$connect(), workerClient.$connect()]);
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
        await Promise.allSettled([admin.$disconnect(), workerClient.$disconnect()]);
    });

    async function seedWithdrawal() {
        await admin.$executeRawUnsafe(`DELETE FROM "Withdrawal" WHERE status IN ('PENDING','APPROVED')`);
        const user = await admin.user.create({
            data: { email: `wph-unknown-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
                username: `wphunk${Date.now()}${Math.floor(Math.random() * 1000)}`, password: 'x' },
            select: { id: true },
        });
        const tx = await admin.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_FIAT', status: 'PENDING', amountUsdc: 50,
                txHash: `wph-unknown-${Date.now()}-${Math.random().toString(36).slice(2)}` },
            select: { id: true, txHash: true },
        });
        const w = await admin.withdrawal.create({
            data: { userId: user.id, amount: 50, destination: '0244000002', network: 'MTN',
                payoutMethod: 'MTN_MOMO', status: 'PENDING', transactionHistoryId: tx.id },
            select: { id: true },
        });
        return { withdrawalId: w.id, reference: tx.txHash };
    }

    test('an unreadable authority state parks the batch: no claim, no provider call', async () => {
        const seed = await seedWithdrawal();
        const calls = [];
        const adapter = {
            initiateTransfer: async (req) => {
                calls.push(req);
                return { _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED' };
            },
        };
        const worker = new PayoutBatchWorker(
            withUnreadableAuthority(workerClient), { emit: () => {} }, adapter, null,
        );

        // Before the fix this REJECTED: the typed refusal escaped the worker.
        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(calls).toHaveLength(0);
        const row = await admin.withdrawal.findUnique({
            where: { id: seed.withdrawalId }, select: { status: true },
        });
        expect(row.status).toBe('PENDING');
        expect(result.processed).toBe(0);

        // HONEST GAP, asserted rather than ignored: the refusal is CONTAINED (it no
        // longer escapes the batch) but it is not surfaced as a parked batch, so an
        // operator reading the run result sees a quiet no-op rather than
        // "authority unprovable". Asserting falsiness keeps that visible: when the
        // reporting is fixed this assertion must be inverted deliberately.
        expect(result.parked).toBeFalsy();
    }, 90000);
});
