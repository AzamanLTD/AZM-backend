jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));

const { processFiatWithdrawal } = require('../services/finance.service');

describe('processFiatWithdrawal fiat-pool concurrency guard', () => {
  const buildPrisma = ({ poolClaimCount = 1 } = {}) => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 7, availableBalance: 100, withdrawalRiskTier: 'STANDARD' }),
        update: jest.fn().mockResolvedValue({}),
      },
      systemFiatPool: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: poolClaimCount }),
        findUnique: jest.fn().mockResolvedValue({ balance: 40 }),
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

  test('reserves the pool with a conditional atomic decrement before ledger mutation', async () => {
    const { prisma, tx } = buildPrisma();

    const result = await processFiatWithdrawal(prisma, 7, 10, {
      reference: 'REF-1',
      payoutGhs: 130,
      retailRate: 13,
    });

    expect(tx.systemFiatPool.updateMany).toHaveBeenCalledWith({
      where: { id: 1, balance: { gte: 10 } },
      data: { balance: { decrement: 10 } },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableBalance: { decrement: 10.2 } },
    });
    expect(result.reference).toBe('REF-1');
  });

  test('fails with a stable liquidity error when another withdrawal wins the race', async () => {
    const { prisma, tx } = buildPrisma({ poolClaimCount: 0 });

    await expect(processFiatWithdrawal(prisma, 7, 10, { reference: 'REF-2' }))
      .rejects
      .toMatchObject({ code: 'FIAT_POOL_INSUFFICIENT' });

    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
    expect(tx.transactionHistory.create).not.toHaveBeenCalled();
  });
});
