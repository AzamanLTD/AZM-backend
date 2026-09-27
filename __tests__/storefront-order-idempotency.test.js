'use strict';

// ── r42 alignment: storefront order endpoints under the client dedup key ────
// POST /api/storefront/:id/checkout and POST /api/storefront/:id/order accept
// a client-supplied body idempotencyKey. The contract under test:
//   same key + first request          → one order (201 / 200)
//   same key + replay                 → the SAME logical order, idempotent:true
//   same key + concurrent duplicate  → the @unique race loser converges on
//                                       the winner's order (deterministic
//                                       idempotent:true, never a 5xx)
//   no key                            → legacy behavior preserved (new order)

jest.mock('../middleware/authMiddleware', () => ({
  protect: (req, _res, next) => {
    req.user = { id: 'user-1', role: 'USER' };
    next();
  },
}));

jest.mock('../middleware/banGuardMiddleware', () => ({
  protectActive: (_req, _res, next) => next(),
}));

// The installed uuid package is ESM-only; the routes require it lazily at
// request time, which Jest's CJS runtime cannot load. Stub it.
jest.mock('uuid', () => ({
  v4: () => `dbg-${Math.random().toString(36).slice(2, 10)}`,
}));

const express = require('express');
const request = require('supertest');

let orderSeq = 0;

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.set('logger', { error: jest.fn() });
  app.use('/api/storefront', require('../routes/storefrontRoutes'));
  return app;
}

// Prisma double scoped to the fields the two routes touch. businessOrder
// emulates the real @unique on idempotencyKey: a create with an already-seen
// key throws P2002, exactly like the production constraint.
function makePrisma() {
  const inMemoryOrders = new Map();
  const prisma = {
    _orders: inMemoryOrders,
    businessProfile: {
      findUnique: jest.fn(async ({ where: { id } }) => ({
        id,
        userId: 'merchant-1',
        businessName: 'Test Biz',
        isSuspended: false,
        isPausedByOwner: false,
        businessMeta: {},
      })),
    },
    businessProduct: {
      findMany: jest.fn(async ({ where: { id: { in: ids } } }) =>
        ids.map((id) => ({ id, name: `Product ${id}`, priceUsdc: '25.00', isActive: true, isAvailable: true }))),
      findFirst: jest.fn(async ({ where: { id } }) => ({ id, name: `Product ${id}`, priceUsdc: '25.00', isActive: true, isAvailable: true })),
      update: jest.fn(async ({ where, data }) => ({ ...where, ...data })),
    },
    globalSettings: { findUnique: jest.fn(async () => ({ id: 1, smartEscrowFeePct: 0.01 })) },
    ticket: { create: jest.fn(async ({ data }) => ({ id: 'ticket-1', ...data })) },
    smartEscrow: { create: jest.fn(async ({ data }) => ({ id: 'escrow-1', ...data })) },
    businessOrder: {
      findUnique: jest.fn(async ({ where: { idempotencyKey } }) => inMemoryOrders.get(idempotencyKey) || null),
      create: jest.fn(async ({ data }) => {
        if (data.idempotencyKey && inMemoryOrders.has(data.idempotencyKey)) {
          const err = new Error('Unique constraint failed on the fields: (`idempotencyKey`)');
          err.code = 'P2002';
          throw err;
        }
        const order = { id: `ord-${++orderSeq}`, status: 'AWAITING_PAYMENT', ...data };
        if (data.idempotencyKey) inMemoryOrders.set(data.idempotencyKey, order);
        return order;
      }),
    },
    storefrontAnalyticsEvent: { create: jest.fn(async () => ({})) },
    businessNotification: { create: jest.fn(async () => ({})) },
    user: { findUnique: jest.fn(async () => ({ displayName: 'Tester', walletAddress: 'w' })) },
  };
  // Route-shaped $transaction double: delegates writes to the mocks above.
  prisma.$transaction = async (fn) => fn({
    globalSettings: prisma.globalSettings,
    ticket: prisma.ticket,
    smartEscrow: prisma.smartEscrow,
    businessOrder: prisma.businessOrder,
    businessProduct: prisma.businessProduct,
  });
  return prisma;
}

const key = 'op-key-1';

