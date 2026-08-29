'use strict';

const {
  DEFAULT_QUOTE_TTL_SECONDS,
  createTransactionQuote,
  assertQuoteActive,
} = require('../src/services/transactionQuoteService');

describe('transactionQuoteService', () => {
  const now = new Date('2026-08-29T06:00:00.000Z');

  test('creates a server quote with an owner and authoritative amount', () => {
    const quote = createTransactionQuote({
      userId: 42,
      purpose: 'usdc_purchase',
      amountGhs: 1000,
      rateGhsPerUsdc: 12.5,
      feeGhs: 10,
      now,
    });

    expect(quote.userId).toBe(42);
    expect(quote.purpose).toBe('usdc_purchase');
    expect(quote.amountGhs).toBe(1000);
    expect(quote.feeGhs).toBe(10);
    expect(quote.netGhs).toBe(990);
    expect(quote.usdcAmount).toBe(79.2);
    expect(quote.expiresAt).toBe('2026-08-29T06:01:00.000Z');
  });

  test('uses the documented default TTL', () => {
    const quote = createTransactionQuote({
      userId: 42,
      purpose: 'deposit',
      amountGhs: 100,
      rateGhsPerUsdc: 10,
      now,
    });

    expect(new Date(quote.expiresAt).getTime() - now.getTime()).toBe(
      DEFAULT_QUOTE_TTL_SECONDS * 1000,
    );
  });

  test('rejects invalid ownership and monetary input', () => {
    expect(() => createTransactionQuote({
      userId: null,
      amountGhs: 100,
      rateGhsPerUsdc: 10,
      now,
    })).toThrow('userId is required');

    expect(() => createTransactionQuote({
      userId: 42,
      amountGhs: 0,
      rateGhsPerUsdc: 10,
      now,
    })).toThrow('amountGhs must be greater than zero');

    expect(() => createTransactionQuote({
      userId: 42,
      amountGhs: 100,
      rateGhsPerUsdc: 0,
      now,
    })).toThrow('rateGhsPerUsdc is outside the permitted range');
  });

  test('rejects expired quotes and accepts active quotes', () => {
    const quote = createTransactionQuote({
      userId: 42,
      purpose: 'usdc_purchase',
      amountGhs: 100,
      rateGhsPerUsdc: 10,
      ttlSeconds: 60,
      now,
    });

    expect(assertQuoteActive(quote, new Date('2026-08-29T06:00:59.999Z'))).toBe(quote);
    expect(() => assertQuoteActive(quote, new Date('2026-08-29T06:01:00.000Z'))).toThrow(
      'Transaction quote has expired',
    );
  });
});
