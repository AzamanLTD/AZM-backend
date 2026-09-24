jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));

// §P.5-D: the GHS liquidity authority is not under test here — the regime
// wrappers report "no reservation row" (legacy regime), so the legacy
// SystemFiatPool behavior under test is exercised unchanged.
jest.mock('../src/services/fiatLiquidityService', () => ({
    isAuthorityEnabled: jest.fn().mockResolvedValue(false),
    reserveForPayout: jest.fn(),
    releaseIfRecorded: jest.fn().mockResolvedValue({ skipped: true }),
    settleIfRecorded: jest.fn().mockResolvedValue({ skipped: true }),
    inTransitIfRecorded: jest.fn().mockResolvedValue({ skipped: true }),
}));

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
      azmSpendLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
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
    // r39: settlement economics carry EXACT Decimals.
    expect(tx.user.update.mock.calls[0][0].where).toEqual({ id: 99 });
    expect(tx.user.update.mock.calls[0][0].data.availableBalance.increment.toFixed(8)).toBe('0.10000000');
    expect(tx.systemProfitFees.update.mock.calls[0][0].where).toEqual({ id: 1 });
    expect(tx.systemProfitFees.update.mock.calls[0][0].data.balance.increment.toFixed(8)).toBe('0.10000000');
    const split = tx.adminProfitLog.createMany.mock.calls[0][0].data;
    expect(split[0].amountUsdc.toFixed(8)).toBe('0.10000000');
    expect(split[0].source).toBe('EXIT_FEE');
    expect(split[0].relatedTxId).toBe('referral_split_system_SETTLE-1');
    expect(split[1].amountUsdc.toFixed(8)).toBe('0.10000000');
    expect(split[1].source).toBe('EXIT_FEE');
    expect(split[1].relatedTxId).toBe('referral_split_referrer_99_SETTLE-1');
    const capture = tx.adminProfitLog.create.mock.calls[0][0].data;
    expect(capture.amountUsdc.toFixed(8)).toBe('10.00000000');
    expect(capture.source).toBe('ARBITRAGE_SPREAD');
    expect(capture.relatedTxId).toBe('arbitrage_capture_SETTLE-1');
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
      azmSpendLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const prisma = {
      transactionHistory: { findUnique: jest.fn().mockResolvedValue(pending) },
      user: { findUnique: jest.fn(), findFirst: jest.fn() },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const result = await reverseFiatWithdrawal(prisma, 'FAIL-1');

    // r39: the unwind carries EXACT Decimals.
    const refund = tx.user.update.mock.calls[0][0];
    expect(refund.where).toEqual({ id: 7 });
    expect(refund.data.availableBalance.increment.toFixed(8)).toBe('10.20000000');
    const pool = tx.systemFiatPool.update.mock.calls[0][0];
    expect(pool.where).toEqual({ id: 1 });
    expect(pool.data.balance.increment.toFixed(8)).toBe('10.00000000');
    const master = tx.systemMasterCrypto.update.mock.calls[0][0];
    expect(master.where).toEqual({ id: 1 });
    expect(master.data.balance.decrement.toFixed(8)).toBe('10.00000000');
    expect(tx.systemProfitFees.update).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.deleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alreadyReversed: false, userId: 7 });
    expect(result.refundedAmount.toFixed(8)).toBe('10.20000000'); // r39: exact Decimal refund
  });
});
