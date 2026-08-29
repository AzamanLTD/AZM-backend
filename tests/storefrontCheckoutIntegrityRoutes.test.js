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

function makeApp(prisma, downstream) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/storefront', router);
  if (downstream) app.use('/api/storefront', downstream);
  app.use((req, res) => res.status(204).end());
  return app;
}

describe('storefront checkout integrity boundary', () => {
  test('rejects a selected variant that is not offered by the product', async () => {
    const prisma = {
      businessProduct: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'product-1', variants: { Size: ['Small', 'Large'] } },
        ]),
      },
      $queryRaw: jest.fn(),
    };

    const response = await request(makeApp(prisma))
      .post('/api/storefront/business-1/checkout')
      .send({
        idempotencyKey: 'client-key',
        items: [{ productId: 'product-1', quantity: 1, variants: { Size: 'XL' } }],
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Invalid value for variant option Size/);
  });

  test('rejects missing required variant dimensions server-side', async () => {
    const prisma = {
      businessProduct: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'product-1', variants: { Size: ['Small', 'Large'], Color: ['Black', 'White'] } },
        ]),
      },
      $queryRaw: jest.fn(),
    };

    const response = await request(makeApp(prisma))
      .post('/api/storefront/business-1/checkout')
      .send({
        items: [{ productId: 'product-1', quantity: 1, variants: { Size: 'Large' } }],
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Variant option Color must be selected/);
  });

  test('returns a scoped idempotent order and rejects reuse for different cart contents', async () => {
    const prisma = {
      businessProduct: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'product-1', variants: {} },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'order-1',
          orderRef: 'ORD-1',
          status: 'AWAITING_PAYMENT',
          idempotencyRequestHash: 'different-hash',
        },
      ]),
    };

    const response = await request(makeApp(prisma))
      .post('/api/storefront/business-1/checkout')
      .send({
        idempotencyKey: 'same-client-key',
        items: [{ productId: 'product-1', quantity: 1, variants: {} }],
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/different cart contents/);

    const values = prisma.$queryRaw.mock.calls[0].slice(1);
    expect(values[0]).toBe('business-1');
    expect(values[1]).toBe(7);
    expect(String(values[2])).toMatch(/^v1:business-1:7:/);
  });

  test('forwards a valid checkout to the existing transaction and persists variant snapshots', async () => {
    const prisma = {
      businessProduct: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'product-1', variants: { Size: ['Small', 'Large'] } },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    const downstream = (req, res) => {
      expect(req.body.idempotencyKey).toMatch(/^v1:business-1:7:/);
      return res.status(201).json({
        success: true,
        data: {
          order: {
            id: 'order-1',
            items: [{ id: 'line-1', productId: 'product-1' }],
          },
        },
      });
    };

    const response = await request(makeApp(prisma, downstream))
      .post('/api/storefront/business-1/checkout')
      .send({
        idempotencyKey: 'client-key',
        items: [{ productId: 'product-1', quantity: 1, variants: { Size: 'Large' } }],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.order.items[0].variants).toEqual({ Size: 'Large' });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  test('converts a concurrent idempotency collision into a safe retry response', async () => {
    const prisma = {
      businessProduct: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'product-1', variants: {} },
        ]),
      },
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: 'order-1',
          orderRef: 'ORD-1',
          status: 'AWAITING_PAYMENT',
          idempotencyRequestHash: null,
        }]),
      businessOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          items: [],
          escrow: null,
        }),
      },
    };

    const downstream = (_req, res) => res.status(400).json({
      success: false,
      message: 'Unique constraint failed on the fields: (`idempotencyKey`)',
    });

    const response = await request(makeApp(prisma, downstream))
      .post('/api/storefront/business-1/checkout')
      .send({
        idempotencyKey: 'client-key',
        items: [{ productId: 'product-1', quantity: 1, variants: {} }],
      });

    expect(response.status).toBe(200);
    expect(response.body.data.idempotent).toBe(true);
  });

  test('returns customer-scoped multi-item order lists with line items and variants', async () => {
    const prisma = {
      businessOrder: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'order-1',
            businessProfileId: 'business-1',
            customerId: 7,
            items: [{ id: 'line-1', productId: 'product-1' }],
            escrow: null,
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        { id: 'line-1', variants: { Size: 'Large' } },
      ]),
    };

    const response = await request(makeApp(prisma))
      .get('/api/storefront/business-1/orders')
      .query({ limit: 20, offset: 0 });

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(1);
    expect(response.body.data.orders[0].items).toHaveLength(1);
    expect(response.body.data.orders[0].items[0].variants).toEqual({ Size: 'Large' });
    expect(prisma.businessOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessProfileId: 'business-1', customerId: 7 },
    }));
  });
});
