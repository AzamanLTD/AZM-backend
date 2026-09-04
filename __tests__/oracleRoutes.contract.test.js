const express = require('express');
const request = require('supertest');
const oracleRouter = require('../routes/oracleRoutes');

describe('oracle routes canonical contract', () => {
  function appFor(settings) {
    const app = express();
    app.set('prisma', {
      globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
    });
    app.use('/api/oracle', oracleRouter);
    return app;
  }

  test('publishes USDC/GHS identity, retail rate and refresh cadence', async () => {
    const response = await request(appFor({
      liveUsdToGhs: '13.20',
      liveRetailRate: '13.18',
      liveCorporateRate: '13.05',
      bankMargin: '3',
      thirdPartyMargin: '2',
      liveRateSource: 'KOTANI_PAY',
      lastRateSync: '2026-09-04T10:00:00.000Z',
    })).get('/api/oracle/rates').expect(200);

    expect(response.body).toEqual({
      success: true,
      data: {
        pair: 'USDC/GHS',
        settlementCurrency: 'USDC',
        displayCurrency: 'GHS',
        liveUsdToGhs: 13.2,
        liveRetailRate: 13.18,
        liveCorporateRate: 13.05,
        bankMargin: 3,
        thirdPartyMargin: 2,
        rateSource: 'KOTANI_PAY',
        lastSync: '2026-09-04T10:00:00.000Z',
        refreshIntervalSeconds: 600,
      },
    });
  });

  test('returns a deterministic unavailable snapshot without inventing a rate', async () => {
    const response = await request(appFor(null)).get('/api/oracle/rates').expect(200);
    expect(response.body.data).toMatchObject({
      pair: 'USDC/GHS',
      settlementCurrency: 'USDC',
      displayCurrency: 'GHS',
      liveUsdToGhs: 0,
      liveRetailRate: 0,
      refreshIntervalSeconds: 600,
    });
  });
});
