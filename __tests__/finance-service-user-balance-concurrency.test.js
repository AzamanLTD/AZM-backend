jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/ledgerService', () => ({ post: jest.fn().mockResolvedValue({ id: 'j1', transaction: { id: 'lt1' } }), accountBalance: jest.fn(), // r39/P1: real exact-decimal parser surface kept in the mock.
toExactDecimal: (v) => new (require('@prisma/client').Prisma).Decimal(String(v)) }));
jest.mock('../services/restrictedObligationService', () => ({
    createForPendingWithdrawal: jest.fn().mockResolvedValue({ id: 'o1' }),
    releaseOnSettlement: jest.fn().mockResolvedValue(undefined),
    cancelOnReversal: jest.fn().mockResolvedValue(undefined),
}));

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
        findUnique: jest.fn().mockResolvedValue({ id: 'tx' }),
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

    // r39: the service decrements with an EXACT Decimal (serialized "20.4"),
    // never a binary float.
    const D = require('@prisma/client').Prisma.Decimal;
    const debit = tx.user.updateMany.mock.calls[0][0];
    expect(debit.where).toEqual({ id: 7, availableBalance: { gte: new D('20.4') } });
    expect(debit.data.availableBalance.decrement.toFixed(8)).toBe('20.40000000');
    expect(tx.transactionHistory.create).toHaveBeenCalled();
  });

  test('derives the GHS payout from liveRetailRate rather than treating USDC as GHS', async () => {
    const { prisma, tx } = buildPrisma();

    await processFiatWithdrawal(prisma, 7, 20, { reference: 'RATE-1' });

    // r39: the canonical row carries EXACT Decimals for the money columns
    // (serialized as exact decimal strings, never binary floats).
    const create = tx.transactionHistory.create.mock.calls[0][0];
    expect(create.data.amountUsdc.toFixed(8)).toBe('20.00000000');
    expect(create.data.feeUsdc.toFixed(8)).toBe('0.40000000');
    expect(create.data.metadata).toMatchObject({
      retailRate: 13.25,
      payoutGhs: '265.00',
      rateSource: 'KOTANI_PAY',
      ratePair: 'USDC/GHS',
      settlementCurrency: 'USDC',
      displayCurrency: 'GHS',
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
          referrerShareUsdc: '0.20000000', // r39: exact strings in metadata
          systemFeeShareUsdc: '0.20000000',
          retailRate: 13.25,
          payoutGhs: '265.00',
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
