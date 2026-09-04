jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));

const { reverseFiatWithdrawal, processCryptoDeposit } = require('../services/finance.service');

describe('finance reversal and crypto deposit idempotency', () => {
  test('does not reverse an already completed fiat withdrawal', async () => {
    const prisma = {
      transactionHistory: {
        findUnique: jest.fn().mockResolvedValue({
          txHash: 'DONE-1',
          type: 'WITHDRAWAL_FIAT',
          status: 'COMPLETED',
          userId: 7,
          amountUsdc: 10,
          feeUsdc: 0.2,
        }),
      },
      $transaction: jest.fn(),
    };

    const result = await reverseFiatWithdrawal(prisma, 'DONE-1', { reason: 'late failure' });

    expect(result).toEqual({
      reference: 'DONE-1',
      alreadyReversed: true,
      notReversible: true,
      status: 'COMPLETED',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('claims only PENDING withdrawals when reversing a deferred reservation', async () => {
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
        findUnique: jest.fn().mockResolvedValue({ balance: 20 }),
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
      transactionHistory: {
        findUnique: jest.fn().mockResolvedValue({
          txHash: 'PENDING-1',
          type: 'WITHDRAWAL_FIAT',
          status: 'PENDING',
          userId: 7,
          amountUsdc: 10,
          feeUsdc: 0.2,
          metadata: { economicsDeferred: true },
        }),
      },
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    await reverseFiatWithdrawal(prisma, 'PENDING-1');

    expect(tx.transactionHistory.updateMany).toHaveBeenCalledWith({
      where: { txHash: 'PENDING-1', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    expect(tx.systemProfitFees.update).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
    expect(tx.adminProfitLog.deleteMany).not.toHaveBeenCalled();
  });

  test('duplicate crypto webhook is fenced by the transaction and existing txHash', async () => {
    const tx = {
      transactionHistory: {
        findUnique: jest.fn().mockResolvedValue({ id: 'existing', txHash: 'CHAIN-1' }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const result = await processCryptoDeposit(prisma, {
      userId: 7,
      amountUsdc: 25,
      txHash: 'CHAIN-1',
    });

    expect(result).toEqual({ alreadyProcessed: true });
  });

  test('duplicate crypto webhook that wins the race on unique txHash is treated as idempotent', async () => {
    const tx = {
      transactionHistory: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 7, availableBalance: 0 }),
        update: jest.fn(),
      },
      systemMasterCrypto: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      systemHotWallet: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const result = await processCryptoDeposit(prisma, {
      userId: 7,
      amountUsdc: 25,
      txHash: 'CHAIN-RACE',
    });

    expect(result).toEqual({ alreadyProcessed: true });
  });
});
