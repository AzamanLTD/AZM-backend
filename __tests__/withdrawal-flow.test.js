// __tests__/withdrawal-flow.test.js
// Covers (against the REAL withdrawalController + adminController + Withdrawal model):
//   A. cryptoWithdrawal with an invalid Polygon address → 400
//   B. admin approveWithdrawal: PENDING → APPROVED (params.id; no money moves)
//   C. admin rejectWithdrawal: PENDING → REJECTED and balance refunded
//
// Real shapes (verified, not the design-doc shapes):
//   • The model is `Withdrawal` (Int autoincrement id), NOT `WithdrawalRequest`.
//   • Admin approve/reject take the id from req.params.id; reject refunds
//     availableBalance by the withdrawal amount.
//   • The fiat-disbursement success path depends on several injected services
//     (MTN/email/SMS) and is exercised elsewhere; it's not re-tested here.
// SKIPS unless TEST_DATABASE_URL is set.
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[withdrawal-flow.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Withdrawal flow', () => {
  let prisma, withdrawalCtrl, adminCtrl;
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV     = 'test';
    process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    const { PrismaClient } = require('@prisma/client');
    prisma         = new PrismaClient();
    withdrawalCtrl = require('../controllers/withdrawalController');
    adminCtrl      = require('../controllers/adminController');
  });

  afterAll(async () => { if (prisma) await prisma.$disconnect(); });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User", "Withdrawal", "TransactionHistory", "AuditLog" RESTART IDENTITY CASCADE'
    );
  }, 15000);

  function mockRes() {
    const r = { _status: 200, _body: null };
    r.status = (s) => { r._status = s; return r; };
    r.json   = (b) => { r._body  = b; return r; };
    return r;
  }
  function mockApp(p) {
    const noopNotif = { sendNotification: async () => {} };
    return {
      get: (k) =>
        k === 'prisma' ? p :
        k === 'socketio' ? { to: () => ({ emit: () => {} }) } :
        k === 'notificationService' ? noopNotif :
        k === 'emitBalanceUpdate' ? (async () => {}) : null,
    };
  }

  test('A: crypto withdrawal with invalid address returns 400', async () => {
    const user = await seedUser(prisma, { availableBalance: 500 });
    const res = mockRes();
    await withdrawalCtrl.cryptoWithdrawal(
      { user: { id: user.id }, body: { amount: 50, destination: 'not-valid', network: 'POLYGON' }, app: mockApp(prisma) },
      res
    );
    expect(res._status).toBe(400);
  });

  test('B: admin approve transitions PENDING withdrawal to APPROVED', async () => {
    const user  = await seedUser(prisma, { availableBalance: 200 });
    const admin = await seedUser(prisma, { role: 'ADMIN' });
    const wr = await prisma.withdrawal.create({
      data: { userId: user.id, amount: 100, status: 'PENDING', payoutMethod: 'MOMO', destination: '0241234567' },
    });
    const res = mockRes();
    await adminCtrl.approveWithdrawal(
      { user: { id: admin.id, username: 'admin' }, params: { id: String(wr.id) }, body: {}, ip: '127.0.0.1', app: mockApp(prisma) },
      res
    );
    expect(res._status).toBe(200);
    const updated = await prisma.withdrawal.findUnique({ where: { id: wr.id } });
    expect(updated.status).toBe('APPROVED');
  });

  test('C: admin reject refunds balance and marks REJECTED', async () => {
    const user  = await seedUser(prisma, { availableBalance: 200 });
    const admin = await seedUser(prisma, { role: 'ADMIN' });
    const wr = await prisma.withdrawal.create({
      data: { userId: user.id, amount: 100, status: 'PENDING', payoutMethod: 'MOMO', destination: '0241234567' },
    });
    const res = mockRes();
    await adminCtrl.rejectWithdrawal(
      { user: { id: admin.id, username: 'admin' }, params: { id: String(wr.id) }, body: { reason: 'Test' }, ip: '127.0.0.1', app: mockApp(prisma) },
      res
    );
    expect(res._status).toBe(200);
    const updated = await prisma.withdrawal.findUnique({ where: { id: wr.id } });
    expect(updated.status).toBe('REJECTED');
    const refunded = await prisma.user.findUnique({ where: { id: user.id } });
    expect(Number(refunded.availableBalance)).toBe(300); // 200 + 100 refund
  });
});
