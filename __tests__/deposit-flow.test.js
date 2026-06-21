// __tests__/deposit-flow.test.js
// Covers (against the REAL depositController):
//   A. Fiat initiate (201, provider field) → webhook SUCCESS credits balance
//   B. Webhook FAIL marks the pending tx FAILED, no balance change
//   C. Duplicate SUCCESS webhook is idempotent (no double-credit)
//
// Real shapes (verified, not the design-doc shapes):
//   • initiateLocalFiatDeposit body is { amountGhs, provider } where provider ∈
//     { MTN_MOMO, VODAFONE_CASH, AIRTELTIGO, BANK_TRANSFER }; it returns 201 and
//     { data: { reference, transaction, ... } }.
//   • The confirm path is localFiatDepositWebhook (NOT confirmLocalFiatDeposit).
//     It requires header x-azaman-webhook-secret === process.env.FIAT_WEBHOOK_SECRET,
//     body { reference, amountGhs, status }, and a GlobalSettings row (liveUsdToGhs).
// SKIPS unless TEST_DATABASE_URL is set.
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[deposit-flow.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Deposit flow', () => {
  let prisma, depositCtrl;
  const WEBHOOK_SECRET = 'fiat_test_secret';

  beforeAll(async () => {
    process.env.DATABASE_URL       = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV           = 'test';
    process.env.JWT_SECRET         = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    process.env.FIAT_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { PrismaClient } = require('@prisma/client');
    prisma      = new PrismaClient();
    depositCtrl = require('../controllers/depositController');
  });

  afterAll(async () => { if (prisma) await prisma.$disconnect(); });

  beforeEach(async () => {
    // initiate + webhook both read GlobalSettings (id:1) for the live FX rate.
    await prisma.globalSettings.upsert({
      where: { id: 1 },
      update: { liveUsdToGhs: 10.0 },
      create: { id: 1, liveUsdToGhs: 10.0 },
    });
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User", "TransactionHistory" RESTART IDENTITY CASCADE'
    );
  });

  function mockRes() {
    const r = { _status: 200, _body: null };
    r.status = (s) => { r._status = s; return r; };
    r.json   = (b) => { r._body  = b; return r; };
    return r;
  }
  function mockApp(p) {
    return { get: (k) => k === 'prisma' ? p : (k === 'socketio' ? { to: () => ({ emit: () => {} }) } : null) };
  }

  async function initiate(user, amountGhs) {
    const res = mockRes();
    await depositCtrl.initiateLocalFiatDeposit(
      { user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO' }, app: mockApp(prisma) },
      res
    );
    return res;
  }
  function webhook(reference, status, amountGhs) {
    return {
      body: { reference, amountGhs, providerTxId: `ptx_${reference}`, status },
      headers: { 'x-azaman-webhook-secret': WEBHOOK_SECRET },
      app: mockApp(prisma),
    };
  }

  test('A: initiate creates PENDING tx; webhook SUCCESS credits balance', async () => {
    const user = await seedUser(prisma, { availableBalance: 0 });
    const initRes = await initiate(user, 100);
    expect(initRes._status).toBe(201);
    expect(initRes._body.success).toBe(true);
    const reference = initRes._body.data?.reference;
    expect(reference).toBeTruthy();

    const pending = await prisma.transactionHistory.findFirst({ where: { userId: user.id, txHash: reference } });
    expect(pending).not.toBeNull();
    expect(pending.status).toBe('PENDING');

    const confirmRes = mockRes();
    await depositCtrl.localFiatDepositWebhook(webhook(reference, 'SUCCESS', 100), confirmRes);
    expect(confirmRes._status).toBe(200);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(Number(updated.availableBalance)).toBeGreaterThan(0);
  });

  test('B: webhook FAIL marks tx FAILED, does not credit balance', async () => {
    const user = await seedUser(prisma, { availableBalance: 0 });
    const initRes = await initiate(user, 50);
    const reference = initRes._body.data?.reference;

    const failRes = mockRes();
    await depositCtrl.localFiatDepositWebhook(webhook(reference, 'FAILED', 50), failRes);
    expect(failRes._status).toBe(200);

    const same = await prisma.user.findUnique({ where: { id: user.id } });
    expect(Number(same.availableBalance)).toBe(0);
    const tx = await prisma.transactionHistory.findFirst({ where: { txHash: reference } });
    expect(tx.status).toBe('FAILED');
  });

  test('C: duplicate SUCCESS webhook does not double-credit', async () => {
    const user = await seedUser(prisma, { availableBalance: 0 });
    const initRes = await initiate(user, 75);
    const reference = initRes._body.data?.reference;

    const r1 = mockRes();
    await depositCtrl.localFiatDepositWebhook(webhook(reference, 'SUCCESS', 75), r1);
    const balAfterFirst = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
    expect(balAfterFirst).toBeGreaterThan(0);

    const r2 = mockRes();
    await depositCtrl.localFiatDepositWebhook(webhook(reference, 'SUCCESS', 75), r2);
    expect(r2._status).toBe(200); // idempotent — already processed
    const balAfterSecond = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
    expect(balAfterSecond).toBe(balAfterFirst);
  });
});
