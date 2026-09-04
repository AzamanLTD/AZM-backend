jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));

const { processFiatWithdrawal } = require('../services/finance.service');

describe('processFiatWithdrawal customer balance concurrency guard', () => {
  const buildPrisma = ({ userClaimCount = 1, referrer = null } = {}) => {
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
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'tx', ...data })),
      },
    };

    const prisma = {
      user: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(referrer ? { referredByCode: 'REFCODE' } : { referredByCode: null })
          .mockResolvedValueOnce({ withdrawalRiskTier: 'STANDARD' }),
        findFirst: jest.fn().mockResolvedValue(referrer),
      },
      globalSettings: {
        findUnique: jest.fn().mockResolvedValue({
          liveRetailRate: 13.25,
          liveUsdToGhs: 13.10,
          liveRateSource: 'KOTANI_PAY',
          lastRateSync: '2026-09-04T11:30:00.000Z',
        }),
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

  test('derives the GHS payout from liveRetailRate rather than treating USDC as GHS', async () => {
    const { prisma, tx } = buildPrisma();

    await processFiatWithdrawal(prisma, 7, 20, { reference: 'RATE-1' });

    expect(tx.transactionHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountUsdc: 20,
        metadata: expect.objectContaining({
          retailRate: 13.25,
          payoutGhs: 265,
          rateSource: 'KOTANI_PAY',
          ratePair: 'USDC/GHS',
          settlementCurrency: 'USDC',
          displayCurrency: 'GHS',
        }),
      }),
    });
  });

  test('stores settlement economics but does not realize fees or referral rewards while PENDING', async () => {
    const referrer = { id: 99, username: 'ref-user' };
    const { prisma, tx } = buildPrisma({ referrer });

    await processFiatWithdrawal(prisma, 7, 20, {
      reference: 'BAL-DEFER',
      retailRate: 13.25,
      payoutGhs: 265,
    });

    expect(tx.transactionHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        txHash: 'BAL-DEFER',
        status: 'PENDING',
        metadata: expect.objectContaining({
          economicsDeferred: true,
          referrerId: 99,
          referrerShareUsdc: 0.2,
          systemFeeShareUsdc: 0.2,
          retailRate: 13.25,
          payoutGhs: 265,
        }),
      }),
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.systemProfitFees.update).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.createMany).not.toHaveBeenCalled();
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
