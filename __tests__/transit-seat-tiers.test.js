// __tests__/transit-seat-tiers.test.js
// Covers the new tier-aware seat pricing added to transitBookingService + marketplaceSeatMapController:
//   A. Seat map save with tiers + tier fares persists correctly (additive, on TransitSeatMap.layout + TransitTrip.metadata)
//   B. bookSeats charges the correct per-tier fare (not the flat trip.fareUsdc) when tiers are tagged
//   C. Untagged seats / trips with no tierFares fall back to the flat fareUsdc (backward compatibility)
//   D. Invalid tier values are rejected by the controller validation
// SKIPS unless TEST_DATABASE_URL is set.
const { seedUser, seedBusiness } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[transit-seat-tiers.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Transit seat tiers', () => {
  let prisma;
  let bookSeats, getTripSeatAvailability;
  let seatMapCtrl;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    ({ bookSeats, getTripSeatAvailability } = require('../services/transitBookingService'));
    seatMapCtrl = require('../controllers/marketplaceSeatMapController');
  });

  afterAll(async () => { await prisma.$disconnect(); });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User", "BusinessProfile", "BusinessProduct", "TransitVehicle", "TransitTrip", "TransitSeatMap", "TransitBooking", "TransitBookingSeat" RESTART IDENTITY CASCADE'
    );
  });

  async function seedTrip(prisma, { fareUsdc = 10, layout, tierFares } = {}) {
    const { owner, biz } = await seedBusiness(prisma);
    const vehicle = await prisma.transitVehicle.create({
      data: { businessProfileId: biz.id, type: 'VAN', capacity: 4 },
    });
    const trip = await prisma.transitTrip.create({
      data: {
        businessProfileId: biz.id,
        vehicleId: vehicle.id,
        routeName: 'Accra-Kumasi',
        origin: 'Accra',
        destination: 'Kumasi',
        departureAt: new Date(Date.now() + 3600_000),
        fareUsdc,
        availableSeats: 4,
        metadata: tierFares ? { tierFares } : null,
      },
    });
    if (layout) {
      await prisma.transitSeatMap.create({
        data: { vehicleId: vehicle.id, layout, rows: 2, cols: 2 },
      });
    }
    const customer = await seedUser(prisma, { availableBalance: 500 });
    return { owner, biz, vehicle, trip, customer };
  }

  test('A. saveSeatMap persists tier tags + tier fares additively', async () => {
    const { trip } = await seedTrip(prisma, { fareUsdc: 10 });
    const layout = [
      { seatId: '1A', row: 1, col: 1, type: 'WINDOW', tier: 'VIP' },
      { seatId: '1B', row: 1, col: 2, type: 'AISLE', tier: 'STANDARD' },
    ];
    const tierFares = { VIP: 25, STANDARD: 15, ECONOMY: 8 };

    let statusCode, payload;
    const req = { params: { tripId: trip.id }, body: { layout, rows: 1, cols: 2, tierFares }, prisma };
    const res = {
      status(c) { statusCode = c; return this; },
      json(p) { payload = p; return this; },
    };
    await seatMapCtrl.saveSeatMap(req, res);

    expect(statusCode).toBeUndefined(); // no error path hit
    expect(payload.success).toBe(true);
    expect(payload.tierFares).toEqual(tierFares);

    const savedMap = await prisma.transitSeatMap.findUnique({ where: { vehicleId: (await prisma.transitTrip.findUnique({ where: { id: trip.id } })).vehicleId } });
    expect(savedMap.layout).toEqual(layout);

    const updatedTrip = await prisma.transitTrip.findUnique({ where: { id: trip.id } });
    expect(updatedTrip.metadata.tierFares).toEqual(tierFares);
  });

  test('B. bookSeats charges per-tier fare, not the flat trip fare', async () => {
    const layout = [
      { seatId: '1A', row: 1, col: 1, type: 'WINDOW', tier: 'VIP' },
      { seatId: '1B', row: 1, col: 2, type: 'AISLE', tier: 'ECONOMY' },
    ];
    const tierFares = { VIP: 25, STANDARD: 15, ECONOMY: 8 };
    const { trip, customer } = await seedTrip(prisma, { fareUsdc: 10, layout, tierFares });

    const result = await bookSeats(prisma, {
      tripId: trip.id,
      customerId: customer.id,
      seatIds: ['1A', '1B'],
      businessProfileId: trip.businessProfileId,
    });

    expect(result.success).toBe(true);
    // VIP (25) + ECONOMY (8) = 33, NOT flat 10*2=20
    expect(result.totalFare).toBe(33);
  });

  test('C. untagged seats / no tierFares fall back to flat fareUsdc', async () => {
    const layout = [
      { seatId: '1A', row: 1, col: 1, type: 'WINDOW' }, // no tier tag
      { seatId: '1B', row: 1, col: 2, type: 'AISLE' },
    ];
    const { trip, customer } = await seedTrip(prisma, { fareUsdc: 12, layout }); // no tierFares at all

    const result = await bookSeats(prisma, {
      tripId: trip.id,
      customerId: customer.id,
      seatIds: ['1A', '1B'],
      businessProfileId: trip.businessProfileId,
    });

    expect(result.success).toBe(true);
    expect(result.totalFare).toBe(24); // flat 12*2, unchanged behavior
  });

  test('D. controller rejects invalid tier values', async () => {
    const { trip } = await seedTrip(prisma, { fareUsdc: 10 });
    const layout = [{ seatId: '1A', row: 1, col: 1, type: 'WINDOW', tier: 'GOLD_CLASS' }];

    let statusCode, payload;
    const req = { params: { tripId: trip.id }, body: { layout, rows: 1, cols: 1 }, prisma };
    const res = {
      status(c) { statusCode = c; return this; },
      json(p) { payload = p; return this; },
    };
    await seatMapCtrl.saveSeatMap(req, res);

    expect(statusCode).toBe(400);
    expect(payload.success).toBe(false);
    expect(payload.message).toMatch(/Invalid seat tier/);
  });

  test('E. getTripSeatAvailability returns per-seat tier + computed fare', async () => {
    const layout = [
      { seatId: '1A', row: 1, col: 1, type: 'WINDOW', tier: 'VIP' },
      { seatId: '1B', row: 1, col: 2, type: 'AISLE', tier: 'STANDARD' },
    ];
    const tierFares = { VIP: 25, STANDARD: 15 };
    const { trip } = await seedTrip(prisma, { fareUsdc: 10, layout, tierFares });

    const availability = await getTripSeatAvailability(prisma, { tripId: trip.id });
    const seat1A = availability.seats.find(s => s.seatId === '1A');
    const seat1B = availability.seats.find(s => s.seatId === '1B');
    expect(seat1A.fare).toBe(25);
    expect(seat1B.fare).toBe(15);
    expect(availability.tierFares).toEqual(tierFares);
  });
});
