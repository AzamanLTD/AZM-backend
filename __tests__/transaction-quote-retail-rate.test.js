'use strict';

const { getServerRateGhsPerUsdc } = require('../src/services/transactionQuoteService');

describe('transaction quote canonical FX source', () => {
  test('prefers liveRetailRate over legacy USD/GHS field', async () => {
    const prisma = {
      globalSettings: {
        findUnique: jest.fn().mockResolvedValue({
          liveRetailRate: '13.18',
          liveUsdToGhs: '13.25',
          liveRateSource: 'KOTANI_PAY',
          lastRateSync: new Date('2026-09-04T10:00:00.000Z'),
        }),
      },
    };

    const result = await getServerRateGhsPerUsdc({ prisma });
    // §P.5-C Decimal-native rate path: the reader returns the authoritative
    // Decimal alongside the presentation Number.
    expect(result.rateGhsPerUsdc).toBe(13.18);
    expect(result.rateSource).toBe('KOTANI_PAY');
    expect(result.rateAsOf).toEqual(new Date('2026-09-04T10:00:00.000Z'));
    expect(String(result.rateGhsPerUsdcExact)).toBe('13.18'); // the DB-authoritative Decimal, exact
    expect(Number(result.rateGhsPerUsdcExact)).toBe(13.18); // and its presentation projection agrees
    expect(Object.keys(result).sort()).toEqual(['rateAsOf', 'rateGhsPerUsdc', 'rateGhsPerUsdcExact', 'rateSource']);
  });

  test('falls back to legacy USD/GHS only when retail rate is unavailable', async () => {
    const prisma = {
      globalSettings: {
        findUnique: jest.fn().mockResolvedValue({
          liveRetailRate: null,
          liveUsdToGhs: '13.25',
          liveRateSource: 'LEGACY',
          lastRateSync: null,
        }),
      },
    };

    await expect(getServerRateGhsPerUsdc({ prisma })).resolves.toMatchObject({
      rateGhsPerUsdc: 13.25,
      rateSource: 'LEGACY',
    });
  });
});
