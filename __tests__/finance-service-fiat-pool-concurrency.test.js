jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/ledgerService', () => ({ post: jest.fn().mockResolvedValue({ id: 'j1', transaction: { id: 'lt1' } }), accountBalance: jest.fn(), // r39/P1: real exact-decimal parser surface kept in the mock.
toExactDecimal: (v) => new (require('@prisma/client').Prisma).Decimal(String(v)) }));
jest.mock('../services/restrictedObligationService', () => ({
    createForPendingWithdrawal: jest.fn().mockResolvedValue({ id: 'o1' }),
    releaseOnSettlement: jest.fn().mockResolvedValue(undefined),
    cancelOnReversal: jest.fn().mockResolvedValue(undefined),
}));

const { processFiatWithdrawal } = require('../services/finance.service');

describe('processFiatWithdrawal fiat-pool concurrency guard', () => {
  const buildPrisma = ({ poolClaimCount = 1 } = {}) => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 7, availableBalance: 100, withdrawalRiskTier: 'STANDARD' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
        findUnique: jest.fn().mockResolvedValue({ id: 'tx' }),
      },
    };

    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ referredByCode: null }),
        findFirst: jest.fn(),
      },
      globalSettings: {
        findUnique: jest.fn().mockResolvedValue({
          liveRetailRate: 13,
          liveRateSource: 'KOTANI_PAY',
          lastRateSync: new Date('2026-09-04T00:00:00.000Z'),
        }),
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

    // r39: conditional claims carry EXACT Decimals (serialized "10"/"10.2").
    const poolClaim = tx.systemFiatPool.updateMany.mock.calls[0][0];
    expect(poolClaim.where.id).toBe(1);
    expect(poolClaim.where.balance.gte.toFixed(8)).toBe('10.00000000');
    expect(poolClaim.data.balance.decrement.toFixed(8)).toBe('10.00000000');
    const debit = tx.user.updateMany.mock.calls[0][0];
    expect(debit.where.id).toBe(7);
    expect(debit.where.availableBalance.gte.toFixed(8)).toBe('10.20000000');
    expect(debit.data.availableBalance.decrement.toFixed(8)).toBe('10.20000000');
    expect(result.reference).toBe('REF-1');
  });

  test('fails with a stable liquidity error when another withdrawal wins the race', async () => {
    const { prisma, tx } = buildPrisma({ poolClaimCount: 0 });

    await expect(processFiatWithdrawal(prisma, 7, 10, { reference: 'REF-2' }))
      .rejects
      .toMatchObject({ code: 'FIAT_POOL_INSUFFICIENT' });

    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
    expect(tx.transactionHistory.create).not.toHaveBeenCalled();
  });
});