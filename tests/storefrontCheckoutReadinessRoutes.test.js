const express = require('express');
const request = require('supertest');

const router = require('../routes/storefrontCheckoutReadinessRoutes');

describe('storefront checkout readiness gate', () => {
  function makeApp(ready) {
    const app = express();
    app.set('retailCheckoutIntegrityReady', ready);
    app.use('/api/storefront', router);
    app.post('/api/storefront/business-1/checkout', (_req, res) => {
      res.status(201).json({ success: true });
    });
    return app;
  }

  test('fails closed in production while the integrity overlay is unavailable', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await request(makeApp(false))
        .post('/api/storefront/business-1/checkout')
        .send({ items: [] });

      expect(response.status).toBe(503);
      expect(response.body.retryable).toBe(true);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  test('passes through once the integrity overlay is ready', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await request(makeApp(true))
        .post('/api/storefront/business-1/checkout')
        .send({ items: [] });

      expect(response.status).toBe(201);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
