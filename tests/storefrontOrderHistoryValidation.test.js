const express = require('express');
const request = require('supertest');

jest.mock('../middleware/authMiddleware', () => ({
  protect: (req, _res, next) => {
    req.user = { id: 7 };
    next();
  },
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
  protectActive: (_req, _res, next) => next(),
}));

const router = require('../routes/storefrontCheckoutIntegrityRoutes');

function makeApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/storefront', router);
  app.use((req, res) => res.status(204).end());
  return app;
}

describe('storefront customer order history validation', () => {
  test('rejects an invalid status filter before touching the database', async () => {
    const prisma = { businessOrder: { findMany: jest.fn() } };
    const response = await request(makeApp(prisma))
      .get('/api/storefront/me/orders')
      .query({ status: 'NOT_A_STATUS' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid order status filter.');
    expect(prisma.businessOrder.findMany).not.toHaveBeenCalled();
  });

  test('rejects a malformed cursor before touching the database', async () => {
    const prisma = { businessOrder: { findMany: jest.fn() } };
    const response = await request(makeApp(prisma))
      .get('/api/storefront/me/orders')
      .query({ cursor: 'not-base64-json' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid order history cursor.');
    expect(prisma.businessOrder.findMany).not.toHaveBeenCalled();
  });
});
