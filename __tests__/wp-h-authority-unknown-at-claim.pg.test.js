/**
 * §WP-H — AN UNPROVABLE AUTHORITY STATE MUST NOT DISPATCH, AT THE CLAIM BOUNDARY.
 *
 * The worker resolves the regime twice: a preflight (isAuthorityModeActive, an
 * optimisation) and the read INSIDE the claim transaction (readMode at
 * payoutBatchWorker.js:663), which is the read that authorises provider I/O.
 * readMode fails closed with a typed error rather than collapsing to "legacy USDC"
 * when the regime cannot be read.
 *
 * Two typed refusals exist, one per regime, and both mean the same thing for money:
 *   AUTHORITY_MODE_UNKNOWN      — default regime (fiatLiquidityActivationService)
 *   AUTHORITY_STATE_UNAVAILABLE — tri-state (authorityState.requireAuthorityState)
 * The worker originally handled only the tri-state code, so in the default regime
 * the refusal ESCAPED _processBatch and aborted the whole batch.
 *
 * HOW THE CLAIM READ IS ISOLATED (this cost three attempts, recorded so it is not
 * rediscovered): a Prisma-delegate proxy cannot reach it, because readMode issues
 * raw SQL inside the transaction. A spy works only because the worker holds the
 * MODULE (`fiatLiquidityActivation.readMode`), so replacing the property is seen;
 * it must be installed on the same module instance the worker requires. Measured
 * call order for one batch: isAuthorityModeActive, isAuthorityModeActive, readMode
 * — readMode exactly once, and that call IS the claim transaction's read, so
 * spying it targets the claim boundary and leaves the preflight healthy.
 *
 * The run result nests the refusal under `details` (details.parked,
 * details.parkedReason, details.errors). Asserting the top-level shape was how an
 * earlier version of this file wrongly reported the refusal as unrecorded.
 */
const { PrismaClient } = require('@prisma/client');
const activation = require('../src/services/fiatLiquidityActivationService');
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

function failClaimAuthorityRead(code) {
    return jest.spyOn(activation, 'readMode').mockImplementation(async () => {
        const err = new Error(`[P5-D] injected: ${code}`);
        err.code = code;
        throw err;
    });
}

run('§WP-H authority UNKNOWN at the claim boundary (real PostgreSQL)', () => {
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
        // THE REGIME IS DECIDED HERE. With the authority flag ON, a reservation-less
        // legacy row parks at payoutBatchWorker.js:541 and the claim transaction is
        // never entered, so readMode is never called and an injection there would
        // prove nothing (measured: spy call count 0). Setting the flag OFF forces
        // the legacy path that DOES enter the claim transaction, which is the read
        // this suite targets. Asserting the call count keeps that honest.
        await admin.$executeRawUnsafe(`
            INSERT INTO "GlobalSettings" (id, "fiatLiquidityAuthorityEnabled", "updatedAt")
            VALUES (1, false, now())
            ON CONFLICT (id) DO UPDATE SET "fiatLiquidityAuthorityEnabled" = false, "updatedAt" = now()`);
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

    async function runBatchWithInjectedRefusal(code) {
        const seed = await seedWithdrawal();
        const calls = [];
        const adapter = {
            initiateTransfer: async (req) => {
                calls.push(req);
                return { _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED' };
            },
        };
        const spy = failClaimAuthorityRead(code);
        let result;
        let spyCalls;
        try {
            const worker = new PayoutBatchWorker(workerClient, { emit: () => {} }, adapter, null);
            result = await worker._processBatch(settings, { isManualTrigger: true });
        } finally {
            // Capture BEFORE restoring: mockRestore() resets the recorded call count,
            // so asserting after it always reads 0. That mistake made this suite
            // report "injection never reached" while the injection was working.
            spyCalls = spy.mock.calls.length;
            spy.mockRestore();
        }
        // The injection must have been REACHED, or this proves nothing. Exactly one
        // call also proves the target was the claim read, not the preflight.
        expect(spyCalls).toBe(1);
        const row = await admin.withdrawal.findUnique({
            where: { id: seed.withdrawalId }, select: { status: true },
        });
        return { calls, result, row, seed };
    }

    test('default-regime refusal (AUTHORITY_MODE_UNKNOWN) parks: no claim, no provider call', async () => {
        const { calls, result, row } = await runBatchWithInjectedRefusal('AUTHORITY_MODE_UNKNOWN');

        expect(calls).toHaveLength(0);
        expect(row.status).toBe('PENDING');
        expect(result.details.parked).toBe(true);
        expect(result.details.parkedReason).toBe('AUTHORITY_MODE_UNKNOWN');
        expect(result.details.errors.map((e) => e.reason)).toContain('AUTHORITY_MODE_UNKNOWN');
        expect(result.dispatched ?? 0).toBe(0);
    }, 90000);

    test('tri-state refusal (AUTHORITY_STATE_UNAVAILABLE) parks identically', async () => {
        const { calls, result, row } = await runBatchWithInjectedRefusal('AUTHORITY_STATE_UNAVAILABLE');

        expect(calls).toHaveLength(0);
        expect(row.status).toBe('PENDING');
        expect(result.details.parked).toBe(true);
        expect(result.details.parkedReason).toBe('AUTHORITY_STATE_UNAVAILABLE');
    }, 90000);

    test('an ordinary claim error is NOT swallowed by the authority predicate', async () => {
        // The predicate must recognise two specific codes, not "anything thrown".
        // If it caught everything, a real bug would look like an unprovable
        // authority and the withdrawal would sit unexamined forever.
        await seedWithdrawal();
        const spy = jest.spyOn(activation, 'readMode').mockImplementation(async () => {
            const err = new Error('injected: a genuine, unrelated claim failure');
            err.code = 'SOME_REAL_BUG';
            throw err;
        });
        try {
            const worker = new PayoutBatchWorker(
                workerClient, { emit: () => {} }, { initiateTransfer: async () => ({ status: 'ACCEPTED' }) }, null,
            );
            await expect(worker._processBatch(settings, { isManualTrigger: true }))
                .rejects.toThrow(/genuine, unrelated claim failure/);
        } finally {
            spy.mockRestore();
        }
    }, 90000);
});
