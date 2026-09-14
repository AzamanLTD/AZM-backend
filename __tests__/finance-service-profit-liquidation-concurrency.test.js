const { liquidateProfits } = require('../services/finance.service');

describe('liquidateProfits concurrency guard', () => {
  test('only one concurrent liquidation can claim the same profit funds', async () => {
    let profitBalance = 10;
    let fiatPoolBalance = 0;
    let profitLogCount = 0;

    const tx = {
      systemProfitFees: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(async ({ where, data }) => {
          expect(where).toEqual({ id: 1, balance: { gte: 10 } });
          if (profitBalance < 10) return { count: 0 };
          profitBalance -= Number(data.balance.decrement);
          return { count: 1 };
        }),
        findUnique: jest.fn(async () => ({ balance: profitBalance })),
      },
      systemFiatPool: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn(async ({ data }) => {
          fiatPoolBalance += Number(data.balance.increment);
          return { id: 1, balance: fiatPoolBalance };
        }),
        findUnique: jest.fn(async () => ({ balance: fiatPoolBalance })),
      },
      adminProfitLog: {
        create: jest.fn(async ({ data }) => {
          profitLogCount += 1;
          return { id: `log-${profitLogCount}`, ...data };
        }),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const results = await Promise.allSettled([
      liquidateProfits(prisma, 10, 101),
      liquidateProfits(prisma, 10, 202),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'INSUFFICIENT_PROFIT_BALANCE' });
    expect(profitBalance).toBe(0);
    expect(fiatPoolBalance).toBe(10);
    expect(profitLogCount).toBe(1);
    expect(tx.systemProfitFees.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.systemFiatPool.update).toHaveBeenCalledTimes(1);
    expect(tx.adminProfitLog.create).toHaveBeenCalledTimes(1);
  });

  test('rejects an over-sized liquidation without mutating the fiat pool or audit log', async () => {
    const tx = {
      systemProfitFees: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      systemFiatPool: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn(),
      },
      adminProfitLog: {
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    await expect(liquidateProfits(prisma, 11, 303))
      .rejects
      .toMatchObject({ code: 'INSUFFICIENT_PROFIT_BALANCE' });

    expect(tx.systemFiatPool.update).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
  });
});
