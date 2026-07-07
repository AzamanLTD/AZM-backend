// __tests__/transit-trip-crud.test.js
// Covers the business-facing transit trip CRUD added alongside the seat-tier work:
//   A. listMyTransitTrips scopes strictly to the caller's own business (no cross-tenant leak)
//   B. updateTransitTrip lets the owner edit schedule/fare/status but rejects other businesses
//   C. deleteTransitTrip blocks when the trip has bookings, succeeds when it has none
// SKIPS unless TEST_DATABASE_URL is set.
const { seedUser, seedBusiness } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[transit-trip-crud.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Transit trip CRUD (business portal)', () => {
  let prisma;
  let ctrl;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    ctrl = require('../controllers/marketplaceController');
  });

  afterAll(async () => { await prisma.$disconnect(); });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User", "BusinessProfile", "BusinessProduct", "TransitVehicle", "TransitTrip", "TransitSeatMap", "TransitBooking", "TransitBookingSeat" RESTART IDENTITY CASCADE'
    );
  });

  function mockReqRes({ user, params = {}, query = {}, body = {} } = {}) {
    const req = {
      user, params, query, body,
      app: { get: () => prisma },
    };
    const res = {
      statusCode: 200,
      payload: undefined,
      status(c) { this.statusCode = c; return this; },
      json(p) { this.payload = p; return this; },
    };
    return { req, res };
  }

  async function seedTripFor(biz, overrides = {}) {
    const vehicle = await prisma.transitVehicle.create({
      data: { businessProfileId: biz.id, type: 'BUS', capacity: 30, licensePlate: 'GT-1234-26' },
    });
    const trip = await prisma.transitTrip.create({
      data: {
        businessProfileId: biz.id,
        vehicleId: vehicle.id,
        routeName: 'Accra-Kumasi Express',
        origin: 'Accra',
        destination: 'Kumasi',
        departureAt: new Date(Date.now() + 3600_000),
        fareUsdc: 25,
        availableSeats: 30,
        ...overrides,
      },
    });
    return { vehicle, trip };
  }

  test('A. listMyTransitTrips only returns the caller\'s own trips, never another business\'s', async () => {
    const { owner: ownerA, biz: bizA } = await seedBusiness(prisma);
    const { biz: bizB } = await seedBusiness(prisma);
    await seedTripFor(bizA);
    await seedTripFor(bizB);

    const { req, res } = mockReqRes({ user: { id: ownerA.id } });
    await ctrl.listMyTransitTrips(req, res);

    expect(res.payload.success).toBe(true);
    expect(res.payload.trips).toHaveLength(1);
    expect(res.payload.trips[0].businessProfileId).toBe(bizA.id);
  });

  test('B1. updateTransitTrip lets the owning business edit fare/status/schedule', async () => {
    const { owner, biz } = await seedBusiness(prisma);
    const { trip } = await seedTripFor(biz);

    const { req, res } = mockReqRes({
      user: { id: owner.id },
      params: { id: trip.id },
      body: { fareUsdc: 30, status: 'BOARDING' },
    });
    await ctrl.updateTransitTrip(req, res);

    expect(res.payload.success).toBe(true);
    expect(Number(res.payload.trip.fareUsdc)).toBe(30);
    expect(res.payload.trip.status).toBe('BOARDING');
  });

  test('B2. updateTransitTrip rejects edits from a business that does not own the trip', async () => {
    const { biz: bizA } = await seedBusiness(prisma);
    const { owner: ownerB } = await seedBusiness(prisma);
    const { trip } = await seedTripFor(bizA);

    const { req, res } = mockReqRes({
      user: { id: ownerB.id },
      params: { id: trip.id },
      body: { fareUsdc: 999 },
    });
    await ctrl.updateTransitTrip(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.payload.success).toBe(false);
  });

  test('C1. deleteTransitTrip succeeds when the trip has no bookings', async () => {
    const { owner, biz } = await seedBusiness(prisma);
    const { trip } = await seedTripFor(biz);

    const { req, res } = mockReqRes({ user: { id: owner.id }, params: { id: trip.id } });
    await ctrl.deleteTransitTrip(req, res);

    expect(res.payload.success).toBe(true);
    const stillThere = await prisma.transitTrip.findUnique({ where: { id: trip.id } });
    expect(stillThere).toBeNull();
  });

  test('C2. deleteTransitTrip blocks when the trip has an existing seat booking', async () => {
    const { owner, biz } = await seedBusiness(prisma);
    const { trip, vehicle } = await seedTripFor(biz);
    const customer = await seedUser(prisma, { availableBalance: 100 });

    const booking = await prisma.transitBooking.create({
      data: {
        businessProfileId: biz.id,
        vehicleId: vehicle.id,
        customerId: customer.id,
        status: 'PENDING',
        bookingRef: `BK-TEST-${trip.id.slice(0, 8)}`,
        pickupAddress: 'Accra Station',
        dropoffAddress: 'Kumasi Station',
        amountUsdc: 25,
      },
    });
    await prisma.transitBookingSeat.create({
      data: { tripId: trip.id, bookingId: booking.id, seatId: '1A' },
    });

    const { req, res } = mockReqRes({ user: { id: owner.id }, params: { id: trip.id } });
    await ctrl.deleteTransitTrip(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload.success).toBe(false);
    const stillThere = await prisma.transitTrip.findUnique({ where: { id: trip.id } });
    expect(stillThere).not.toBeNull();
  });
});
