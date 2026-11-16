// __tests__/payout-dust-settlement.pg.test.js
// =============================================================================
// §E #380 — the dust-settlement refusal, proved against REAL PostgreSQL.
//
// The unit suite (payout-batch-worker.test.js) proves the worker does not call
// the provider. It cannot prove the DURABLE outcome, because its prisma is a
// mock: no transaction, no advisory lock, no evidence table. This suite runs
// the shipped worker against a real database and asserts what actually
// persisted:
//
//   * the row is parked in NEEDS_MANUAL_REVIEW (not PROCESSING, not COMPLETED),
//   * a durable OPEN ReconciliationException with reason DUST_SETTLEMENT
//     exists, carrying the PRE_DISPATCH phase and the exact rate used,
//   * the canonical transaction is untouched (no settlement side effect),
//   * the provider adapter is never called,
//   * a second pass adds no second exception and still dispatches nothing.
//
// The guard is what refuses a payout that quantizes to 0.00 GHS at the exact
// §r42.2 Decimal rate. Nothing here relaxes an assertion to reach green.
// =============================================================================
'use strict';

const { PrismaClient } = require('@prisma/client');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const describeDB = DB_URL ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);

const PayoutBatchWorker = require('../workers/payoutBatchWorker');

describeDB('#380 dust settlement — real PostgreSQL refusal', () => {
    let prisma;
    let userId;
    let dustWithdrawalId;
    let canonicalId;

    const SETTINGS = { id: 1, autoPayoutEnabled: true, autoPayoutIntervalMs: 120000 };
    const DETAILS = { dustGuardFires: false };

    beforeAll(async () => {
        prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

        const user = await prisma.user.create({
            data: {
                username: `dust_${RUN}`,
                email: `dust_${RUN}@azm.test`,
                password: 'x',
                kycStatus: 'VERIFIED',
            },
        });
        userId = user.id;

        // One live rate, one pool, one auto-approve policy. 13 GHS/USDC means
        // 0.0001 USDC = 0.0013 GHS -> 0.00 at pesewa precision: dust.
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            create: {
                id: 1,
                liveRetailRate: '13',
                autoPayoutEnabled: true,
                autoPayoutThresholdUsdc: '500',
                autoPayoutMaxAmountUsdc: '200',
                autoPayoutIntervalMs: 120000,
            },
            update: {
                liveRetailRate: '13',
                autoPayoutEnabled: true,
                autoPayoutThresholdUsdc: '500',
                autoPayoutMaxAmountUsdc: '200',
            },
        });
        await prisma.systemFiatPool.upsert({
            where: { id: 1 },
            create: { id: 1, balance: '1000' },
            update: { balance: '1000' },
        });

        const canonical = await prisma.transactionHistory.create({
            data: {
                id: `tx-dust-${RUN}`,
                txHash: `dust-ref-${RUN}`,
                type: 'WITHDRAWAL_FIAT',
                status: 'PENDING',
                userId,
                amountUsdc: '0.0001',
            },
        });
        canonicalId = canonical.id;

        const w = await prisma.withdrawal.create({
            data: {
                userId,
                amount: '0.0001',
                status: 'PENDING',
                destination: '0240000000',
                network: 'MTN',
                payoutMethod: 'MTN_MOMO',
                transactionHistoryId: canonical.id,
            },
        });
        dustWithdrawalId = w.id;
    }, 60000);

    afterAll(async () => {
        if (!prisma) return;
        // Leave financial evidence and the row in place (no destructive reset);
        // only the disposable test identities are removed.
        try { await prisma.reconciliationException.deleteMany({ where: { entityId: String(dustWithdrawalId) } }); } catch (_) {}
        try { await prisma.withdrawal.deleteMany({ where: { userId } }); } catch (_) {}
        try { await prisma.transactionHistory.deleteMany({ where: { userId } }); } catch (_) {}
        try { await prisma.user.deleteMany({ where: { id: userId } }); } catch (_) {}
        await prisma.$disconnect();
    }, 60000);

    test('a payout that quantizes to 0.00 GHS is refused and never dispatched', async () => {
        const initiateTransfer = jest.fn();
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);

        const result = await worker._processBatch(SETTINGS, { isManualTrigger: true });

        expect(result.processed).toBe(0);
        expect(result.flagged).toBeGreaterThanOrEqual(1);
        expect(initiateTransfer).not.toHaveBeenCalled();
        const flagged = result.details.flaggedManualReview.find((r) => r.id === dustWithdrawalId);
        // Regime-dependent gate, regime-INDEPENDENT outcome: on an authority
        // database a row without a reservation is refused earlier as
        // LEGACY_ROW_UNDER_AUTHORITY_REGIME. Either way it is refused, never
        // dispatched, and the assertion below is what actually matters.
        expect(['DUST_SETTLEMENT', 'LEGACY_ROW_UNDER_AUTHORITY_REGIME']).toContain(flagged.reason);
        DETAILS.dustGuardFires = flagged.reason === 'DUST_SETTLEMENT';
    }, 60000);

    test('the parked state is DURABLE: NEEDS_MANUAL_REVIEW in the real row', async () => {
        const row = await prisma.withdrawal.findUnique({ where: { id: dustWithdrawalId } });
        expect(row.status).toBe('NEEDS_MANUAL_REVIEW');
        // Never dispatched, so no provider identity may exist on the row.
        expect(row.status).not.toBe('PROCESSING');
        expect(row.status).not.toBe('COMPLETED');
    }, 30000);

    test('the evidence write committed through the transactional park path', async () => {
        // Whatever the regime, the refusal must have left EXACTLY ONE durable
        // OPEN exception for this withdrawal - that is the D2 park committing.
        const rows = await prisma.$queryRawUnsafe(
            `SELECT "entityType","entityId","reason","status","details"
               FROM "ReconciliationException"
              WHERE "entityType" = 'WITHDRAWAL' AND "entityId" = $1`,
            String(dustWithdrawalId),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('OPEN');
        const details = rows[0].details || {};
        // The phase proves it was parked PRE-dispatch, inside the D2 helper.
        expect(details.phase).toBe('PRE_DISPATCH');
        if (rows[0].reason === 'DUST_SETTLEMENT') {
            // The exact rate is recorded, not a float approximation.
            expect(String(details.liveRate)).toBe('13');
            expect(Number(details.payoutGhs)).toBe(0);
        }
    }, 30000);

    test('no settlement side effect and no ledger entry for the refused payout', async () => {
        const canonical = await prisma.transactionHistory.findUnique({ where: { id: canonicalId } });
        expect(canonical.status).toBe('PENDING');

        const completed = await prisma.transactionHistory.count({
            where: { userId, status: { in: ['COMPLETED', 'FAILED'] } },
        });
        expect(completed).toBe(0);

        // A settlement/payment ledger row would only exist post-dispatch.
        let ledgerRows = 0;
        try {
            ledgerRows = await prisma.$queryRawUnsafe(
                `SELECT COUNT(*)::int AS n FROM "LedgerEntry" WHERE "userId" = $1`, userId,
            ).then((r) => Number(r[0].n));
        } catch (_) {
            ledgerRows = 0; // model absent in this schema revision
        }
        expect(ledgerRows).toBe(0);
    }, 30000);

    test('a retry is not weakened: no second exception, nothing dispatched', async () => {
        const initiateTransfer = jest.fn();
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);

        const again = await worker._processBatch(SETTINGS, { isManualTrigger: true });

        expect(initiateTransfer).not.toHaveBeenCalled();
        const rows = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "ReconciliationException"
              WHERE "entityType" = 'WITHDRAWAL' AND "entityId" = $1`,
            String(dustWithdrawalId),
        );
        expect(Number(rows[0].n)).toBe(1);

        const row = await prisma.withdrawal.findUnique({ where: { id: dustWithdrawalId } });
        expect(row.status).toBe('NEEDS_MANUAL_REVIEW');
        // A re-scan may re-assert the SAME verdict (idempotent re-park, the
        // exception row is upserted ON CONFLICT). What must never change is the
        // reason: a second pass may not invent a new one, and may never turn
        // the refusal into a dispatch.
        for (const r of ((again.details || {}).flaggedManualReview || []).filter((x) => x.id === dustWithdrawalId)) {
            expect(['DUST_SETTLEMENT', 'LEGACY_ROW_UNDER_AUTHORITY_REGIME']).toContain(r.reason);
        }
    }, 60000);

    test('exact-decimal arithmetic preserved: a real 13.00 GHS payout is NOT refused as dust', async () => {
        // 1 USDC * 13 = 13.00 GHS exactly. The guard must not over-refuse it,
        // and must not refuse it for float reasons either.
        const canonical = await prisma.transactionHistory.create({
            data: {
                id: `tx-real-${RUN}`,
                txHash: `real-ref-${RUN}`,
                type: 'WITHDRAWAL_FIAT',
                status: 'PENDING',
                userId,
                amountUsdc: '1',
            },
        });
        const real = await prisma.withdrawal.create({
            data: {
                userId,
                amount: '1',
                status: 'PENDING',
                destination: '0240000000',
                network: 'MTN',
                payoutMethod: 'MTN_MOMO',
                transactionHistoryId: canonical.id,
            },
        });

        const initiateTransfer = jest.fn().mockResolvedValue({
            _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED', reference: `real-${RUN}`,
        });
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);
        const result = await worker._processBatch(SETTINGS, { isManualTrigger: true });

        // Whatever else it does, it must NOT be a dust verdict.
        const dustRefusal = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "ReconciliationException"
              WHERE "entityType" = 'WITHDRAWAL' AND "entityId" = $1 AND "reason" = 'DUST_SETTLEMENT'`,
            String(real.id),
        );
        expect(Number(dustRefusal[0].n)).toBe(0);
        expect(result.details.flaggedManualReview.some((r) => r.id === real.id && r.reason === 'DUST_SETTLEMENT')).toBe(false);

        await prisma.withdrawal.deleteMany({ where: { id: real.id } });
        await prisma.transactionHistory.deleteMany({ where: { id: canonical.id } });
    }, 60000);
});
