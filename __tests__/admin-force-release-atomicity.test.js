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
jest.mock('../services/feeProfileService', () => ({
    resolveFeeProfile: jest.fn().mockResolvedValue({
        platformFeePct: 1, adminSplitPct: 0.5, vendorSplitPct: 0.5
    }),
}));

const p2pService = require('../services/p2p.service');

function makeTx(overrides = {}) {
    const defaults = {
        trade: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        user: { update: jest.fn().mockResolvedValue({}) },
        systemProfitFees: {
            upsert: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({}),
        },
        adminProfitLog: { create: jest.fn().mockResolvedValue({}) },
        transactionHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    return { ...defaults, ...overrides };
}

function makePrisma(trade, tx) {
    return {
        trade: { findUnique: jest.fn().mockResolvedValue(trade) },
        globalSettings: { findUnique: jest.fn().mockResolvedValue({
            p2pFeePct: 1, tierThreshold: 1000,
            vendorShareUnder1k: 0.5, vendorShareOver1k: 0.4
        }) },
        $transaction: jest.fn(async (cb) => cb(tx)),
    };
}

const baseTrade = (overrides = {}) => ({
    id: 100, status: 'DISPUTED', type: 'SELL',
    vendorId: 7, userId: 9,
    amountCrypto: 100, amountFiat: 100, rate: 1,
    paymentMethod: 'BANK_TRANSFER',
    ...overrides,
});

describe('Admin force-release atomicity (issue #48)', () => {
    describe('completeTrade with adminOverride', () => {
        test('settles a DISPUTED trade in one atomic transaction', async () => {
            const trade = baseTrade({ id: 100, status: 'DISPUTED' });
            const tx = makeTx();
            const prisma = makePrisma(trade, tx);

            await p2pService.completeTrade(prisma, {
                tradeId: 100, releasedByUserId: 7, adminOverride: true
            });

            // Single atomic claim: DISPUTED → COMPLETED
            expect(tx.trade.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 100, status: 'DISPUTED' },
                    data: expect.objectContaining({ status: 'COMPLETED' })
                })
            );

            // Settlement mutations all ran
            expect(tx.user.update).toHaveBeenCalledTimes(2);
            expect(tx.systemProfitFees.update).toHaveBeenCalledTimes(1);
            expect(tx.adminProfitLog.create).toHaveBeenCalledTimes(1);
            expect(tx.transactionHistory.create).toHaveBeenCalledTimes(1);

            // Only one transaction was used
            expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        });

        test('rejects DISPUTED trade without adminOverride', async () => {
            const trade = baseTrade({ id: 101, status: 'DISPUTED' });
            const prisma = { trade: { findUnique: jest.fn().mockResolvedValue(trade) } };

            await expect(p2pService.completeTrade(prisma, { tradeId: 101, releasedByUserId: 7 }))
                .rejects.toThrow('status must be PAID');
        });

        test('rejects PAID trade with adminOverride', async () => {
            const trade = baseTrade({ id: 102, status: 'PAID' });
            const prisma = { trade: { findUnique: jest.fn().mockResolvedValue(trade) } };

            await expect(p2pService.completeTrade(prisma, { tradeId: 102, releasedByUserId: 7, adminOverride: true }))
                .rejects.toThrow('status must be DISPUTED');
        });

        test('bypasses counterparty authorization with adminOverride', async () => {
            const trade = baseTrade({ id: 103, status: 'DISPUTED' });
            const tx = makeTx();
            const prisma = makePrisma(trade, tx);

            // Pass a releasedByUserId that would normally be rejected (not the vendor)
            const result = await p2pService.completeTrade(prisma, {
                tradeId: 103, releasedByUserId: 999, adminOverride: true
            });

            expect(tx.trade.updateMany).toHaveBeenCalled();
            expect(result).toBeTruthy();
        });

        test('concurrent admin calls produce one winner and one 409', async () => {
            const trade = baseTrade({ id: 104, status: 'DISPUTED' });
            let callCount = 0;
            const tx = makeTx({
                trade: {
                    updateMany: jest.fn().mockImplementation(() => {
                        callCount++;
                        return Promise.resolve({ count: callCount === 1 ? 1 : 0 });
                    }),
                },
            });
            const prisma = makePrisma(trade, tx);

            // First call wins
            const r1 = await p2pService.completeTrade(prisma, { tradeId: 104, releasedByUserId: 7, adminOverride: true });
            expect(r1).toBeTruthy();

            // Second call gets TRADE_ALREADY_FINALIZED
            await expect(p2pService.completeTrade(prisma, { tradeId: 104, releasedByUserId: 7, adminOverride: true }))
                .rejects.toThrow('TRADE_ALREADY_FINALIZED');
        });

        test('failed settlement leaves trade DISPUTED (full rollback)', async () => {
            const trade = baseTrade({ id: 105, status: 'DISPUTED' });
            const tx = makeTx({
                adminProfitLog: { create: jest.fn().mockRejectedValue(new Error('DB_CONNECTION_LOST')) },
            });
            const prisma = {
                trade: { findUnique: jest.fn().mockResolvedValue(trade) },
                globalSettings: { findUnique: jest.fn().mockResolvedValue({
                    p2pFeePct: 1, tierThreshold: 1000,
                    vendorShareUnder1k: 0.5, vendorShareOver1k: 0.4
                }) },
                $transaction: jest.fn(async (cb) => { await cb(tx); }),
            };

            // The transaction throws because AdminProfitLog create fails
            await expect(p2pService.completeTrade(prisma, { tradeId: 105, releasedByUserId: 7, adminOverride: true }))
                .rejects.toThrow();
        });

        test('normal user completeTrade behavior unchanged (PAID → COMPLETED)', async () => {
            const trade = baseTrade({ id: 106, status: 'PAID' });
            const tx = makeTx();
            const prisma = makePrisma(trade, tx);

            const result = await p2pService.completeTrade(prisma, { tradeId: 106, releasedByUserId: 7 });

            // Claims PAID → COMPLETED (not DISPUTED)
            expect(tx.trade.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 106, status: 'PAID' },
                })
            );
            expect(result).toBeTruthy();
        });

        test('normal user cannot release a DISPUTED trade', async () => {
            const trade = baseTrade({ id: 107, status: 'DISPUTED' });
            const prisma = { trade: { findUnique: jest.fn().mockResolvedValue(trade) } };

            await expect(p2pService.completeTrade(prisma, { tradeId: 107, releasedByUserId: 7 }))
                .rejects.toThrow('status must be PAID');
        });

        test('BUY direction: admin override settles correctly', async () => {
            const trade = baseTrade({ id: 108, status: 'DISPUTED', type: 'BUY' });
            const tx = makeTx();
            const prisma = makePrisma(trade, tx);

            await p2pService.completeTrade(prisma, {
                tradeId: 108, releasedByUserId: 9, adminOverride: true
            });

            expect(tx.trade.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 108, status: 'DISPUTED' },
                    data: expect.objectContaining({ status: 'COMPLETED' })
                })
            );
            expect(tx.user.update).toHaveBeenCalledTimes(2);
        });
    });
});
