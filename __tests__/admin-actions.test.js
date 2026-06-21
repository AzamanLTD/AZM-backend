// __tests__/admin-actions.test.js
// Covers (against the REAL adminController):
//   A. approveKyc: two concurrent calls → exactly one 200 and one 409
//   B. rejectKyc: second call is 409 (atomic conditional flip)
//   C. banUser: real body is { action: 'BAN_24H' } → banStatus 'BANNED_24H'
//
// Note vs design doc: banUser reads `action` (BAN_24H|BAN_1W|BAN_INDEF|UNBAN),
// NOT `duration`; the user id is the :id route param. forceRelease is exercised
// by trade-flow/escrow suites — it routes through p2p.completeTrade which needs
// fee-profile/settings fixtures, so it's intentionally not re-tested here.
// SKIPS unless TEST_DATABASE_URL is set.
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[admin-actions.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Admin privileged actions', () => {
  let prisma, adminCtrl;
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV     = 'test';
    process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    const { PrismaClient } = require('@prisma/client');
    prisma    = new PrismaClient();
    adminCtrl = require('../controllers/adminController');
  });

  afterAll(async () => { if (prisma) await prisma.$disconnect(); });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User", "RefreshToken", "AuditLog", "TransactionHistory" RESTART IDENTITY CASCADE'
    );
  });

  function mockRes() {
    const r = { _status: 200, _body: null };
    r.status = (s) => { r._status = s; return r; };
    r.json   = (b) => { r._body  = b; return r; };
    return r;
  }
  // Stub notificationService so approve/reject don't lazy-init the real one
  // (which would reach for FCM credentials). socketio is a no-op emitter.
  function mockApp(p) {
    const noopNotif = { sendNotification: async () => {} };
    return {
      get: (k) =>
        k === 'prisma' ? p :
        k === 'socketio' ? { to: () => ({ emit: () => {} }), in: () => ({ disconnectSockets: () => {} }) } :
        k === 'notificationService' ? noopNotif :
        k === 'emitBalanceUpdate' ? (async () => {}) : null,
    };
  }

  test('A: two concurrent approveKyc → exactly one 200, one 409', async () => {
    const admin   = await seedUser(prisma, { role: 'ADMIN' });
    const pending = await seedUser(prisma, { kycStatus: 'PENDING' });
    const makeReq = () => ({
      user: { id: admin.id, username: 'admin' },
      body: { userId: pending.id },
      ip: '127.0.0.1',
      app: mockApp(prisma),
    });

    const [r1, r2] = await Promise.all([
      (async () => { const res = mockRes(); await adminCtrl.approveKyc(makeReq(), res); return res; })(),
      (async () => { const res = mockRes(); await adminCtrl.approveKyc(makeReq(), res); return res; })(),
    ]);

    const statuses = [r1._status, r2._status].sort();
    expect(statuses).toEqual([200, 409]);
    const u = await prisma.user.findUnique({ where: { id: pending.id } });
    expect(u.kycStatus).toBe('VERIFIED');
    expect(u.role).toBe('VENDOR');
  });

  test('B: two concurrent rejectKyc → exactly one 200, one 409', async () => {
    // The atomic conditional flip (updateMany WHERE kycStatus=PENDING) only
    // yields a 409 under TRUE concurrency. A sequential second call instead
    // sees status REJECTED and returns 400 ("not pending") — so this must race.
    const admin   = await seedUser(prisma, { role: 'ADMIN' });
    const pending = await seedUser(prisma, { kycStatus: 'PENDING' });
    const makeReq = () => ({ user: { id: admin.id, username: 'admin' }, body: { userId: pending.id, reason: 'Docs unclear' }, ip: '127.0.0.1', app: mockApp(prisma) });

    const [r1, r2] = await Promise.all([
      (async () => { const res = mockRes(); await adminCtrl.rejectKyc(makeReq(), res); return res; })(),
      (async () => { const res = mockRes(); await adminCtrl.rejectKyc(makeReq(), res); return res; })(),
    ]);
    expect([r1._status, r2._status].sort()).toEqual([200, 409]);
    const u = await prisma.user.findUnique({ where: { id: pending.id } });
    expect(u.kycStatus).toBe('REJECTED');
  });

  test('C: banUser sets banStatus on target user', async () => {
    const admin  = await seedUser(prisma, { role: 'ADMIN' });
    const target = await seedUser(prisma, { role: 'USER' });
    const res = mockRes();
    await adminCtrl.banUser(
      { user: { id: admin.id, username: 'admin' }, params: { id: String(target.id) }, body: { action: 'BAN_24H', reason: 'Test ban' }, ip: '127.0.0.1', app: mockApp(prisma) },
      res
    );
    expect(res._status).toBe(200);
    const banned = await prisma.user.findUnique({ where: { id: target.id } });
    expect(banned.banStatus).toBe('BANNED_24H');
  });
});
