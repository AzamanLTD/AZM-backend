jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));

const { processFiatWithdrawal } = require('../services/finance.service');

describe('processFiatWithdrawal customer balance concurrency guard', () => {
  const buildPrisma = ({ userClaimCount = 1 } = {}) => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 7, availableBalance: 20.4, withdrawalRiskTier: 'STANDARD' }),
        updateMany: jest.fn().mockResolvedValue({ count: userClaimCount }),
        update: jest.fn().mockResolvedValue({}),
      },
      systemFiatPool: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ balance: 40 }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      systemProfitFees: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ balance: 2 }),
      },
      systemMasterCrypto: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ balance: 20 }),
      },
      adminProfitLog: {
        createMany: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: 'log' }),
      },
      transactionHistory: {
        create: jest.fn().mockResolvedValue({ id: 'tx', status: 'PENDING' }),
      },
    };

    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ referredByCode: null }),
        findFirst: jest.fn(),
      },
      globalSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      systemFiatPool: {
        findUnique: jest.fn().mockResolvedValue({ balance: 40 }),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    return { prisma, tx };
  };

  test('uses a conditional balance debit instead of trusting the snapshot', async () => {
    const { prisma, tx } = buildPrisma();

    await processFiatWithdrawal(prisma, 7, 20, { reference: 'BAL-1' });

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, availableBalance: { gte: 20.4 } },
      data: { availableBalance: { decrement: 20.4 } },
    });
    expect(tx.transactionHistory.create).toHaveBeenCalled();
  });

  test('aborts the withdrawal when the conditional customer debit loses the race', async () => {
    const { prisma, tx } = buildPrisma({ userClaimCount: 0 });

    await expect(processFiatWithdrawal(prisma, 7, 20, { reference: 'BAL-2' }))
      .rejects
      .toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

    expect(tx.transactionHistory.create).not.toHaveBeenCalled();
    expect(tx.systemMasterCrypto.update).not.toHaveBeenCalled();
  });
});
