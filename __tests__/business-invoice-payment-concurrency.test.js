'use strict';

const { payInvoice } = require('../services/businessInvoiceService');

const makeConcurrentPrisma = ({ synchronizeInitialReads = false } = {}) => {
  const state = {
    invoice: {
      id: 'invoice-1',
      status: 'SENT',
      payTxHash: null,
      customerId: 7,
      billTotalUsdc: 100,
      customerPaidUsdc: null,
      businessProfile: { userId: 8, businessName: 'Test Bistro' },
    },
    initialReads: 0,
    releaseInitialReads: null,
    settlementCommitted: null,
    claimCalls: 0,
    balanceClaims: 0,
    balanceMutations: 0,
    historyWrites: 0,
    feeWrites: 0,
    transactionCalls: 0,
  };

  let releaseResolve;
  state.releaseInitialReads = new Promise((resolve) => { releaseResolve = resolve; });

  let settlementResolve;
  state.settlementCommitted = new Promise((resolve) => { settlementResolve = resolve; });

  const snapshotInvoice = () => ({ ...state.invoice, businessProfile: { ...state.invoice.businessProfile } });

  const prisma = {
    globalSettings: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, businessInvoiceFeePct: 0.015 }),
    },
    businessInvoice: {
      findUnique: jest.fn(async () => {
        state.initialReads += 1;
        if (synchronizeInitialReads && state.initialReads === 2) releaseResolve();
        if (synchronizeInitialReads && state.initialReads <= 2) await state.releaseInitialReads;
        if (state.initialReads > 2 && state.invoice.payTxHash && !state.invoice.customerPaidUsdc) {
          await state.settlementCommitted;
        }
        return snapshotInvoice();
      }),
      updateMany: jest.fn(async () => {
        state.claimCalls += 1;
        if (state.claimCalls !== 1) return { count: 0 };
        state.invoice.payTxHash = `INV_PAY_${state.invoice.id}`;
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }) => {
        Object.assign(state.invoice, data, { status: 'PAID' });
        settlementResolve();
        return snapshotInvoice();
      }),
    },
    user: {
      updateMany: jest.fn(async () => {
        state.balanceClaims += 1;
        if (state.balanceClaims === 1) {
          state.balanceMutations += 1;
          return { count: 1 };
        }
        return { count: 0 };
      }),
      update: jest.fn(async () => {
        state.balanceMutations += 1;
        return {};
      }),
    },
    systemProfitFees: {
      upsert: jest.fn(async () => {
        state.feeWrites += 1;
        return {};
      }),
    },
    adminProfitLog: {
      create: jest.fn(async () => {
        state.feeWrites += 1;
        return {};
      }),
    },
    transactionHistory: {
      create: jest.fn(async () => {
        state.historyWrites += 1;
        return {};
      }),
    },
    // §P.4 ledger posting surface — the authoritative settlement posts
    // inside the same (mocked) transaction.
    ledgerAccount: {
      upsert: jest.fn(({ create }) => ({ ...create })),
    },
    ledgerTransaction: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'lt-1', postingHash: 'h' })),
    },
    journalEntry: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (callback) => {
      state.transactionCalls += 1;
      const invoiceBeforeTransaction = {
        payTxHash: state.invoice.payTxHash,
        status: state.invoice.status,
        customerPaidUsdc: state.invoice.customerPaidUsdc,
      };
      try {
        return await callback(prisma);
      } catch (error) {
        // Prisma would roll the entire interactive transaction back. Keep this
        // mock honest by undoing the durable invoice mutation performed before
        // the failing wallet claim so the test verifies the real commit boundary.
        state.invoice.payTxHash = invoiceBeforeTransaction.payTxHash;
        state.invoice.status = invoiceBeforeTransaction.status;
        state.invoice.customerPaidUsdc = invoiceBeforeTransaction.customerPaidUsdc;
        throw error;
      }
    }),
  };

  return { prisma, state };
};

describe('business invoice payment concurrency', () => {
  test('two concurrent payers produce one settlement and one replay', async () => {
    const { prisma, state } = makeConcurrentPrisma({ synchronizeInitialReads: true });

    const results = await Promise.all([
      payInvoice(prisma, { invoiceId: 'invoice-1', customerId: 7 }),
      payInvoice(prisma, { invoiceId: 'invoice-1', customerId: 7 }),
    ]);

    const settlement = results.find((result) => !result.alreadyPaid);
    const replay = results.find((result) => result.alreadyPaid);

    expect(settlement).toBeDefined();
    expect(replay).toBeDefined();
    expect(Number(settlement.customerPays)).toBe(100);
    expect(Number(replay.customerPays)).toBe(100);
    expect(state.claimCalls).toBe(2);
    expect(state.transactionCalls).toBe(2);
    expect(state.balanceClaims).toBe(1);
    expect(state.balanceMutations).toBe(2);
    expect(state.historyWrites).toBe(2);
    expect(state.feeWrites).toBe(2);
    expect(state.invoice.status).toBe('PAID');
    expect(state.invoice.payTxHash).toBe('INV_PAY_invoice-1');
  });

  test('payment fails closed when the atomic wallet claim cannot obtain sufficient funds', async () => {
    const { prisma, state } = makeConcurrentPrisma();
    prisma.user.updateMany.mockImplementationOnce(async () => {
      state.balanceClaims += 1;
      return { count: 0 };
    });

    await expect(payInvoice(prisma, { invoiceId: 'invoice-1', customerId: 7 }))
      .rejects.toThrow('INSUFFICIENT_FUNDS');

    expect(state.balanceClaims).toBe(1);
    expect(state.balanceMutations).toBe(0);
    expect(state.historyWrites).toBe(0);
    expect(state.invoice.payTxHash).toBeNull();
  });

  test('wallet debit is a conditional updateMany claim, never a read-then-unconditional decrement', async () => {
    const { prisma } = makeConcurrentPrisma();

    await payInvoice(prisma, { invoiceId: 'invoice-1', customerId: 7 });

    const [claimArgs] = prisma.user.updateMany.mock.calls;
    const [creditArgs] = prisma.user.update.mock.calls;
    expect(claimArgs[0].where.id).toBe(7);
    expect(claimArgs[0].where.availableBalance.gte.toFixed(8)).toBe('100.00000000');
    expect(claimArgs[0].data.availableBalance.decrement.toFixed(8)).toBe('100.00000000');
    expect(creditArgs[0].where.id).toBe(8);
    expect(creditArgs[0].data.availableBalance.increment.toFixed(8)).toBe('98.50000000');
  });
});
