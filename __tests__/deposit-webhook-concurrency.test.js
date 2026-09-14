'use strict';

const describeOrSkip = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Regression proof for the webhook race: the durable TransactionHistory row
// must be claimed inside the same transaction as the wallet credit. Two
// simultaneous SUCCESS deliveries for one reference may credit the user only
// once.
describeOrSkip('fiat deposit webhook concurrency (real PostgreSQL)', () => {
  const { PrismaClient } = require('@prisma/client');
  const { seedUser } = require('./helpers/factories');
  const depositCtrl = require('../controllers/depositController');

  let prisma;
  const WEBHOOK_SECRET = 'fiat_test_concurrency_secret';

  const mockRes = () => {
    const res = { _status: 200, _body: null };
    res.status = (status) => { res._status = status; return res; };
    res.json = (body) => { res._body = body; return res; };
    return res;
  };

  const mockReq = (prismaClient, reference, amountGhs, providerTxId = 'provider-race') => ({
    body: { reference, amountGhs, providerTxId, status: 'SUCCESS' },
    headers: { 'x-azaman-webhook-secret': WEBHOOK_SECRET },
    app: {
      get: (key) => key === 'prisma'
        ? prismaClient
        : (key === 'socketio' ? { to: () => ({ emit: () => {} }) } : null),
    },
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.FIAT_WEBHOOK_SECRET = WEBHOOK_SECRET;
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User", "TransactionHistory" RESTART IDENTITY CASCADE'
    );
  }, 15000);

  test('two concurrent SUCCESS webhooks credit the same deposit exactly once', async () => {
    const user = await seedUser(prisma, { availableBalance: 0 });
    const reference = `FIAT_RACE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await prisma.transactionHistory.create({
      data: {
        userId: user.id,
        type: 'DEPOSIT_FIAT',
        amountUsdc: 10,
        feeUsdc: 0,
        txHash: reference,
        status: 'PENDING',
      },
    });
    await prisma.globalSettings.upsert({
      where: { id: 1 },
      update: { liveUsdToGhs: 10.0 },
      create: { id: 1, liveUsdToGhs: 10.0 },
    });

    const [a, b] = await Promise.all([
      depositCtrl.localFiatDepositWebhook(mockReq(prisma, reference, 100, 'provider-A'), mockRes()),
      depositCtrl.localFiatDepositWebhook(mockReq(prisma, reference, 100, 'provider-B'), mockRes()),
    ]);

    const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
    const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });

    expect(a._status).toBe(200);
    expect(b._status).toBe(200);
    expect(Number(userAfter.availableBalance)).toBeCloseTo(10, 6);
    expect(txAfter.status).toBe('COMPLETED');
  });
});
