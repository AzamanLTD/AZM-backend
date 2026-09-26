// Real PostgreSQL transactions: capacity is enforced by the database, not JS mutexes.
const { PrismaClient, Prisma } = require('@prisma/client');
const { seedBusiness, seedUser } = require('./helpers/factories');
const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r31 reservation capacity authority (real PostgreSQL)', () => {
  let db, db2, seq = 0;
  const day = 86400000;
  const base = new Date(Date.now() + 7 * day);
  const slot = (from = 0, to = 1) => ({ startDatetime: new Date(+base + from * day), endDatetime: new Date(+base + to * day) });
  const ref = () => `RES-R31-${Date.now()}-${++seq}`;
  beforeAll(() => { process.env.DATABASE_URL = url; db = new PrismaClient(); db2 = new PrismaClient(); });
  afterAll(async () => { await db.$disconnect(); await db2.$disconnect(); });
  afterEach(async () => db.$executeRawUnsafe('TRUNCATE TABLE "Reservation", "HotelRoomBlock", "HotelRoom", "TransactionHistory", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE'));
  const seed = async () => {
    const { biz, product } = await seedBusiness(db);
    const customer = await seedUser(db, { availableBalance: 0 });
    return { biz, product, customer };
  };
  const make = ({ biz, customer }, extra = {}) => ({
    reservationRef: ref(), businessProfileId: biz.id, customerId: customer.id,
    amountUsdc: new Prisma.Decimal('10.12345678'), depositUsdc: new Prisma.Decimal(0),
    ...slot(), ...extra,
  });
  const race = async (a, b) => Promise.allSettled([a(), b()]);
  const winners = (results) => results.filter(x => x.status === 'fulfilled').length;
  const active = (bizId) => db.reservation.findMany({ where: { businessProfileId: bizId, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } } });
  const room = async (biz) => db.hotelRoom.create({ data: {
    businessProfileId: biz.id, roomNumber: `R${++seq}`, roomType: 'STANDARD',
    capacity: 2, status: 'AVAILABLE', basePriceUsdc: '10', amenities: [], imageUrls: [],
  } });

  test('identical requests: exactly one row commits', async () => {
    const c = await seed(); const data = make(c, { serviceItemId: c.product.id });
    const results = await race(() => db.reservation.create({ data: { ...data, reservationRef: ref() } }),
      () => db2.reservation.create({ data: { ...data, reservationRef: ref() } }));
    expect(winners(results)).toBe(1);
    expect(await active(c.biz.id)).toHaveLength(1);
  });
  test('partially overlapping service intervals conflict, adjacent ones coexist', async () => {
    const c = await seed();
    const results = await race(() => db.reservation.create({ data: make(c, { serviceItemId: c.product.id, ...slot(0, 2) }) }),
      () => db2.reservation.create({ data: make(c, { serviceItemId: c.product.id, ...slot(1, 3) }) }));
    expect(winners(results)).toBe(1);
    await db.reservation.create({ data: make(c, { serviceItemId: c.product.id, ...slot(3, 4) }) });
    expect(await active(c.biz.id)).toHaveLength(2);
  });
  test('same hotel room conflicts; different rooms and adjacent dates succeed', async () => {
    const c = await seed(); const r1 = await room(c.biz); const r2 = await room(c.biz);
    const results = await race(() => db.reservation.create({ data: make(c, { serviceItemId: r1.id }) }),
      () => db2.reservation.create({ data: make(c, { serviceItemId: r1.id }) }));
    expect(winners(results)).toBe(1);
    await db.reservation.create({ data: make(c, { serviceItemId: r1.id, ...slot(1, 2) }) });
    await db.reservation.create({ data: make(c, { serviceItemId: r2.id }) });
    expect(await active(c.biz.id)).toHaveLength(3);
  });
  test('a room cannot be double-booked through a forged location', async () => {
    const c = await seed(); const r = await room(c.biz);
    await db.reservation.create({ data: make(c, { serviceItemId: r.id }) });
    await expect(db2.reservation.create({ data: make(c, {
      serviceItemId: r.id, locationId: 'forged-location',
    }) })).rejects.toBeDefined();
    expect(await active(c.biz.id)).toHaveLength(1);
  });
  test('room block and reservation race: one wins, never both', async () => {
    const c = await seed(); const r = await room(c.biz);
    const results = await race(() => db.reservation.create({ data: make(c, { serviceItemId: r.id }) }),
      () => db2.hotelRoomBlock.create({ data: { roomId: r.id, startDate: slot().startDatetime, endDate: slot().endDatetime } }));
    expect(winners(results)).toBe(1);
    expect((await active(c.biz.id)).length + await db.hotelRoomBlock.count({ where: { roomId: r.id } })).toBe(1);
  });
  test('room becoming unavailable and reservation race: one wins', async () => {
    const c = await seed(); const r = await room(c.biz);
    const results = await race(() => db.reservation.create({ data: make(c, { serviceItemId: r.id }) }),
      () => db2.hotelRoom.update({ where: { id: r.id }, data: { status: 'MAINTENANCE' } }));
    expect(winners(results)).toBe(1);
    const current = await db.hotelRoom.findUnique({ where: { id: r.id } });
    expect((await active(c.biz.id)).length + Number(current.status === 'MAINTENANCE')).toBe(1);
  });
  test('cancellation frees room; creation racing cancellation is consistent', async () => {
    const c = await seed(); const r = await room(c.biz);
    const old = await db.reservation.create({ data: make(c, { serviceItemId: r.id }) });
    const results = await race(() => db.reservation.update({ where: { id: old.id }, data: { status: 'CANCELLED_CUSTOMER' } }),
      () => db2.reservation.create({ data: make(c, { serviceItemId: r.id }) }));
    expect(results[0].status).toBe('fulfilled');
    expect((await active(c.biz.id)).length).toBeLessThanOrEqual(1);
    if (winners(results) === 1) await db.reservation.create({ data: make(c, { serviceItemId: r.id }) });
    expect(await active(c.biz.id)).toHaveLength(1);
  });
  test('reschedule and new booking race on newly claimed dates', async () => {
    const c = await seed();
    const old = await db.reservation.create({ data: make(c, { serviceItemId: c.product.id, ...slot(0, 1) }) });
    const results = await race(
      () => db.reservation.update({ where: { id: old.id }, data: { endDatetime: slot(0, 2).endDatetime } }),
      () => db2.reservation.create({ data: make(c, { serviceItemId: c.product.id, ...slot(1, 2) }) }),
    );
    expect(winners(results)).toBe(1);
    const rows = await active(c.biz.id);
    if (rows.length === 2) expect(rows.find(r => r.id === old.id).endDatetime).toEqual(slot(0, 1).endDatetime);
    else expect(rows[0].endDatetime).toEqual(slot(0, 2).endDatetime);
  });
  test('room move and reservation creation race on target room', async () => {
    const c = await seed(); const oldRoom = await room(c.biz), target = await room(c.biz);
    const existing = await db.reservation.create({ data: make(c, { serviceItemId: oldRoom.id }) });
    const { HotelOpsService } = require('../services/businessOS/hotelOpsService');
    const results = await race(
      () => new HotelOpsService(db).moveRoom(existing.id, { newRoomId: target.id, reason: 'test move' }, c.biz.id),
      () => db2.reservation.create({ data: make(c, { serviceItemId: target.id }) }),
    );
    expect(winners(results)).toBe(1);
    expect((await active(c.biz.id)).filter(r => r.serviceItemId === target.id)).toHaveLength(1);
  });
  test('different businesses are isolated', async () => {
    const a = await seed(), b = await seed();
    const results = await race(() => db.reservation.create({ data: make(a, { serviceItemId: 'shared-resource' }) }),
      () => db2.reservation.create({ data: make(b, { serviceItemId: 'shared-resource' }) }));
    expect(winners(results)).toBe(2);
    expect(await active(a.biz.id)).toHaveLength(1);
    expect(await active(b.biz.id)).toHaveLength(1);
  });
  test('front-desk walk-in creates a valid checked-in row and occupies exactly one room', async () => {
    const c = await seed(); const r = await room(c.biz);
    const { HotelOpsService } = require('../services/businessOS/hotelOpsService');
    const svc = new HotelOpsService(db);
    const reservation = await svc.createWalkIn(c.biz.id, {
      customerId: c.customer.id, roomId: r.id, nights: 2, depositUsdc: '0.125', phone: 'test',
    });
    expect(reservation.reservationRef).toMatch(/^RES-/);
    expect(reservation.customerNotes).toContain('Phone: test');
    expect(reservation.amountUsdc.toString()).toBe('20');
    expect(reservation.depositUsdc.toString()).toBe('0.125');
    expect(reservation.status).toBe('CHECKED_IN');
    expect(await active(c.biz.id)).toHaveLength(1);
    expect((await db.hotelRoom.findUnique({ where: { id: r.id } })).status).toBe('OCCUPIED');
  });

  test('post-claim failure rolls back the row, allowing a retry', async () => {
    const c = await seed();
    await expect(db.$transaction(async tx => {
      await tx.reservation.create({ data: make(c) });
      throw new Error('injected after claim');
    })).rejects.toThrow('injected after claim');
    expect(await active(c.biz.id)).toHaveLength(0);
    await db2.reservation.create({ data: make(c) });
    expect(await active(c.biz.id)).toHaveLength(1);
  });
});
