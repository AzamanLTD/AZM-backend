'use strict';

const {
  createTransactionQuote,
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
});
