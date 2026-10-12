// Regression coverage for the fresh-install and upgrade paths of the fiat
// liquidity overlay. Prisma is isolated at its SQL boundary so these guard
// semantics run without requiring a live database.
const mockQueryRawUnsafe = jest.fn();
const mockExecuteRawUnsafe = jest.fn();
const mockDisconnect = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    $queryRawUnsafe: (...args) => mockQueryRawUnsafe(...args),
    $executeRawUnsafe: (...args) => mockExecuteRawUnsafe(...args),
    $disconnect: (...args) => mockDisconnect(...args),
  })),
}));

jest.mock('../src/config/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../src/config/logger');
const { installFiatLiquidityOverlay } = require('../infra/install-fiat-liquidity-overlay');

describe('install-fiat-liquidity-overlay receipt-table preflight', () => {
  beforeEach(() => {
    mockQueryRawUnsafe.mockReset();
    mockExecuteRawUnsafe.mockReset().mockResolvedValue(1);
    mockDisconnect.mockReset();
    logger.error.mockClear();
    logger.info.mockClear();
  });

  test('fresh install skips the receipt-history query and creates the receipt table before its indexes', async () => {
    mockQueryRawUnsafe.mockImplementation(async (query) => {
      if (query.includes('to_regclass')) return [{ exists: false }];
      throw new Error('Unexpected query when receipt table is absent');
    });

    await installFiatLiquidityOverlay();

    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);
    const statements = mockExecuteRawUnsafe.mock.calls.map(([statement]) => statement);
    const createReceipt = statements.findIndex((s) =>
      s.includes('CREATE TABLE IF NOT EXISTS "FiatLiquidityReceipt"'));
    const uniqueReceiptIndex = statements.findIndex((s) =>
      s.includes('CREATE UNIQUE INDEX IF NOT EXISTS "FiatLiquidityReceipt_availableRelatedTx_unique"'));

    expect(createReceipt).toBeGreaterThanOrEqual(0);
    expect(uniqueReceiptIndex).toBeGreaterThan(createReceipt);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('FiatLiquidityReceipt is absent on first install'),
    );
  });

  test('existing receipt table gets duplicate-history preflight before any DDL', async () => {
    mockQueryRawUnsafe.mockImplementation(async (query) => {
      if (query.includes('to_regclass')) return [{ exists: true }];
      if (query.includes('SELECT "relatedTransactionId"')) return [];
      throw new Error('Unexpected query');
    });

    await installFiatLiquidityOverlay();

    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(mockQueryRawUnsafe.mock.invocationCallOrder[1])
      .toBeLessThan(mockExecuteRawUnsafe.mock.invocationCallOrder[0]);
  });

  test('existing contradictory AVAILABLE receipts still fail closed before DDL', async () => {
    mockQueryRawUnsafe.mockImplementation(async (query) => {
      if (query.includes('to_regclass')) return [{ exists: true }];
      if (query.includes('SELECT "relatedTransactionId"')) {
        return [
          { relatedTransactionId: 'tx-1', dedupKey: 'receipt-a', amountGhs: '10.00', confirmedAt: null },
          { relatedTransactionId: 'tx-1', dedupKey: 'receipt-b', amountGhs: '10.00', confirmedAt: null },
        ];
      }
      throw new Error('Unexpected query');
    });

    await expect(installFiatLiquidityOverlay()).rejects.toMatchObject({
      code: 'R15A_DUPLICATE_AVAILABLE_RECEIPTS',
    });
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ conflicts: expect.any(Array) }),
      expect.stringContaining('historical duplicate AVAILABLE receipts'),
    );
  });
});
