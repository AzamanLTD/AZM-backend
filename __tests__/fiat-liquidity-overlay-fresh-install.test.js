// Regression coverage for the fresh-install and upgrade paths of the fiat
// liquidity overlay. Prisma is isolated at its SQL boundary so these guard
// semantics run without requiring a live database. (Real-PostgreSQL
// first-install and duplicate-preflight coverage lives in
// r15a-reconciliation-single-claim.test.js §G; this file pins the fail-closed
// probe semantics the mock boundary can prove exhaustively.)
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

    // The probe is the ONLY query, and NO DDL executes before it: the
    // historical scan is skipped exactly because the table is absent.
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mockQueryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('to_regclass'));
    expect(mockQueryRawUnsafe.mock.invocationCallOrder[0])
      .toBeLessThan(mockExecuteRawUnsafe.mock.invocationCallOrder[0]);
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

  test('a FAILED existence probe fails closed before any DDL', async () => {
    mockQueryRawUnsafe.mockRejectedValue(new Error('connection refused'));

    await expect(installFiatLiquidityOverlay()).rejects.toMatchObject({
      code: 'FIAT_LIQUIDITY_RECEIPT_PROBE_FAILED',
    });
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'connection refused' }),
      expect.stringContaining('existence probe failed'),
    );
  });

  test('a MALFORMED or ambiguous existence probe fails closed before any DDL', async () => {
    // Empty result (missing row), non-array results, ambiguous multi-row
    // results, and rows whose exists flag is missing, null, or non-boolean
    // are ALL indistinguishable from shape drift: none of them proves the
    // table is absent, so none of them may take the first-install path.
    const malformed = [
      [],                 // missing row — NOT proof of absence
      {},                 // not an array at all
      'unexpected',        // not an array
      [{ exists: true }, { exists: false }], // ambiguous multi-row
      [{}],               // row without an exists flag
      [{ exists: null }], // null flag
      [{ exists: 'true' }], // non-boolean flag
      [{ exists: 1 }],    // numeric flag
    ];
    for (const probe of malformed) {
      mockQueryRawUnsafe.mockReset().mockResolvedValue(probe);
      mockExecuteRawUnsafe.mockClear();
      await expect(installFiatLiquidityOverlay()).rejects.toMatchObject({
        code: 'FIAT_LIQUIDITY_RECEIPT_PROBE_MALFORMED',
      });
      expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
    }
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ probe: expect.any(String) }),
      expect.stringContaining('malformed or ambiguous'),
    );
  });

  test('repeated installation stays idempotent: every re-run probes, scans, and executes the full guarded statement list', async () => {
    mockQueryRawUnsafe.mockImplementation(async (query) => {
      if (query.includes('to_regclass')) return [{ exists: true }];
      if (query.includes('SELECT "relatedTransactionId"')) return [];
      throw new Error('Unexpected query');
    });

    await installFiatLiquidityOverlay();
    const firstRunStatementCount = mockExecuteRawUnsafe.mock.calls.length;
    expect(firstRunStatementCount).toBeGreaterThan(0);

    mockExecuteRawUnsafe.mockClear();
    mockQueryRawUnsafe.mockClear();
    await installFiatLiquidityOverlay(); // re-run must not throw

    // A re-run performs the same read-only probe + duplicate scan and then
    // executes the identical idempotent statement list (every statement is
    // guarded with IF NOT EXISTS / DO NOTHING semantics).
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(mockExecuteRawUnsafe.mock.calls.length).toBe(firstRunStatementCount);
  });
});
