const express = require('express');
const request = require('supertest');

const router = require('../routes/storefrontCheckoutReadinessRoutes');

describe('storefront checkout readiness gate', () => {
  function makeApp(ready, { storefrontDisabled = false } = {}) {
    const app = express();
    app.set('retailCheckoutIntegrityReady', ready);
    app.set('prisma', {
      businessProfile: {
        findUnique: jest.fn().mockResolvedValue({ storefrontDisabled }),
      },
    });
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

  test('rejects checkout for an administratively disabled storefront', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await request(makeApp(true, { storefrontDisabled: true }))
        .post('/api/storefront/business-1/checkout')
        .send({ items: [{ productId: 'product-1', quantity: 1 }] });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        success: false,
        message: 'Storefront not available.',
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  test('honors storefront disablement outside production too', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const response = await request(makeApp(true, { storefrontDisabled: true }))
        .post('/api/storefront/business-1/checkout')
        .send({ items: [] });

      expect(response.status).toBe(404);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