describe('POST /api/storefront/:id/order — single-item dedup', () => {
  test('creates one order for a keyed request', async () => {
    const prisma = makePrisma();
    const res = await request(buildApp(prisma))
      .post('/api/storefront/biz-1/order')
      .send({ productId: 'prod-1', quantity: 2, idempotencyKey: key });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(prisma.businessOrder.create).toHaveBeenCalledTimes(1);
  });

  test('same key replays the SAME logical order (never a second one)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const first = await request(app).post('/api/storefront/biz-1/order').send({ productId: 'prod-1', idempotencyKey: key });
    const replay = await request(app).post('/api/storefront/biz-1/order').send({ productId: 'prod-1', idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.body.success).toBe(true);
    expect(replay.body.data.idempotent).toBe(true);
    expect(replay.body.data.order.id).toBe(first.body.data.order.id);
    expect(prisma.businessOrder.create).toHaveBeenCalledTimes(1);
  });

  test('a concurrent same-key duplicate converges on the winner (no 5xx)', async () => {
    const prisma = makePrisma();
    // The winner committed between our findUnique and our create: the fast
    // path misses, but the @unique-constrained create fails and the
    // convergence re-lookup finds the winner.
    prisma._orders.set(key, { id: 'winner-1', orderRef: 'ORD-X', status: 'AWAITING_PAYMENT' });
    prisma.businessOrder.findUnique.mockResolvedValueOnce(null); // fast-path miss (race window)
    const res = await request(buildApp(prisma))
      .post('/api/storefront/biz-1/order')
      .send({ productId: 'prod-1', idempotencyKey: key });
    expect(res.status).toBe(200);
    expect(res.body.data.idempotent).toBe(true);
    expect(res.body.data.order.id).toBe('winner-1');
  });

  test('keyless legacy behavior preserved — a fresh order every time', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const a = await request(app).post('/api/storefront/biz-1/order').send({ productId: 'prod-1' });
    const b = await request(app).post('/api/storefront/biz-1/order').send({ productId: 'prod-1' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.order.id).not.toBe(b.body.data.order.id);
    expect(prisma.businessOrder.create).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/storefront/:id/checkout — cart dedup race convergence', () => {
  test('a concurrent same-key duplicate converges on the winner (deterministic idempotent, not 5xx)', async () => {
    const prisma = makePrisma();
    const winner = { id: 'winner-9', orderRef: 'ORD-Y', status: 'AWAITING_PAYMENT' };
    // The transaction's businessOrder.create throws P2002: the key was
    // committed by a concurrent request after the fast-path miss.
    prisma.$transaction = async (fn) => {
      const tx = {
        globalSettings: { findUnique: jest.fn(async () => ({ id: 1, smartEscrowFeePct: 0.01 })) },
        ticket: { create: jest.fn(async ({ data }) => ({ id: 'ticket-1', ...data })) },
        smartEscrow: { create: jest.fn(async ({ data }) => ({ id: 'escrow-1', ...data })) },
        businessOrder: {
          create: jest.fn(async () => {
            const err = new Error('Unique constraint failed on the fields: (`idempotencyKey`)');
            err.code = 'P2002';
            throw err;
          }),
        },
        businessProduct: { update: jest.fn(async ({ where, data }) => ({ ...where, ...data })) },
      };
      return fn(tx);
    };
    prisma.businessOrder.findUnique.mockResolvedValue(winner); // convergence re-lookup

    const res = await request(buildApp(prisma))
      .post('/api/storefront/biz-1/checkout')
      .send({ items: [{ productId: 'prod-1', quantity: 1 }], idempotencyKey: key, paymentMode: 'DIRECT' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.idempotent).toBe(true);
    expect(res.body.data.order.id).toBe('winner-9');
  });

  test('the first keyed request still creates the order (201, not idempotent)', async () => {
    const prisma = makePrisma();
    const res = await request(buildApp(prisma))
      .post('/api/storefront/biz-1/checkout')
      .send({ items: [{ productId: 'prod-1', quantity: 1 }], idempotencyKey: key, paymentMode: 'DIRECT' });
    if (res.status !== 201) console.log('DBG400:', JSON.stringify(res.body).slice(0, 200));
    expect(res.status).toBe(201);
    expect(res.body.data.idempotent).toBeUndefined();
    expect(prisma.smartEscrow.create).not.toHaveBeenCalled(); // DIRECT mode
  });

  test('same key replay returns the stored order without creating another', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const first = await request(app)
      .post('/api/storefront/biz-1/checkout')
      .send({ items: [{ productId: 'prod-1', quantity: 1 }], idempotencyKey: key, paymentMode: 'DIRECT' });
    const replay = await request(app)
      .post('/api/storefront/biz-1/checkout')
      .send({ items: [{ productId: 'prod-1', quantity: 1 }], idempotencyKey: key, paymentMode: 'DIRECT' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.idempotent).toBe(true);
    expect(replay.body.data.order.id).toBe(first.body.data.order.id);
    expect(prisma.businessOrder.create).toHaveBeenCalledTimes(1);
  });
});
