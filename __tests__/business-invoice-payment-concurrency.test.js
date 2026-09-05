'use strict';

const { payInvoice } = require('../services/businessInvoiceService');

const makeConcurrentPrisma = () => {
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
        if (state.initialReads === 2) releaseResolve();
        if (state.initialReads <= 2) await state.releaseInitialReads;
        if (state.initialReads > 2 && state.invoice.payTxHash && !state.invoice.customerPaidUsdc) {
          // A concurrent loser can only observe the durable replay marker after
          // the winner's transaction commits all settlement fields.
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
      findUnique: jest.fn().mockResolvedValue({ availableBalance: 1000, username: 'customer' }),
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
    $transaction: jest.fn(async (callback) => {
      state.transactionCalls += 1;
      return callback(prisma);
    }),
  };

  return { prisma, state };
};

describe('business invoice payment concurrency', () => {
  test('two concurrent payers produce one settlement and one replay', async () => {
    const { prisma, state } = makeConcurrentPrisma();

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
    expect(state.balanceMutations).toBe(2);
    expect(state.historyWrites).toBe(2);
    expect(state.feeWrites).toBe(2);
    expect(state.invoice.status).toBe('PAID');
    expect(state.invoice.payTxHash).toBe('INV_PAY_invoice-1');
  });
});
