jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/journalIntegration', () => ({}));
jest.mock('../services/vendorGamificationService', () => ({}));
jest.mock('../utils/feeMath', () => ({}));

const { acceptPing } = require('../services/p2p.service');

describe('acceptPing balance concurrency', () => {
  const buildPrisma = ({ updateCount = 1 } = {}) => {
    const tx = {
      user: {
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
        findUnique: jest.fn().mockResolvedValue({
          availableBalance: 40,
          vendorUnallocatedBalance: 60,
        }),
      },
    };
    const prisma = {
      trade: {
        findUnique: jest.fn().mockResolvedValue({
          id: 101,
          status: 'PENDING_PAYMENT',
          vendorId: 7,
          userId: 8,
          amountCrypto: 25,
        }),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    return { prisma, tx };
  };

  test('moves funds with a database conditional debit and returns fresh balances', async () => {
    const { prisma, tx } = buildPrisma();

    const result = await acceptPing(prisma, {
      tradeId: 101,
      vendorId: 7,
      topUpAmount: 10,
    });

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 7,
        availableBalance: { gte: 10 },
      },
      data: {
        availableBalance: { decrement: 10 },
        vendorUnallocatedBalance: { increment: 10 },
      },
    });
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { availableBalance: true, vendorUnallocatedBalance: true },
    });
    expect(result).toMatchObject({
      newAvailableBalance: 40,
      newVendorUnallocatedBalance: 60,
    });
  });

  test('fails when another concurrent top-up consumes the available balance first', async () => {
    const { prisma, tx } = buildPrisma({ updateCount: 0 });

    await expect(acceptPing(prisma, {
      tradeId: 101,
      vendorId: 7,
      topUpAmount: 10,
    })).rejects.toThrow('Funds changed; please retry');

    expect(tx.user.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.user.findUnique).not.toHaveBeenCalled();
  });
});
