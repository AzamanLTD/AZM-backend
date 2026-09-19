const PayoutBatchWorker = require('../workers/payoutBatchWorker');

// §P.5-D: the worker records dispatch evidence through the liquidity
// authority collaborator before/around every dispatch — stub the boundary.
jest.mock('../src/services/fiatLiquidityService', () => ({
    isAuthorityEnabled: jest.fn().mockResolvedValue(false),
    toExactGhsDecimal: jest.fn((v) => v),
    recordProviderEvent: jest.fn().mockResolvedValue({ replay: false }),
    inTransitIfRecorded: jest.fn().mockResolvedValue({ skipped: true }),
    settleIfRecorded: jest.fn().mockResolvedValue({ skipped: true }),
}));

describe('PayoutBatchWorker canonical withdrawal transaction', () => {
    const settings = {
        autoPayoutEnabled: true,
        autoPayoutMaxAmountUsdc: 200,
        autoPayoutThresholdUsdc: 500,
        autoPayoutIntervalMs: 120000,
    };

    test('atomically claims before dispatching with canonical reference and network', async () => {
        const initiateTransfer = jest.fn().mockResolvedValue({ status: 'ACCEPTED' });
        const withdrawalUpdate = jest.fn().mockResolvedValue({});
        const withdrawalUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
        const txCreate = jest.fn();
        const txFindMany = jest.fn().mockResolvedValue([{
            id: 'tx-1', txHash: 'canonical-ref-1', status: 'PENDING', userId: 7, amountUsdc: 50,
        }]);
        const prisma = {
            globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
            systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: 1000 }) },
        // §P.5-D per-row regime: no reservation row → this is a LEGACY
        // withdrawal; the legacy SystemFiatPool policy applies.
        fiatLiquidityReservation: { findUnique: jest.fn().mockResolvedValue(null) },
            withdrawal: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 91, userId: 7, amount: 50, destination: '0240000000', network: 'TELECEL',
                    payoutMethod: 'MTN_MOMO', createdAt: new Date('2026-08-30T10:00:00.000Z'),
                }]),
                update: withdrawalUpdate,
                updateMany: withdrawalUpdateMany,
            },
            transactionHistory: { findMany: txFindMany, findUnique: jest.fn(), create: txCreate },
        };
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);
        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(result.processed).toBe(1);
        expect(withdrawalUpdateMany).toHaveBeenCalledWith({
            where: { id: 91, status: 'PENDING' }, data: { status: 'PROCESSING' },
        });
        expect(initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({
            referenceId: 'canonical-ref-1', externalId: 'auto_payout_91', network: 'TELECEL',
        }));
        expect(withdrawalUpdate).not.toHaveBeenCalled();
        expect(txCreate).not.toHaveBeenCalled();
    });

    test('refuses auto-dispatch when another worker has already claimed the withdrawal', async () => {
        const initiateTransfer = jest.fn();
        const prisma = {
            globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
            systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: 1000 }) },
        // §P.5-D per-row regime: no reservation row → this is a LEGACY
        // withdrawal; the legacy SystemFiatPool policy applies.
        fiatLiquidityReservation: { findUnique: jest.fn().mockResolvedValue(null) },
            withdrawal: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 93, userId: 7, amount: 50, destination: '0240000000', network: 'MTN',
                    payoutMethod: 'MTN_MOMO', createdAt: new Date('2026-08-30T10:00:00.000Z'),
                }]),
                update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
            transactionHistory: {
                findMany: jest.fn().mockResolvedValue([{ id: 'tx-3', txHash: 'ref-3', status: 'PENDING', amountUsdc: 50 }]),
                findUnique: jest.fn(),
            },
        };
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);
        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(result.processed).toBe(0);
        expect(result.flagged).toBe(0);
        expect(result.details.errors).toEqual([{ id: 93, reason: 'WITHDRAWAL_ALREADY_CLAIMED' }]);
        expect(initiateTransfer).not.toHaveBeenCalled();
    });

    test('flags ambiguous canonical transaction correlation instead of dispatching', async () => {
        const initiateTransfer = jest.fn();
        const prisma = {
            globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
            systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: 1000 }) },
        // §P.5-D per-row regime: no reservation row → this is a LEGACY
        // withdrawal; the legacy SystemFiatPool policy applies.
        fiatLiquidityReservation: { findUnique: jest.fn().mockResolvedValue(null) },
            withdrawal: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 92, userId: 7, amount: 50, destination: '0240000000', network: 'AIRTELTIGO',
                    payoutMethod: 'MTN_MOMO', createdAt: new Date('2026-08-30T10:00:00.000Z'),
                }]),
                update: jest.fn().mockResolvedValue({}), updateMany: jest.fn(),
            },
            transactionHistory: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'tx-1', txHash: 'ref-1', status: 'PENDING', amountUsdc: 50 },
                    { id: 'tx-2', txHash: 'ref-2', status: 'PENDING', amountUsdc: 50 },
                ]),
                findUnique: jest.fn(),
            },
        };
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);
        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(result.processed).toBe(0);
        expect(result.flagged).toBe(1);
        expect(initiateTransfer).not.toHaveBeenCalled();
        expect(prisma.withdrawal.update).toHaveBeenCalledWith({
            where: { id: 92 }, data: { status: 'NEEDS_MANUAL_REVIEW' },
        });
    });
});

