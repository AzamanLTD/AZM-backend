jest.mock('../src/config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));

jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn() }));
jest.mock('../services/businessOrderService', () => ({
    updateOrderStatusFromEscrow: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/bizNotificationService', () => ({
    notifyOrderEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/fiatSettlementService', () => ({
    settleFiatWithdrawal: jest.fn(),
}));
jest.mock('../services/providerSettlementAttemptService', () => ({
    recordProviderSettlementAttempt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/notificationService', () => jest.fn().mockImplementation(() => ({
    sendNotification: jest.fn().mockResolvedValue(undefined),
})));

const escrowService = require('../services/escrowService');
const { settleFiatWithdrawal } = require('../services/fiatSettlementService');
const { recordProviderSettlementAttempt } = require('../services/providerSettlementAttemptService');
const {
    moolreDisbursementWebhook,
} = require('../controllers/fiatSettlementWebhook.controller');

const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));

const exactKeys = (value) => Object.keys(value).sort();

function createResponse() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
}

function createApp(values) {
    return {
        get: jest.fn((key) => values[key]),
    };
}

describe('financial realtime event contracts', () => {
    let emit;
    let io;

    beforeEach(() => {
        jest.clearAllMocks();
        emit = jest.fn();
        io = { to: jest.fn(() => ({ emit })) };
        escrowService.setSocketIO(io);
    });

    test('escrow_funded targets the two participants plus admin and carries the full contract', async () => {
        const fundedAt = new Date('2026-09-01T05:00:00.000Z');
        const updatedEscrow = {
            id: 'escrow-contract-1',
            ticketId: 'ticket-contract-1',
            payerId: 101,
            payeeId: 202,
            status: 'FUNDED',
            amountUsdc: 125,
            fundedAt,
        };
        const tx = {
            user: {
                findUnique: jest.fn().mockResolvedValue({ availableBalance: 500 }),
                update: jest.fn().mockResolvedValue({}),
            },
            smartEscrow: {
                update: jest.fn().mockResolvedValue(updatedEscrow),
            },
            systemProfitFees: {
                upsert: jest.fn().mockResolvedValue({}),
                update: jest.fn().mockResolvedValue({}),
            },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            adminProfitLog: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            smartEscrow: {
                findUnique: jest.fn().mockResolvedValue({
                    ...updatedEscrow,
                    status: 'DRAFT',
                    feeUsdc: 5,
                }),
            },
            globalSettings: { findUnique: jest.fn().mockResolvedValue({ escrowFundedExpiryDays: 30 }) },
            $transaction: jest.fn(async callback => callback(tx)),
        };

        await escrowService.fundEscrow(prisma, {
            escrowId: updatedEscrow.id,
            payerId: updatedEscrow.payerId,
        });
        await flushMicrotasks();

        const fundedPayloads = emit.mock.calls.filter(call => call[0] === 'escrow_funded');
        expect(fundedPayloads).toHaveLength(3);
        expect(io.to.mock.calls.map(([room]) => room)).toEqual([
            'user_101',
            'user_202',
            'admin_spy_room',
        ]);

        const payload = fundedPayloads[0][1];
        expect(exactKeys(payload)).toEqual([
            'amountUsdc',
            'escrowId',
            'fundedAt',
            'payeeId',
            'payerId',
            'status',
            'ticketId',
        ]);
        expect(payload).toEqual(expect.objectContaining({
            escrowId: 'escrow-contract-1',
            ticketId: 'ticket-contract-1',
            status: 'FUNDED',
            amountUsdc: 125,
            payerId: 101,
            payeeId: 202,
            fundedAt,
        }));
    });

    test('escrow_settled targets the same rooms, but RELEASED dispute resolution is not this event', async () => {
        const settledAt = new Date('2026-09-01T05:01:00.000Z');
        const tx = {
            smartEscrow: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({
                    id: 'escrow-contract-2',
                    ticketId: 'ticket-contract-2',
                    payerId: 101,
                    payeeId: 202,
                    status: 'SETTLED',
                    amountUsdc: 80,
                    settledAt,
                }),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            smartEscrow: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'escrow-contract-2',
                    ticketId: 'ticket-contract-2',
                    payerId: 101,
                    payeeId: 202,
                    status: 'PENDING_SETTLEMENT',
                    amountUsdc: 80,
                }),
            },
            $transaction: jest.fn(async callback => callback(tx)),
        };

        await escrowService._releaseEscrow(prisma, 'escrow-contract-2', 'SETTLED');
        await flushMicrotasks();

        const settledCalls = emit.mock.calls.filter(call => call[0] === 'escrow_settled');
        expect(settledCalls).toHaveLength(3);
        expect(io.to.mock.calls.map(([room]) => room)).toEqual([
            'user_101',
            'user_202',
            'admin_spy_room',
        ]);
        expect(settledCalls[0][1]).toEqual(expect.objectContaining({
            escrowId: 'escrow-contract-2',
            ticketId: 'ticket-contract-2',
            status: 'SETTLED',
            amountUsdc: 80,
            payerId: 101,
            payeeId: 202,
            settledAt,
        }));
        expect(exactKeys(settledCalls[0][1])).toEqual([
            'amountUsdc',
            'escrowId',
            'payeeId',
            'payerId',
            'settledAt',
            'status',
            'ticketId',
        ]);

        jest.clearAllMocks();
        escrowService.setSocketIO(io);
        const releasedTx = {
            smartEscrow: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({
                    id: 'escrow-contract-3',
                    ticketId: 'ticket-contract-3',
                    payerId: 101,
                    payeeId: 202,
                    status: 'RELEASED',
                    amountUsdc: 80,
                    settledAt,
                }),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            };
        const releasedPrisma = {
            smartEscrow: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'escrow-contract-3',
                    ticketId: 'ticket-contract-3',
                    payerId: 101,
                    payeeId: 202,
                    status: 'DISPUTED',
                    amountUsdc: 80,
                }),
            },
            $transaction: jest.fn(async callback => callback(releasedTx)),
        };

        await escrowService._releaseEscrow(releasedPrisma, 'escrow-contract-3', 'RELEASED');
        await flushMicrotasks();

        expect(emit.mock.calls.filter(call => call[0] === 'escrow_settled')).toHaveLength(0);
    });

    test('withdrawal_progress is user-scoped and carries the progress contract for pending callbacks', async () => {
        process.env.MOOLRE_WEBHOOK_SECRET = 'contract-secret';
        const prisma = {
            transactionHistory: {
                findUnique: jest.fn().mockResolvedValue({ userId: 303 }),
            },
        };
        const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
        const req = {
            headers: { 'x-moolre-webhook-secret': 'contract-secret' },
            body: { externalref: 'withdrawal-contract-1', txstatus: 0 },
            app: createApp({ prisma, socketio: io }),
        };
        const res = createResponse();

        await moolreDisbursementWebhook(req, res);

        const progressEmit = io.to.mock.results[0].value.emit;
        expect(io.to).toHaveBeenCalledWith('user_303');
        expect(progressEmit).toHaveBeenCalledWith('withdrawal_progress', expect.any(Object));
        const payload = progressEmit.mock.calls[0][1];
        expect(exactKeys(payload)).toEqual([
            'label',
            'pct',
            'reference',
            'stage',
            'status',
            'timestamp',
        ]);
        expect(payload).toEqual(expect.objectContaining({
            reference: 'withdrawal-contract-1',
            status: 'PENDING',
            stage: 'PROCESSING',
            pct: 60,
        }));
        expect(recordProviderSettlementAttempt).toHaveBeenCalledWith(prisma, expect.objectContaining({
            reference: 'withdrawal-contract-1',
            provider: 'MOOLRE',
            status: 'PENDING',
        }));
    });

    test('withdrawal_settled remains user-scoped while admin receives the separate admin_alert projection', async () => {
        process.env.MOOLRE_WEBHOOK_SECRET = 'contract-secret';
        settleFiatWithdrawal.mockResolvedValue({
            changed: true,
            userId: 404,
            reference: 'withdrawal-contract-2',
            status: 'COMPLETED',
            providerTxId: 'moolre-tx-2',
        });

        const userEmit = jest.fn();
        const adminEmit = jest.fn();
        const io = {
            to: jest.fn((room) => ({
                emit: room === 'admin_spy' ? adminEmit : userEmit,
            })),
        };
        const emitBalanceUpdate = jest.fn().mockResolvedValue(undefined);
        const req = {
            headers: { 'x-moolre-webhook-secret': 'contract-secret' },
            body: { externalref: 'withdrawal-contract-2', txstatus: 1 },
            app: createApp({
                prisma: {},
                socketio: io,
                emitBalanceUpdate,
            }),
        };
        const res = createResponse();

        await moolreDisbursementWebhook(req, res);

        expect(io.to).toHaveBeenNthCalledWith(1, 'user_404');
        expect(io.to).toHaveBeenNthCalledWith(2, 'user_404');
        expect(io.to).toHaveBeenNthCalledWith(3, 'admin_spy');

        expect(userEmit).toHaveBeenNthCalledWith(1, 'withdrawal_progress', expect.objectContaining({
            reference: 'withdrawal-contract-2',
            status: 'COMPLETED',
            stage: 'COMPLETED',
            pct: 100,
            providerTxId: 'moolre-tx-2',
        }));
        expect(userEmit).toHaveBeenNthCalledWith(2, 'withdrawal_settled', expect.objectContaining({
            reference: 'withdrawal-contract-2',
            status: 'COMPLETED',
            providerTxId: 'moolre-tx-2',
            changed: true,
        }));
        expect(adminEmit).toHaveBeenCalledWith('admin_alert', expect.objectContaining({
            type: 'WITHDRAWAL_SETTLED',
            reference: 'withdrawal-contract-2',
            status: 'COMPLETED',
            providerTxId: 'moolre-tx-2',
            changed: true,
        }));
        expect(userEmit.mock.calls.map(([event]) => event)).toEqual([
            'withdrawal_progress',
            'withdrawal_settled',
        ]);
    });
});
