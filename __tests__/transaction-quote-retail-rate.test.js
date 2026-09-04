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

    await expect(getServerRateGhsPerUsdc({ prisma })).resolves.toEqual({
      rateGhsPerUsdc: 13.18,
      rateSource: 'KOTANI_PAY',
      rateAsOf: new Date('2026-09-04T10:00:00.000Z'),
    });
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
