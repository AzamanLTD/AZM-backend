/**
 * §WP-H — THE CLAIM IS A SINGLE-WINNER DECISION.
 *
 * The claim transaction re-reads everything under the canonical SHARED authority
 * lock and then does one conditional update. Shared locks do not exclude each
 * other, so two workers CAN both be inside their claim transactions at once —
 * the CAS is what makes exactly one of them the winner. That is a real
 * concurrency property of the code, not of the test, so it is exercised with two
 * independent Prisma clients (separate backends) racing the same row.
 *
 * Every assertion here is about money: at most one provider call, the exact
 * reserved amount paid rather than a recomputed one, and no provider I/O before
 * the claim has committed.
 */
const { PrismaClient } = require('@prisma/client');
const PayoutBatchWorker = require('../workers/payoutBatchWorker');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const settings = {
    autoPayoutEnabled: true,
    autoPayoutMaxAmountUsdc: 200,
    autoPayoutThresholdUsdc: 500,
    autoPayoutIntervalMs: 120000,
};

const clients = () => new PrismaClient({ datasources: { db: { url: DB_URL } } });

/**
 * A client whose PREFLIGHT reads can be served stale values while the
 * transaction client stays the real database. Bound methods, so the delegate
 * never resolves to the wrapper itself.
 */
