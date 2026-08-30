const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
const financeService = require('../services/finance.service');

jest.mock('../services/finance.service');

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

  const attemptDb = () => ({
    $queryRawUnsafe: jest.fn().mockResolvedValue([{
      id: 'attempt-1',
      transactionHistoryId: 'tx-1',
      provider: 'MTN_MOMO_DISBURSEMENT',
      providerReference: 'ref-1',
      status: 'PENDING',
    }]),
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

  test('provider success advances canonical TransactionHistory from PENDING to COMPLETED', async () => {
    const prisma = {
      ...attemptDb(),
      transactionHistory: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'tx-1',
          txHash: 'ref-1',
          userId: 7,
          type: 'WITHDRAWAL_FIAT',
          amountUsdc: 100,
          status: 'PENDING',
        }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      withdrawal: {
        update: jest.fn().mockResolvedValue({ ...withdrawal, status: 'COMPLETED' }),
      },
    };
    const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
    const provider = {
      getTransferStatus: jest.fn().mockResolvedValue({
        status: 'SUCCESSFUL',
        providerRef: 'provider-123',
      }),
    };

    const worker = new WithdrawalReconciliationWorker(prisma, io, provider);
    await worker._reconcileOne(withdrawal);

    expect(prisma.transactionHistory.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', status: 'PENDING' },
      data: { status: 'COMPLETED', providerRef: 'provider-123' },
    });
    expect(prisma.withdrawal.update).toHaveBeenCalledWith({
      where: { id: 42 },
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
      ...attemptDb(),
      transactionHistory: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'tx-2',
          txHash: 'ref-2',
          userId: 7,
          type: 'WITHDRAWAL_FIAT',
          amountUsdc: 100,
          status: 'PENDING',
        }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      withdrawal: {
        update: jest.fn().mockResolvedValue({ ...withdrawal, status: 'FAILED' }),
      },
    };
    const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
    const provider = {
      getTransferStatus: jest.fn().mockResolvedValue({
        status: 'FAILED',
        providerRef: 'provider-456',
        reason: 'recipient rejected',
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

    expect(prisma.transactionHistory.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-2', status: 'PENDING' },
      data: { providerRef: 'provider-456' },
    });
    expect(financeService.reverseFiatWithdrawal).toHaveBeenCalledWith(
      prisma,
      'ref-2',
      { reason: 'provider_async_failure: recipient rejected' },
    );
    expect(prisma.withdrawal.update).toHaveBeenCalledWith({
      where: { id: 42 },
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
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
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
  });
});
