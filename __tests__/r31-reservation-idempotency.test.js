// HTTP controller semantics backed by PostgreSQL, including replay after cancellation.
const { PrismaClient } = require('@prisma/client');
const { seedBusiness, seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
(hasDb ? describe : describe.skip)('r31 reservation request identity (real PostgreSQL)', () => {
  let db, controller, biz, customer;
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = new PrismaClient();
    controller = require('../controllers/reservationController');
  });
  afterAll(async () => db.$disconnect());
  afterEach(async () => db.$executeRawUnsafe('TRUNCATE TABLE "Reservation", "TransactionHistory", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE'));
  const setup = async () => {
    ({ biz } = await seedBusiness(db)); customer = await seedUser(db, { availableBalance: 0 });
  };
  const payload = (extra = {}) => ({
    bizId: biz.bizId, startDatetime: new Date(Date.now() + 7 * 86400000).toISOString(),
    endDatetime: new Date(Date.now() + 8 * 86400000).toISOString(),
    serviceItemId: 'service-1', amountUsdc: '10.12345678', depositUsdc: '0.12345678',
    ...extra,
  });
  const call = async (body, key) => {
    const req = { app: { get: () => db }, user: { id: customer.id }, body,
      headers: key ? { 'idempotency-key': key } : {} };
    const res = { statusCode: null, status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; } };
    await controller.createReservation(req, res);
    return res;
  };
  test('same key replays exact row, not a second booking or second webhook', async () => {
    await setup(); const b = payload();
    const first = await call(b, 'request-1');
    const replay = await call(b, 'request-1');
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.reservation.id).toBe(first.body.reservation.id);
    expect(replay.body.reservation.amountUsdc.toString()).toBe('10.12345678');
    expect(await db.reservation.count()).toBe(1);
  });
  test('same key with different payload conflicts without overwriting', async () => {
    await setup(); const b = payload();
    const first = await call(b, 'request-2');
    const mismatch = await call({ ...b, amountUsdc: '11' }, 'request-2');
    expect(first.statusCode).toBe(201);
    expect(mismatch.statusCode).toBe(409);
    expect(await db.reservation.count()).toBe(1);
  });
  test('legacy identical timeout retry does not create a fresh booking after cancellation', async () => {
    await setup(); const b = payload();
    const first = await call(b);
    expect(first.statusCode).toBe(201);
    await db.reservation.update({ where: { id: first.body.reservation.id }, data: { status: 'CANCELLED_CUSTOMER' } });
    const replay = await call(b);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.reservation.id).toBe(first.body.reservation.id);
    expect(replay.body.reservation.status).toBe('CANCELLED_CUSTOMER');
    expect(await db.reservation.count()).toBe(1);
    const fresh = await call(b, 'new-intent-3');
    expect(fresh.statusCode).toBe(201);
    expect(await db.reservation.count()).toBe(2);
  });
  test('concurrent identical keys converge to one booking', async () => {
    await setup(); const b = payload();
    const [one, two] = await Promise.all([call(b, 'request-4'), call(b, 'request-4')]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 201]);
    expect(one.body.reservation.id).toBe(two.body.reservation.id);
    expect(await db.reservation.count()).toBe(1);
  });
  test('replayed booking cannot acquire a second fundable escrow or orphan ticket', async () => {
    await setup(); const b = payload();
    const first = await call(b, 'escrow-link-1');
    expect(first.statusCode).toBe(201);
    const { createBookingEscrow } = require('../services/bookingEscrowService');
    const input = { bookingType: 'RESERVATION', bookingId: first.body.reservation.id,
      payerId: customer.id, payeeId: biz.userId, amountUsdc: '10', businessProfileId: biz.id };
    const linked = await createBookingEscrow(db, input);
    const replay = await call(b, 'escrow-link-1');
    expect(replay.statusCode).toBe(200);
    expect(replay.body.reservation.id).toBe(first.body.reservation.id);
    expect(replay.body.reservation.escrowId).toBe(linked.escrow.id);
    expect(replay.body.reservation.ticketId).toBe(linked.ticket.id);
    await expect(createBookingEscrow(db, input)).rejects.toMatchObject({ code: 'BOOKING_ESCROW_LINK_CONFLICT' });
    expect(await db.reservation.count()).toBe(1);
    expect(await db.smartEscrow.count()).toBe(1);
    expect(await db.ticket.count()).toBe(1);
  });
  test('different keys for overlapping slots yield one success and a real 409', async () => {
    await setup(); const b = payload();
    const [one, two] = await Promise.all([call(b, 'request-5'), call(b, 'request-6')]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409]);
    expect(await db.reservation.count()).toBe(1);
  });
});
