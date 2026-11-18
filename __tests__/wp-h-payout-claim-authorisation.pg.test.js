/**
 * §WP-H — THE CLAIM TRANSACTION IS THE AUTHORISATION.
 *
 * The preflight scan is an OPTIMISATION. This suite makes the two disagree on
 * purpose: the scan is served INACTIVE authority while PostgreSQL genuinely holds
 * an ACTIVE regime, which is exactly the interleaving the old worker allowed. The
 * claim transaction must re-read the regime under the shared lock and PARK the
 * unreserved legacy row instead of dispatching it. The provider adapter must
 * never be reached.
 *
 * The scan reads are stubbed because they are the untrusted input; every
 * authoritative read (regime, withdrawal, canonical row, reservation) goes to the
 * real database through the transaction client.
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

describe('§WP-H claim-transaction authorisation (real PostgreSQL)', () => {
    let admin;
    let real;
    let withdrawalId;
    let refId;
    let userId;

    beforeAll(async () => {
        if (!DB_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');
        admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        real = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        await Promise.all([admin.$connect(), real.$connect()]);

        // ACTIVE authority, latched by the activation record itself.
        await admin.$executeRawUnsafe(`
            INSERT INTO "FiatLiquidityState" (id, "authorityActivatedAt", "updatedAt")
            VALUES (1, now(), now())
            ON CONFLICT (id) DO UPDATE SET "authorityActivatedAt" = now(), "updatedAt" = now()`);

        await admin.$executeRawUnsafe(`DELETE FROM "Withdrawal" WHERE status IN ('PENDING','APPROVED')`);

        // Enough legacy projected liquidity that the PREFLIGHT pool policy does
        // not short-circuit the row. Without this the row parks on
        // INSUFFICIENT_POOL_LIQUIDITY and never reaches the claim transaction,
        // which would make this test pass for the wrong reason.
        await admin.$executeRawUnsafe(`
            INSERT INTO "SystemFiatPool" (id, balance, "updatedAt")
            VALUES (1, 100000, now())
            ON CONFLICT (id) DO UPDATE SET balance = 100000, "updatedAt" = now()`);

        // A real payer must exist: TransactionHistory.userId is a foreign key.
        const user = await admin.user.create({
            data: {
                email: `wph-claim-${Date.now()}@example.test`,
                username: `wphclaim${Date.now()}`,
                password: 'x',
            },
            select: { id: true },
        });
        userId = user.id;

        const tx = await admin.transactionHistory.create({
            data: {
                userId, type: 'WITHDRAWAL_FIAT', status: 'PENDING',
                amountUsdc: 50, txHash: `wph-claim-${Date.now()}`,
            },
            select: { id: true, txHash: true },
        });
        refId = tx.txHash;
        const w = await admin.withdrawal.create({
            data: {
                userId, amount: 50, destination: '0244000001', network: 'MTN',
                payoutMethod: 'MTN_MOMO', status: 'PENDING', transactionHistoryId: tx.id,
            },
            select: { id: true },
        });
        withdrawalId = w.id;
        // Deliberately NO FiatLiquidityReservation for this reference.
        await admin.$executeRawUnsafe(
            `DELETE FROM "FiatLiquidityReservation" WHERE reference = $1`, refId);
    }, 40000);

    afterAll(async () => {
        try {
            await admin.$executeRawUnsafe(
                `UPDATE "FiatLiquidityState" SET "authorityActivatedAt" = NULL WHERE id = 1`);
        } catch (_) { /* best effort */ }
        await Promise.allSettled([admin.$disconnect(), real.$disconnect()]);
    });

    test('an unreserved legacy row is PARKED when the claim transaction sees ACTIVE authority, and no provider I/O happens', async () => {
        const initiateTransfer = jest.fn();
        const adapter = { initiateTransfer };

        // The SCAN is told the regime is inactive; the transaction client is the
        // real database, which is latched ACTIVE.
        const scan = {
            ...real,
            globalSettings: { findUnique: async () => ({ id: 1, liveRetailRate: 12.5 }) },
            fiatLiquidityState: { findUnique: async () => ({ id: 1, authorityActivatedAt: null }) },
            $transaction: (...args) => real.$transaction(...args),
        };
        scan.$queryRawUnsafe = (...a) => real.$queryRawUnsafe(...a);
        scan.$executeRawUnsafe = (...a) => real.$executeRawUnsafe(...a);

        const worker = new PayoutBatchWorker(scan, { emit: () => {} }, adapter, null);
        const results = await worker._processBatch(settings, { isManualTrigger: true });

        expect(initiateTransfer).not.toHaveBeenCalled();
        expect(results.processed).toBe(0);
        expect(results.flagged).toBe(1);
        expect(results.details.flaggedManualReview.map((r) => r.reason))
            .toContain('AUTHORITY_ACTIVE_WITHOUT_RESERVATION');
        expect(results.details.errors).toHaveLength(0);

        const row = await admin.withdrawal.findUnique({ where: { id: withdrawalId }, select: { status: true } });
        expect(row.status).toBe('NEEDS_MANUAL_REVIEW');

        const evidence = await admin.$queryRawUnsafe(
            `SELECT reason FROM "ReconciliationException" WHERE "entityId" = $1 ORDER BY "lastSeenAt" DESC LIMIT 1`,
            String(withdrawalId));
        expect(evidence.length).toBe(1);
        expect(evidence[0].reason).toBe('AUTHORITY_ACTIVE_WITHOUT_RESERVATION');
    }, 90000);
});
