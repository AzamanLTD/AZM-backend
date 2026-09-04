jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));

const { completeFiatWithdrawal, reverseFiatWithdrawal } = require('../services/finance.service');

describe('fiat withdrawal settlement economics', () => {
  const deferredPending = (overrides = {}) => ({
    id: 'tx-1',
    txHash: 'SETTLE-1',
    type: 'WITHDRAWAL_FIAT',
    status: 'PENDING',
    userId: 7,
    amountUsdc: 10,
    feeUsdc: 0.2,
    providerRef: null,
    metadata: {
      economicsDeferred: true,
      referrerId: 99,
      referrerShareUsdc: 0.1,
      systemFeeShareUsdc: 0.1,
      retailRate: 13,
      payoutGhs: 130,
    },
    ...overrides,
  });

  test('provider success realizes deferred referral, fee and profit exactly after the PENDING claim', async () => {
    const pending = deferredPending();
    const completed = { ...pending, status: 'COMPLETED', providerRef: 'provider-1' };
    const tx = {
      transactionHistory: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(pending)
          .mockResolvedValueOnce(completed),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      systemProfitFees: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        update: jest.fn().mockResolvedValue({}),
      },
      adminProfitLog: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        create: jest.fn().mockResolvedValue({ id: 'log' }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const result = await completeFiatWithdrawal(prisma, 'SETTLE-1', { providerTxId: 'provider-1' });

    expect(tx.transactionHistory.updateMany).toHaveBeenCalledWith({
      where: { txHash: 'SETTLE-1', status: 'PENDING' },
      data: { status: 'COMPLETED', providerRef: 'provider-1' },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { availableBalance: { increment: 0.1 } },
    });
    expect(tx.systemProfitFees.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { balance: { increment: 0.1 } },
    });
    expect(tx.adminProfitLog.createMany).toHaveBeenCalledWith({
      data: [
        { amountUsdc: 0.1, source: 'EXIT_FEE', relatedTxId: 'referral_split_system_SETTLE-1' },
        { amountUsdc: 0.1, source: 'EXIT_FEE', relatedTxId: 'referral_split_referrer_99_SETTLE-1' },
      ],
    });
    expect(tx.adminProfitLog.create).toHaveBeenCalledWith({
      data: { amountUsdc: 10, source: 'ARBITRAGE_SPREAD', relatedTxId: 'arbitrage_capture_SETTLE-1' },
    });
    expect(result).toMatchObject({ status: 'COMPLETED', changed: true, providerTxId: 'provider-1' });
  });

  test('a losing duplicate success claim never realizes economics twice', async () => {
    const completed = deferredPending({ status: 'COMPLETED', providerRef: 'provider-1' });
    const tx = {
      transactionHistory: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(completed)
          .mockResolvedValueOnce(completed),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      systemProfitFees: { upsert: jest.fn(), update: jest.fn() },
      user: { update: jest.fn() },
      adminProfitLog: { createMany: jest.fn(), create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };

    const result = await completeFiatWithdrawal(prisma, 'SETTLE-1', { providerTxId: 'provider-1' });

    expect(result.changed).toBe(false);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.systemProfitFees.update).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.createMany).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
  });

  test('legacy PENDING success transitions without double-recognizing old request-time economics', async () => {
    const legacy = deferredPending({ metadata: null, txHash: 'LEGACY-1' });
    const completed = { ...legacy, status: 'COMPLETED' };
    const tx = {
      transactionHistory: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(legacy)
          .mockResolvedValueOnce(completed),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      systemProfitFees: { upsert: jest.fn(), update: jest.fn() },
      user: { update: jest.fn() },
      adminProfitLog: { createMany: jest.fn(), create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };

    const result = await completeFiatWithdrawal(prisma, 'LEGACY-1');

    expect(result.changed).toBe(true);
    expect(tx.systemProfitFees.update).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
  });

  test('provider failure of a deferred withdrawal is a pure reservation unwind with no negative profit event or referral clawback', async () => {
    const pending = deferredPending({ txHash: 'FAIL-1' });
    const tx = {
      transactionHistory: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      systemProfitFees: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ balance: 5 }),
      },
      systemFiatPool: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ balance: 30 }),
      },
      systemMasterCrypto: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ balance: 20 }),
      },
      user: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ availableBalance: 50 }),
      },
      adminProfitLog: {
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    const prisma = {
      transactionHistory: { findUnique: jest.fn().mockResolvedValue(pending) },
      user: { findUnique: jest.fn(), findFirst: jest.fn() },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const result = await reverseFiatWithdrawal(prisma, 'FAIL-1');

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableBalance: { increment: 10.2 } },
    });
    expect(tx.systemFiatPool.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { balance: { increment: 10 } },
    });
    expect(tx.systemMasterCrypto.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { balance: { decrement: 10 } },
    });
    expect(tx.systemProfitFees.update).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.deleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alreadyReversed: false, refundedAmount: 10.2, userId: 7 });
  });
});