function withScanOverride(client, override) {
    return new Proxy(client, {
        get(target, prop) {
            if (Object.prototype.hasOwnProperty.call(override, prop)) return override[prop];
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

describe('§WP-H payout claim races (real PostgreSQL, two backends)', () => {
    let admin;
    let a;
    let b;

    beforeAll(async () => {
        if (!DB_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');
        admin = clients(); a = clients(); b = clients();
        await Promise.all([admin.$connect(), a.$connect(), b.$connect()]);
        // Legacy regime for these races: the authority decision is proved in
        // wp-h-payout-authority-race / -claim-authorisation. Here the question is
        // which worker wins the CAS.
        await admin.$executeRawUnsafe(`
            INSERT INTO "FiatLiquidityState" (id, "authorityActivatedAt", "updatedAt")
            VALUES (1, NULL, now())
            ON CONFLICT (id) DO UPDATE SET "authorityActivatedAt" = NULL, "updatedAt" = now()`);
        // The regime is a LATCH over two independent signals — `active` is
        // (GlobalSettings.fiatLiquidityAuthorityEnabled || FiatLiquidityState.
        // authorityActivatedAt != null) — and both suites must own BOTH halves.
        // Clearing only the timestamp left this suite reading whatever flag an
        // earlier suite in the same database had set, so under the full CI battery
        // the legacy rows parked as LEGACY_ROW_UNDER_AUTHORITY_REGIME and the
        // provider was never called (observed: expected 1 dispatch, got 0). That
        // was ambient state, not a defect in the code under test; the suite now
        // sets the regime it means to exercise.
        await admin.$executeRawUnsafe(`
            INSERT INTO "GlobalSettings" (id, "fiatLiquidityAuthorityEnabled", "updatedAt")
            VALUES (1, false, now())
            ON CONFLICT (id) DO UPDATE SET "fiatLiquidityAuthorityEnabled" = false, "updatedAt" = now()`);
        await admin.$executeRawUnsafe(`
            INSERT INTO "SystemFiatPool" (id, balance, "updatedAt")
            VALUES (1, 100000, now())
            ON CONFLICT (id) DO UPDATE SET balance = 100000, "updatedAt" = now()`);
    }, 40000);

    afterAll(async () => {
        await Promise.allSettled([admin.$disconnect(), a.$disconnect(), b.$disconnect()]);
    });

    async function seedWithdrawal(status) {
        await admin.$executeRawUnsafe(
            `DELETE FROM "Withdrawal" WHERE status IN ('PENDING','APPROVED')`);
        const user = await admin.user.create({
            data: { email: `wph-race-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
                username: `wphrace${Date.now()}${Math.floor(Math.random() * 1000)}`, password: 'x' },
            select: { id: true },
        });
        const tx = await admin.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_FIAT', status: 'PENDING', amountUsdc: 50,
                txHash: `wph-race-${Date.now()}-${Math.random().toString(36).slice(2)}` },
            select: { id: true, txHash: true },
        });
        const w = await admin.withdrawal.create({
            data: { userId: user.id, amount: 50, destination: '0244000002', network: 'MTN',
                payoutMethod: 'MTN_MOMO', status, transactionHistoryId: tx.id },
            select: { id: true },
        });
        return { withdrawalId: w.id, reference: tx.txHash, userId: user.id };
    }

    async function raceTwoWorkers(seed) {
        const calls = [];
        // The adapter records the row's DURABLE status at the moment provider I/O
        // begins: the claim must already have committed.
        const adapter = {
            initiateTransfer: async (req) => {
                const row = await admin.withdrawal.findUnique({
                    where: { id: seed.withdrawalId }, select: { status: true },
                });
                calls.push({ amountGhs: req.amountGhs, referenceId: req.referenceId, statusAtCall: row.status });
                return { _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED' };
            },
        };
        // No scan override here: both workers read the real regime, and the
        // question is purely which one wins the CAS.
        const w1 = new PayoutBatchWorker(a, { emit: () => {} }, adapter, null);
        const w2 = new PayoutBatchWorker(b, { emit: () => {} }, adapter, null);
        const results = await Promise.all([
            w1._processBatch(settings, { isManualTrigger: true }),
            w2._processBatch(settings, { isManualTrigger: true }),
        ]);
        await new Promise((r) => setTimeout(r, 50)); // let any losing worker settle its own state
        return { calls, results };
    }

    test('two workers racing the same PENDING withdrawal produce exactly one provider call', async () => {
        const seed = await seedWithdrawal('PENDING');
        const { calls } = await raceTwoWorkers(seed);
        expect(calls).toHaveLength(1);
        // Provider I/O happens ONLY after the claim has committed PROCESSING.
        expect(calls[0].statusAtCall).toBe('PROCESSING');
        expect(calls[0].referenceId).toBe(seed.reference);
    }, 90000);

    test('two workers racing the same APPROVED withdrawal produce exactly one provider call', async () => {
        const seed = await seedWithdrawal('APPROVED');
        const { calls } = await raceTwoWorkers(seed);
        expect(calls).toHaveLength(1);
        expect(calls[0].statusAtCall).toBe('PROCESSING');
    }, 90000);

    test('a reservation cancelled after the scan cannot authorise a payout at its stale amount', async () => {
        const seed = await seedWithdrawal('PENDING');
        // The SCAN is served a stale, fully valid reservation (the row that a
        // concurrent cancellation is about to delete). The transaction client is
        // the real database, where that reservation no longer exists.
        const stale = { id: 'stale-res', reference: seed.reference, amountGhs: '9999.00' };
        const initiateTransfer = jest.fn();
        const scan = withScanOverride(a, {
            fiatLiquidityReservation: { findUnique: async () => stale },
        });

        // Authority is ACTIVE for the authoritative read, so an unreserved row
        // must park rather than fall back to the legacy pool.
        await admin.$executeRawUnsafe(
            `UPDATE "FiatLiquidityState" SET "authorityActivatedAt" = now(), "updatedAt" = now() WHERE id = 1`);
        const worker = new PayoutBatchWorker(scan, { emit: () => {} }, { initiateTransfer }, null);
        const results = await worker._processBatch(settings, { isManualTrigger: true });

        expect(initiateTransfer).not.toHaveBeenCalled();
        expect(results.processed).toBe(0);
        expect(results.details.flaggedManualReview.map((r) => r.reason))
            .toContain('AUTHORITY_ACTIVE_WITHOUT_RESERVATION');
        const row = await admin.withdrawal.findUnique({ where: { id: seed.withdrawalId }, select: { status: true } });
        expect(row.status).toBe('NEEDS_MANUAL_REVIEW');

        await admin.$executeRawUnsafe(
            `UPDATE "FiatLiquidityState" SET "authorityActivatedAt" = NULL, "updatedAt" = now() WHERE id = 1`);
    }, 90000);

    test('a valid authority reservation pays its ORIGINAL reserved GHS, never a rate-recomputed amount', async () => {
        const seed = await seedWithdrawal('PENDING');
        await admin.fiatLiquidityReservation.create({
            data: { id: `res-${Date.now()}`, reference: seed.reference, amountGhs: '612.35', status: 'RESERVED', provider: 'moolre', rail: 'MTN' },
        });
        await admin.$executeRawUnsafe(
            `UPDATE "FiatLiquidityState" SET "authorityActivatedAt" = now(), "updatedAt" = now() WHERE id = 1`);

        const calls = [];
        const adapter = { initiateTransfer: async (req) => { calls.push(req); return { _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED' }; } };
        const worker = new PayoutBatchWorker(a, { emit: () => {} }, adapter, null);
        await worker._processBatch(settings, { isManualTrigger: true });

        expect(calls).toHaveLength(1);
        // 50 USDC at the 12.5 fallback rate would be 625.00 — the reserved 612.35
        // must win, and it must be an exact 2-dp string.
        expect(calls[0].amountGhs).toBe('612.35');
        expect(typeof calls[0].amountGhs).toBe('string');

        await admin.$executeRawUnsafe(
            `UPDATE "FiatLiquidityState" SET "authorityActivatedAt" = NULL, "updatedAt" = now() WHERE id = 1`);
    }, 90000);
});