// ── P0: provider unknown-outcome classification ──────────────────────────────
describe('PayoutBatchWorker provider outcome classification', () => {
    const settings = {
        autoPayoutEnabled: true,
        autoPayoutMaxAmountUsdc: 200,
        autoPayoutThresholdUsdc: 500,
        autoPayoutIntervalMs: 120000,
    };

    const buildPrisma = ({ withdrawal, update, updateMany }) => ({
        globalSettings: { findUnique: jest.fn().mockResolvedValue({ ...settings, liveRetailRate: 13 }) },
        systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: 1000 }) },
        // §P.5-D per-row regime: no reservation row → this is a LEGACY
        // withdrawal; the legacy SystemFiatPool policy applies.
        fiatLiquidityReservation: { findUnique: jest.fn().mockResolvedValue(null) },
        withdrawal: {
            findMany: jest.fn().mockResolvedValue([withdrawal]),
            update,
            updateMany,
        },
        transactionHistory: {
            findMany: jest.fn().mockResolvedValue([{ id: 'tx-1', txHash: 'ref-1', status: 'PENDING', amountUsdc: 50 }]),
            findUnique: jest.fn(),
        },
    });

    const baseWithdrawal = {
        id: 101, userId: 7, amount: 50, destination: '0240000000', network: 'MTN',
        payoutMethod: 'MTN_MOMO', createdAt: new Date('2026-08-30T10:00:00.000Z'),
    };

    test('UNKNOWN_OUTCOME stays PROCESSING for reconciliation — never flagged for manual review', async () => {
        const dispatchErr = new Error('socket hang up');
        dispatchErr.providerOutcome = 'UNKNOWN_OUTCOME';
        const initiateTransfer = jest.fn().mockRejectedValue(dispatchErr);
        const update = jest.fn();
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const prisma = buildPrisma({ withdrawal: baseWithdrawal, update, updateMany });
        const io = { emit: jest.fn() };

        const worker = new PayoutBatchWorker(prisma, io, { initiateTransfer }, null);
        const result = await worker._processBatch(settings, { isManualTrigger: true });

        // claim happened before dispatch
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: 101, status: 'PENDING' }, data: { status: 'PROCESSING' },
        });
        // NOT moved out of the reconciliation pipeline
        expect(update).not.toHaveBeenCalled();
        expect(result.flagged).toBe(0);
        expect(result.details.unknownOutcome).toEqual([{
            id: 101, amount: 50, reason: 'DISBURSEMENT_OUTCOME_UNKNOWN',
            providerOutcome: 'UNKNOWN_OUTCOME', error: 'socket hang up',
        }]);
        // observability alert for ambiguous dispatches
        expect(io.emit).toHaveBeenCalledWith('admin_alert', expect.objectContaining({
            type: 'PAYOUTS_PENDING_PROVIDER_RECONCILIATION', count: 1,
        }));
    });

    test('UNCLASSIFIED adapter errors are conservatively treated as unknown outcome', async () => {
        const initiateTransfer = jest.fn().mockRejectedValue(new Error('provider exploded'));
        const update = jest.fn();
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const prisma = buildPrisma({ withdrawal: baseWithdrawal, update, updateMany });

        const worker = new PayoutBatchWorker(prisma, { emit: jest.fn() }, { initiateTransfer }, null);
        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(update).not.toHaveBeenCalled();
        expect(result.details.unknownOutcome[0]).toMatchObject({
            id: 101, providerOutcome: 'UNKNOWN_OUTCOME',
        });
    });

    test('DEFINITIVE_REJECTION still flags manual review (explicit provider refusal)', async () => {
        const dispatchErr = new Error('MTN transfer rejected: INVALID_MSISDN');
        dispatchErr.providerOutcome = 'DEFINITIVE_REJECTION';
        const initiateTransfer = jest.fn().mockRejectedValue(dispatchErr);
        const update = jest.fn().mockResolvedValue({});
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const prisma = buildPrisma({ withdrawal: baseWithdrawal, update, updateMany });

        const worker = new PayoutBatchWorker(prisma, { emit: jest.fn() }, { initiateTransfer }, null);
        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(update).toHaveBeenCalledWith({
            where: { id: 101 }, data: { status: 'NEEDS_MANUAL_REVIEW' },
        });
        expect(result.flagged).toBe(1);
        expect(result.details.unknownOutcome).toEqual([]);
    });

    test('NOT_DISPATCHED (provably no provider I/O) flags manual review', async () => {
        const dispatchErr = new Error('[MtnDisbursementService] recipientPhone is required.');
        dispatchErr.providerOutcome = 'NOT_DISPATCHED';
        const initiateTransfer = jest.fn().mockRejectedValue(dispatchErr);
        const update = jest.fn().mockResolvedValue({});
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const prisma = buildPrisma({ withdrawal: baseWithdrawal, update, updateMany });

        const worker = new PayoutBatchWorker(prisma, { emit: jest.fn() }, { initiateTransfer }, null);
        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(update).toHaveBeenCalledWith({
            where: { id: 101 }, data: { status: 'NEEDS_MANUAL_REVIEW' },
        });
        expect(result.flagged).toBe(1);
    });
});

