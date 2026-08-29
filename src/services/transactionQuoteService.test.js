const {
  createTransactionQuote,
  assertQuoteActive,
} = require('./transactionQuoteService');

describe('transactionQuoteService', () => {
  const now = new Date('2026-08-29T12:00:00.000Z');

  test('creates a quote with deterministic conversion and expiry', () => {
    const quote = createTransactionQuote({
      amountGhs: 125,
      rateGhsPerUsdc: 12.5,
      feeGhs: 2.5,
      ttlSeconds: 60,
      now,
    });

    expect(quote.id).toEqual(expect.any(String));
    expect(quote.amountGhs).toBe(125);
    expect(quote.feeGhs).toBe(2.5);
    expect(quote.netGhs).toBe(122.5);
    expect(quote.usdcAmount).toBeCloseTo(9.8);
    expect(quote.expiresAt).toBe('2026-08-29T12:01:00.000Z');
  });

  test('accepts an active quote', () => {
    const quote = createTransactionQuote({
      amountGhs: 100,
      rateGhsPerUsdc: 12.5,
      now,
    });

    expect(() => assertQuoteActive(quote, new Date('2026-08-29T12:00:59.000Z'))).not.toThrow();
  });

  test('rejects an expired quote', () => {
    const quote = createTransactionQuote({
      amountGhs: 100,
      rateGhsPerUsdc: 12.5,
      now,
    });

    expect(() => assertQuoteActive(quote, new Date('2026-08-29T12:01:00.000Z')))
      .toThrow('Transaction quote has expired');
  });

  test('rejects invalid money and rate inputs', () => {
    expect(() => createTransactionQuote({ amountGhs: 0, rateGhsPerUsdc: 12.5, now })).toThrow();
    expect(() => createTransactionQuote({ amountGhs: 100, rateGhsPerUsdc: 0, now })).toThrow();
    expect(() => createTransactionQuote({ amountGhs: 100, rateGhsPerUsdc: 12.5, feeGhs: -1, now })).toThrow();
  });
});
