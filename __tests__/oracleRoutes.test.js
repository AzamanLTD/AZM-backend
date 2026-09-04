const express = require('express');
const request = require('supertest');
const oracleRouter = require('../routes/oracleRoutes');

describe('oracle routes', () => {
  const buildApp = (settings) => {
    const app = express();
    app.set('prisma', {
      globalSettings: {
        findUnique: jest.fn().mockResolvedValue(settings),
      },
    });
    app.use('/api/oracle', oracleRouter);
    return app;
  };

  test('publishes the canonical USDC/GHS contract and server refresh cadence', async () => {
    const app = buildApp({
      liveUsdToGhs: '13.25',
      liveRetailRate: '13.18',
      liveCorporateRate: '13.05',
      bankMargin: '0.03',
      thirdPartyMargin: '0.02',
      liveRateSource: 'KOTANI_PAY',
      lastRateSync: '2026-09-04T10:00:00.000Z',
    });

    const response = await request(app).get('/api/oracle/rates').expect(200);

    expect(response.body).toEqual({
      success: true,
      data: {
        pair: 'USDC/GHS',
        settlementCurrency: 'USDC',
        displayCurrency: 'GHS',
        liveUsdToGhs: 13.25,
        liveRetailRate: 13.18,
        liveCorporateRate: 13.05,
        bankMargin: 0.03,
        thirdPartyMargin: 0.02,
        rateSource: 'KOTANI_PAY',
        lastSync: '2026-09-04T10:00:00.000Z',
        refreshIntervalSeconds: 600,
      },
    });
  });

  test('keeps the freshness contract usable when settings are unavailable', async () => {
    const app = buildApp(null);

    const response = await request(app).get('/api/oracle/rates').expect(200);

    expect(response.body.data).toMatchObject({
      pair: 'USDC/GHS',
      settlementCurrency: 'USDC',
      displayCurrency: 'GHS',
      liveUsdToGhs: 0,
      liveRetailRate: 0,
      rateSource: 'UNKNOWN',
      lastSync: null,
      refreshIntervalSeconds: 600,
    });
  });

  test('normalizes Decimal-like rate values to JSON numbers', async () => {
    const app = buildApp({
      liveUsdToGhs: { toString: () => '13.50' },
      liveRetailRate: { toString: () => '13.40' },
      liveCorporateRate: { toString: () => '13.10' },
      bankMargin: { toString: () => '0.03' },
      thirdPartyMargin: { toString: () => '0.02' },
      liveRateSource: 'FALLBACK_FX',
      lastRateSync: null,
    });

    const response = await request(app).get('/api/oracle/rates').expect(200);

    expect(response.body.data.liveRetailRate).toBe(13.4);
    expect(response.body.data.liveUsdToGhs).toBe(13.5);
    expect(response.body.data.bankMargin).toBe(0.03);
  });
});
