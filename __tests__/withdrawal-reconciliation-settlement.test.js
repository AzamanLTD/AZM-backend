const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
const financeService = require('../services/finance.service');

jest.mock('../services/finance.service');

// §P.5-D: the reconciliation worker retains every provider status answer as
// durable outbound evidence through the liquidity authority — stub the
// collaborator boundary (its real persistence is covered by the real-PG
// P.5-D suites).
jest.mock('../src/services/fiatLiquidityService', () => ({
    recordProviderEvent: jest.fn().mockResolvedValue({ replay: false }),
    settleIfRecorded: jest.fn().mockResolvedValue({ skipped: true }),
}));

describe('WithdrawalReconciliationWorker settlement lifecycle', () => {
  const withdrawal = {
    id: 42,
    userId: 7,
    amount: 100,
    destination: '0240000000',
    createdAt: new Date(Date.now() - 60_000),
    user: {
      id: 7,
      email: 'user@example.com',
      username: 'user',
      phoneNumber: null,
      phoneVerified: false,
    },
  };

  const attemptDb = (transactionHistoryId = 'tx-1') => ({
    // r15 hardening: the worker now also consults the durable exception
    // queue (ReconciliationException) before a legacy no-hint search —
    // route the raw mocks by SQL text so the attempt queries keep their
    // fixtures while the guard query sees an empty exception queue.
    $queryRawUnsafe: jest.fn().mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('ReconciliationException')) {
        return [];
      }
      return [{
        id: transactionHistoryId,
        transactionHistoryId,
        provider: 'MTN_MOMO_DISBURSEMENT',
        providerReference: transactionHistoryId === 'tx-2' ? 'ref-2' : 'ref-1',
        status: 'PENDING',
      }];
    }),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  });

  const exceptionDb = () => ({
    $queryRawUnsafe: jest.fn().mockResolvedValue([{
      id: 'exception-1',
      entityType: 'WITHDRAWAL',
      entityId: '42',
      reason: 'MISSING_TRANSACTION_REFERENCE',
      status: 'OPEN',
    }]),
  });

  test('provider success advances canonical TransactionHistory from PENDING to COMPLETED through the durable link', async () => {
    const prisma = {
      ...attemptDb(),
      transactionHistory: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tx-1',
          txHash: 'ref-1',
          userId: 7,
          type: 'WITHDRAWAL_FIAT',
          amountUsdc: 100,
          status: 'PENDING',
          metadata: { payoutGhs: 1500 }, // r20: creation-time GHS economics
        }),
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      fiatProviderEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      fiatLiquidityReservation: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      withdrawal: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
    const provider = {
      getTransferStatus: jest.fn().mockResolvedValue({
        // r20: REAL adapter contract shape — provider identity, the echoed
        // queried reference, and the provider-reported payout amount.
        provider: 'MOOLRE_DISBURSEMENT',
        referenceId: 'ref-1',
        externalId: 'ref-1',
        status: 'SUCCESSFUL',
        amountGhs: 1500,
        reason: null,
        source: 'MOCK',
        providerRef: 'provider-123',
      }),
    };

    financeService.completeFiatWithdrawal.mockResolvedValue({
      reference: 'ref-1',
      status: 'COMPLETED',
      providerTxId: 'provider-123',
    });

    const worker = new WithdrawalReconciliationWorker(prisma, io, provider);
    await worker._reconcileOne(withdrawal);

    expect(prisma.transactionHistory.findMany).not.toHaveBeenCalled();
    expect(prisma.transactionHistory.findUnique).toHaveBeenCalledWith({ where: { id: 'tx-1' } });
    // TransactionHistory advancement now happens inside the canonical finance
    // settlement boundary, not as a direct worker mutation.
    expect(financeService.completeFiatWithdrawal).toHaveBeenCalledWith(prisma, 'ref-1', {
      providerTxId: 'provider-123',
    });
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: 42, status: { in: ['PENDING', 'PROCESSING', 'DISPATCHING'] } },
      data: { status: 'COMPLETED' },
    });
    expect(io.to).toHaveBeenCalledWith('user_7');
    expect(io.emit).toHaveBeenCalledWith('withdrawal_settled', expect.objectContaining({
      reference: 'ref-1',
      status: 'COMPLETED',
      providerTxId: 'provider-123',
    }));
  });

  test('provider failure uses the canonical reversal service and marks the mirror failed', async () => {
    const prisma = {
      ...attemptDb('tx-2'),
      transactionHistory: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tx-2',
          txHash: 'ref-2',
          userId: 7,
          type: 'WITHDRAWAL_FIAT',
          amountUsdc: 100,
          status: 'PENDING',
          metadata: { payoutGhs: 1500 }, // r20: creation-time GHS economics
        }),
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      fiatProviderEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      fiatLiquidityReservation: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      withdrawal: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
    const provider = {
      getTransferStatus: jest.fn().mockResolvedValue({
        // r20: REAL adapter contract shape — echoes the QUERIED reference
        provider: 'MOOLRE_DISBURSEMENT',
        referenceId: 'ref-2',
        externalId: 'ref-2',
        status: 'FAILED',
        amountGhs: 1500,
        reason: 'recipient rejected',
        source: 'MOCK',
        providerRef: 'provider-456',
      }),
    };
    financeService.reverseFiatWithdrawal.mockResolvedValue({
      reference: 'ref-2',
      alreadyReversed: false,
      refundedAmount: 102,
      userId: 7,
    });

    const worker = new WithdrawalReconciliationWorker(prisma, io, provider);
    await worker._reconcileOne(withdrawal);

    expect(prisma.transactionHistory.findMany).not.toHaveBeenCalled();
    expect(prisma.transactionHistory.findUnique).toHaveBeenCalledWith({ where: { id: 'tx-2' } });
    expect(prisma.transactionHistory.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-2', status: 'PENDING' },
      data: { providerRef: 'provider-456' },
    });
    expect(financeService.reverseFiatWithdrawal).toHaveBeenCalledWith(
      prisma,
      'ref-2',
      { reason: 'provider_async_failure: recipient rejected' },
    );
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: 42, status: { in: ['PENDING', 'PROCESSING', 'DISPATCHING'] } },
      data: { status: 'FAILED' },
    });
  });

  test('missing canonical transaction is queued as an exception and never queried at the provider', async () => {
    const prisma = {
      ...exceptionDb(),
      transactionHistory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      withdrawal: { update: jest.fn() },
    };
    const provider = { getTransferStatus: jest.fn() };
    const worker = new WithdrawalReconciliationWorker(prisma, null, provider);

    await worker._reconcileOne(withdrawal);

    expect(provider.getTransferStatus).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(prisma.withdrawal.update).not.toHaveBeenCalled();
  });

  test('ambiguous canonical matches are queued as exceptions and never mutate money', async () => {
    const prisma = {
      ...exceptionDb(),
      transactionHistory: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'tx-a', txHash: 'ref-a' },
          { id: 'tx-b', txHash: 'ref-b' },
        ]),
        updateMany: jest.fn(),
      },
      withdrawal: { update: jest.fn() },
    };
    const provider = { getTransferStatus: jest.fn() };
    const worker = new WithdrawalReconciliationWorker(prisma, null, provider);

    await worker._reconcileOne(withdrawal);

    expect(provider.getTransferStatus).not.toHaveBeenCalled();
    expect(prisma.transactionHistory.updateMany).not.toHaveBeenCalled();
    expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    // r17: the third raw read is the bridge-linked exclusion check (a
    // read-only SELECT) before the ambiguity verdict — still zero writes.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
  });
});
