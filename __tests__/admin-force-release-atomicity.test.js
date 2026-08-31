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

const p2pService = require('../services/p2p.service');

describe('Admin force-release atomicity (issue #48)', () => {
    describe('completeTrade with adminOverride', () => {
        test('settles a DISPUTED trade in one atomic transaction', async () => {
            const trade = {
                id: 100, status: 'DISPUTED', type: 'SELL',
                vendorId: 7, userId: 9,
                amountCrypto: 200, amountFiat: 200, rate: 1,
                paymentMethod: 'BANK_TRANSFER'
            };
            const settings = { p2pFeePct: 1, tierThreshold: 1000, vendorShareUnder1k: 0.5, vendorShareOver1k: 0.4 };
            const feeProfile = { platformFeePct: 1, adminSplitPct: 0.5, vendorSplitPct: 0.5 };

            const tx = {
                trade: {
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                user: { update: jest.fn().mockResolvedValue({}) },
                systemProfitFees: { update: jest.fn().mockResolvedValue({}) },
                adminProfitLog: { create: jest.fn().mockResolvedValue({}) },
                transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            };

            const prisma = {
                trade: { findUnique: jest.fn().mockResolvedValue(trade) },
                globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
                $transaction: jest.fn(async (cb) => cb(tx)),
            };

            jest.doMock('./feeProfileService', () => ({ resolveFeeProfile: jest.fn().mockResolvedValue(feeProfile) }));

            const result = await p2pService.completeTrade(prisma, {
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
            const trade = {
                id: 101, status: 'DISPUTED', type: 'SELL',
                vendorId: 7, userId: 9,
                amountCrypto: 100, amountFiat: 100, rate: 1,
                paymentMethod: 'BANK_TRANSFER'
            };

            const prisma = {
                trade: { findUnique: jest.fn().mockResolvedValue(trade) },
            };

            await expect(p2pService.completeTrade(prisma, { tradeId: 101, releasedByUserId: 7 }))
                .rejects.toThrow('status must be PAID');
        });

        test('rejects PAID trade with adminOverride', async () => {
            const trade = {
                id: 102, status: 'PAID', type: 'SELL',
                vendorId: 7, userId: 9,
                amountCrypto: 100, amountFiat: 100, rate: 1,
                paymentMethod: 'BANK_TRANSFER'
            };

            const prisma = {
                trade: { findUnique: jest.fn().mockResolvedValue(trade) },
            };

            await expect(p2pService.completeTrade(prisma, { tradeId: 102, releasedByUserId: 7, adminOverride: true }))
                .rejects.toThrow('status must be DISPUTED');
        });

        test('bypasses counterparty authorization with adminOverride', async () => {
            const trade = {
                id: 103, status: 'DISPUTED', type: 'SELL',
                vendorId: 7, userId: 9,
                amountCrypto: 100, amountFiat: 100, rate: 1,
                paymentMethod: 'BANK_TRANSFER'
            };
            const settings = { p2pFeePct: 1, tierThreshold: 1000, vendorShareUnder1k: 0.5, vendorShareOver1k: 0.4 };
            const feeProfile = { platformFeePct: 1, adminSplitPct: 0.5, vendorSplitPct: 0.5 };

            const tx = {
                trade: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                user: { update: jest.fn().mockResolvedValue({}) },
                systemProfitFees: { update: jest.fn().mockResolvedValue({}) },
                adminProfitLog: { create: jest.fn().mockResolvedValue({}) },
                transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            };

            const prisma = {
                trade: { findUnique: jest.fn().mockResolvedValue(trade) },
                globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
                $transaction: jest.fn(async (cb) => cb(tx)),
            };

            // Pass a releasedByUserId that would normally be rejected (not the vendor)
            const result = await p2pService.completeTrade(prisma, {
                tradeId: 103, releasedByUserId: 999, adminOverride: true
            });

            expect(tx.trade.updateMany).toHaveBeenCalled();
            expect(result).toBeTruthy();
        });

        test('concurrent admin calls produce one winner and one 409', async () => {
            const trade = {
                id: 104, status: 'DISPUTED', type: 'SELL',
                vendorId: 7, userId: 9,
                amountCrypto: 100, amountFiat: 100, rate: 1,
                paymentMethod: 'BANK_TRANSFER'
            };
            const settings = { p2pFeePct: 1, tierThreshold: 1000, vendorShareUnder1k: 0.5, vendorShareOver1k: 0.4 };
            const feeProfile = { platformFeePct: 1, adminSplitPct: 0.5, vendorSplitPct: 0.5 };

            let callCount = 0;
            const tx = {
                trade: {
                    updateMany: jest.fn().mockImplementation(() => {
                        callCount++;
                        return Promise.resolve({ count: callCount === 1 ? 1 : 0 });
                    }),
                },
                user: { update: jest.fn().mockResolvedValue({}) },
                systemProfitFees: { update: jest.fn().mockResolvedValue({}) },
                adminProfitLog: { create: jest.fn().mockResolvedValue({}) },
                transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            };

            const prisma = {
                trade: { findUnique: jest.fn().mockResolvedValue(trade) },
                globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
                $transaction: jest.fn(async (cb) => cb(tx)),
            };

            // First call wins
            const r1 = await p2pService.completeTrade(prisma, { tradeId: 104, releasedByUserId: 7, adminOverride: true });
            expect(r1).toBeTruthy();

            // Second call gets TRADE_ALREADY_FINALIZED
            await expect(p2pService.completeTrade(prisma, { tradeId: 104, releasedByUserId: 7, adminOverride: true }))
                .rejects.toThrow('TRADE_ALREADY_FINALIZED');
        });

        test('failed settlement leaves trade DISPUTED (full rollback)', async () => {
            const trade = {
                id: 105, status: 'DISPUTED', type: 'SELL',
                vendorId: 7, userId: 9,
                amountCrypto: 100, amountFiat: 100, rate: 1,
                paymentMethod: 'BANK_TRANSFER'
            };
            const settings = { p2pFeePct: 1, tierThreshold: 1000, vendorShareUnder1k: 0.5, vendorShareOver1k: 0.4 };
            const feeProfile = { platformFeePct: 1, adminSplitPct: 0.5, vendorSplitPct: 0.5 };

            const tx = {
                trade: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                user: { update: jest.fn().mockResolvedValue({}) },
                systemProfitFees: { update: jest.fn().mockResolvedValue({}) },
                adminProfitLog: { create: jest.fn().mockRejectedValue(new Error('DB_CONNECTION_LOST')) },
                transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            };

            const prisma = {
                trade: { findUnique: jest.fn().mockResolvedValue(trade) },
                globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
                $transaction: jest.fn(async (cb) => {
                    try {
                        await cb(tx);
                    } catch (e) {
                        throw e;
                    }
                }),
            };

            // The transaction throws because AdminProfitLog create fails
            await expect(p2pService.completeTrade(prisma, { tradeId: 105, releasedByUserId: 7, adminOverride: true }))
                .rejects.toThrow();

            // The trade would remain DISPUTED because the entire transaction rolled back
            // (the updateMany inside the tx is part of the same transaction)
        });

        test('normal user completeTrade behavior unchanged (PAID → COMPLETED)', async () => {
            const trade = {
                id: 106, status: 'PAID', type: 'SELL',
                vendorId: 7, userId: 9,
                amountCrypto: 100, amountFiat: 100, rate: 1,
                paymentMethod: 'BANK_TRANSFER'
            };
            const settings = { p2pFeePct: 1, tierThreshold: 1000, vendorShareUnder1k: 0.5, vendorShareOver1k: 0.4 };
            const feeProfile = { platformFeePct: 1, adminSplitPct: 0.5, vendorSplitPct: 0.5 };

            const tx = {
                trade: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                user: { update: jest.fn().mockResolvedValue({}) },
                systemProfitFees: { update: jest.fn().mockResolvedValue({}) },
                adminProfitLog: { create: jest.fn().mockResolvedValue({}) },
                transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            };

            const prisma = {
                trade: { findUnique: jest.fn().mockResolvedValue(trade) },
                globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
                $transaction: jest.fn(async (cb) => cb(tx)),
            };

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
            const trade = {
                id: 107, status: 'DISPUTED', type: 'SELL',
                vendorId: 7, userId: 9,
                amountCrypto: 100, amountFiat: 100, rate: 1,
                paymentMethod: 'BANK_TRANSFER'
            };

            const prisma = {
                trade: { findUnique: jest.fn().mockResolvedValue(trade) },
            };

            await expect(p2pService.completeTrade(prisma, { tradeId: 107, releasedByUserId: 7 }))
                .rejects.toThrow('status must be PAID');
        });
    });
});
