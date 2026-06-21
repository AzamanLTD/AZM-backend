// __tests__/peer-transfer.test.js
// Covers (against the REAL peerTransferController + PeerTransfer/Friendship models):
//   A. sendFunds debits sender, credits receiver atomically
//   B. sendFunds with insufficient balance → 400, no side effects
//   C. requestFunds + fulfillTransferRequest: full lifecycle
//
// Real shapes (verified, not the design-doc shapes):
//   • Transfers are scoped to an ACCEPTED Friendship; sendFunds/requestFunds
//     take { friendshipId, amount, reference } (NOT recipientId/amountUsdc).
//     The sender/receiver are derived from the friendship + req.user.id.
//   • fulfillTransferRequest takes the transfer id from req.params.id.
// SKIPS unless TEST_DATABASE_URL is set.
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[peer-transfer.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Peer transfer', () => {
  let prisma, ctrl;
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV     = 'test';
    process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    ctrl   = require('../controllers/peerTransferController');
  });

  afterAll(async () => { if (prisma) await prisma.$disconnect(); });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User", "PeerTransfer", "Friendship", "TransactionHistory" RESTART IDENTITY CASCADE'
    );
  });

  function mockRes() {
    const r = { _status: 200, _body: null };
    r.status = (s) => { r._status = s; return r; };
    r.json   = (b) => { r._body  = b; return r; };
    return r;
  }
  function mockApp(p) {
    return {
      get: (k) =>
        k === 'prisma' ? p :
        k === 'socketio' ? { to: () => ({ emit: () => {} }) } :
        k === 'emitBalanceUpdate' ? (async () => {}) : null,
    };
  }
  async function makeFriends(a, b) {
    return prisma.friendship.create({
      data: { requesterId: a.id, addresseeId: b.id, status: 'ACCEPTED' },
    });
  }

  test('A: sendFunds debits sender and credits receiver', async () => {
    const sender   = await seedUser(prisma, { availableBalance: 500 });
    const receiver = await seedUser(prisma, { availableBalance: 0 });
    const friendship = await makeFriends(sender, receiver);

    const res = mockRes();
    await ctrl.sendFunds(
      { user: { id: sender.id }, body: { friendshipId: friendship.id, amount: 100, reference: 'test', clientRequestId: 'k_send_1' }, app: mockApp(prisma) },
      res
    );
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);

    const s = await prisma.user.findUnique({ where: { id: sender.id } });
    const r = await prisma.user.findUnique({ where: { id: receiver.id } });
    expect(Number(s.availableBalance)).toBeLessThan(500);
    expect(Number(r.availableBalance)).toBeGreaterThan(0);
    // Money conserved (minus any platform fee).
    const total = Number(s.availableBalance) + Number(r.availableBalance);
    expect(total).toBeLessThanOrEqual(500);
    expect(total).toBeGreaterThan(450);
  });

  test('B: sendFunds insufficient balance → 400, no side effects', async () => {
    const sender   = await seedUser(prisma, { availableBalance: 10 });
    const receiver = await seedUser(prisma, { availableBalance: 0 });
    const friendship = await makeFriends(sender, receiver);

    const res = mockRes();
    await ctrl.sendFunds(
      { user: { id: sender.id }, body: { friendshipId: friendship.id, amount: 500, reference: 'x', clientRequestId: 'k_send_2' }, app: mockApp(prisma) },
      res
    );
    expect(res._status).toBe(400);
    expect(Number((await prisma.user.findUnique({ where: { id: sender.id } })).availableBalance)).toBe(10);
    expect(Number((await prisma.user.findUnique({ where: { id: receiver.id } })).availableBalance)).toBe(0);
  });

  test('C: requestFunds + fulfill: full lifecycle', async () => {
    const requester = await seedUser(prisma, { availableBalance: 0 });
    const payer     = await seedUser(prisma, { availableBalance: 300 });
    const friendship = await makeFriends(requester, payer);

    const reqRes = mockRes();
    await ctrl.requestFunds(
      { user: { id: requester.id }, body: { friendshipId: friendship.id, amount: 75, reference: 'pay me back' }, app: mockApp(prisma) },
      reqRes
    );
    expect(reqRes._status).toBe(201); // requestFunds returns 201 Created
    const transferId =
      reqRes._body.transfer?.id ?? reqRes._body.transfer?.transferId ?? reqRes._body.transferId ?? reqRes._body.id;
    expect(transferId).toBeTruthy();

    const fulRes = mockRes();
    await ctrl.fulfillTransferRequest(
      { user: { id: payer.id }, params: { id: String(transferId) }, app: mockApp(prisma) },
      fulRes
    );
    expect(fulRes._status).toBe(200);
    expect(Number((await prisma.user.findUnique({ where: { id: requester.id } })).availableBalance)).toBeGreaterThan(0);
  });
});
