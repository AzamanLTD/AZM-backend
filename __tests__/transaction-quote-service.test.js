'use strict';

const {
  createTransactionQuote,
  createServerTransactionQuote,
  persistTransactionQuote,
  consumeTransactionQuote,
  assertQuoteActive,
  roundMoney,
} = require('../src/services/transactionQuoteService');

describe('transaction quote service', () => {
  test('creates a deterministic conversion snapshot with expiry', () => {
    const now = new Date('2026-08-29T05:00:00.000Z');
    const quote = createTransactionQuote({
      userId: 42,
      amountGhs: 1500,
      rateGhsPerUsdc: 15,
      feeGhs: 15,
      ttlSeconds: 60,
      now,
      rateSource: 'AZM_ADMIN_MOCK',
      rateAsOf: now,
    });

    expect(quote.userId).toBe(42);
    expect(quote.amountGhs).toBe(1500);
    expect(quote.feeGhs).toBe(15);
    expect(quote.netGhs).toBe(1485);
    expect(quote.usdcAmount).toBe(99);
    expect(quote.rateGhsPerUsdc).toBe(15);
    expect(quote.rateSource).toBe('AZM_ADMIN_MOCK');
    expect(quote.createdAt).toBe(now.toISOString());
    expect(quote.expiresAt).toBe('2026-08-29T05:01:00.000Z');
    expect(assertQuoteActive(quote, new Date('2026-08-29T05:00:30.000Z'))).toBe(quote);
  });

  test('rejects an expired quote', () => {
    const now = new Date('2026-08-29T05:00:00.000Z');
    const quote = createTransactionQuote({
      userId: 42,
      amountGhs: 100,
      rateGhsPerUsdc: 10,
      now,
    });

    expect(() => assertQuoteActive(quote, new Date('2026-08-29T05:01:00.000Z'))).toThrow('expired');
  });

  test('rejects invalid amounts and rates', () => {
    expect(() => createTransactionQuote({ userId: 42, amountGhs: 0, rateGhsPerUsdc: 10 })).toThrow('amountGhs');
    expect(() => createTransactionQuote({ userId: 42, amountGhs: 100, rateGhsPerUsdc: 0 })).toThrow('rateGhsPerUsdc');
    expect(() => createTransactionQuote({ userId: 42, amountGhs: 100, rateGhsPerUsdc: 10, ttlSeconds: 901 })).toThrow('ttlSeconds');
  });

  test('requires quote ownership', () => {
    expect(() => createTransactionQuote({ amountGhs: 100, rateGhsPerUsdc: 10 })).toThrow('userId is required');
  });

  test('rounds money consistently', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(10.999)).toBe(11);
  });

  test('persists a quote through parameterized Prisma raw SQL', async () => {
    const prisma = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const quote = createTransactionQuote({
      userId: 42,
      amountGhs: 100,
      rateGhsPerUsdc: 10,
      now: new Date('2026-08-29T05:00:00.000Z'),
    });

    await expect(persistTransactionQuote(prisma, quote)).resolves.toBe(quote);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  test('createServerTransactionQuote snapshots the server rate and persists the result', async () => {
    const prisma = {
      globalSettings: {
        findUnique: jest.fn().mockResolvedValue({
          liveUsdToGhs: 12.5,
          liveRateSource: 'LIVE',
          lastRateSync: new Date('2026-08-29T04:59:00.000Z'),
        }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    const quote = await createServerTransactionQuote({
      prisma,
      userId: 42,
      purpose: 'deposit',
      amountGhs: 125,
      ttlSeconds: 60,
      now: new Date('2026-08-29T05:00:00.000Z'),
    });

    expect(quote.rateGhsPerUsdc).toBe(12.5);
    expect(quote.usdcAmount).toBe(10);
    expect(quote.rateSource).toBe('LIVE');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  test('atomically consumes an unconsumed, owned, unexpired quote', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: 'quote-1',
        userId: 42,
        purpose: 'deposit',
        amountGhs: '125.00',
        feeGhs: '0.00',
        netGhs: '125.00',
        rateGhsPerUsdc: '12.50',
        usdcAmount: '10.000000000000',
        rateSource: 'LIVE',
        rateAsOf: new Date('2026-08-29T04:59:00.000Z'),
        createdAt: new Date('2026-08-29T05:00:00.000Z'),
        expiresAt: new Date('2026-08-29T05:10:00.000Z'),
        consumedAt: new Date('2026-08-29T05:01:00.000Z'),
        consumedFor: 'deposit',
      }]),
    };

    const quote = await consumeTransactionQuote({
      prisma,
      quoteId: 'quote-1',
      userId: 42,
      purpose: 'deposit',
      now: new Date('2026-08-29T05:01:00.000Z'),
    });

    expect(quote.id).toBe('quote-1');
    expect(quote.userId).toBe(42);
    expect(quote.usdcAmount).toBe(10);
    expect(quote.consumedFor).toBe('deposit');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  test('rejects a quote when the atomic consume update affects no rows', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };

    await expect(consumeTransactionQuote({
      prisma,
      quoteId: 'quote-1',
      userId: 42,
      purpose: 'deposit',
      now: new Date('2026-08-29T05:11:00.000Z'),
    })).rejects.toThrow('invalid, expired, already consumed, or not owned');
  });
});
