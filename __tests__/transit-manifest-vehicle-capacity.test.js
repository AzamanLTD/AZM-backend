// The business routes' manifest and boarding (services/businessOS/transitOpsService)
// are the transit boarding service's, reached with the business owner's id
// once the trip or booking is proven to be the business's. (They used to read
// trip.reservations, which transit trips do not have; this file used to mock
// that relation, so it passed while every real request failed.)
jest.mock('../services/transitBoardingService', () => ({
    buildTripManifest: jest.fn(async () => ({ trip: { id: 'trip-a' }, passengers: [], seats: [], counts: { booked: 0 } })),
    boardByIdCheck: jest.fn(async () => ({ booking: { id: 'bk-a', customerId: 7, status: 'IN_PROGRESS' } })),
}));
const boarding = require('../services/transitBoardingService');
const { TransitOpsService } = require('../services/businessOS/transitOpsService');

const prismaFor = ({ trip = { id: 'trip-a' }, booking = { id: 'bk-a' }, ownerId = 42 } = {}) => ({
    transitTrip: { findFirst: jest.fn(async () => trip) },
    transitBooking: { findFirst: jest.fn(async () => booking) },
    businessProfile: { findUnique: jest.fn(async () => (ownerId ? { userId: ownerId } : null)) },
});

beforeEach(() => jest.clearAllMocks());

describe('business manifest', () => {
    test('is the transit manifest, built for the business owner', async () => {
        const prisma = prismaFor();
        const out = await new TransitOpsService(prisma).getTripManifest('trip-a', 'business-a');
        expect(prisma.transitTrip.findFirst).toHaveBeenCalledWith({ where: { id: 'trip-a', businessProfileId: 'business-a' }, select: { id: true } });
        expect(boarding.buildTripManifest).toHaveBeenCalledWith(prisma, { tripId: 'trip-a', businessUserId: 42 });
        expect(out.trip.id).toBe('trip-a');
    });

    test("a coded refusal keeps its HTTP status for the business routes", async () => {
        boarding.buildTripManifest.mockRejectedValueOnce(Object.assign(new Error('Trip not found.'), { code: 'NOT_FOUND', httpStatus: 404 }));
        await expect(new TransitOpsService(prismaFor()).getTripManifest('trip-a', 'business-a'))
            .rejects.toEqual(expect.objectContaining({ statusCode: 404 }));
    });
});

describe('business boarding by ID check', () => {
    test("boards through the transit rule with the owner's id", async () => {
        const prisma = prismaFor();
        const out = await new TransitOpsService(prisma).boardPassenger({ bookingId: 'bk-a', azamanId: 'AZM-1' }, 'business-a');
        expect(prisma.transitBooking.findFirst).toHaveBeenCalledWith({ where: { id: 'bk-a', businessProfileId: 'business-a' }, select: { id: true } });
        expect(boarding.boardByIdCheck).toHaveBeenCalledWith(prisma, { bookingId: 'bk-a', businessUserId: 42, azamanId: 'AZM-1' });
        expect(out.booking.status).toBe('IN_PROGRESS');
    });

    test('a wrong AZM-ID is a 409, not a 400', async () => {
        boarding.boardByIdCheck.mockRejectedValueOnce(Object.assign(new Error('That AZM-ID is not the passenger on this booking.'), { code: 'AZAMAN_ID_MISMATCH', httpStatus: 409 }));
        await expect(new TransitOpsService(prismaFor()).boardPassenger({ bookingId: 'bk-a', azamanId: 'AZM-2' }, 'business-a'))
            .rejects.toEqual(expect.objectContaining({ statusCode: 409, code: 'AZAMAN_ID_MISMATCH' }));
    });

    test('needs a booking id', async () => {
        await expect(new TransitOpsService(prismaFor()).boardPassenger({ azamanId: 'AZM-1' }, 'business-a'))
            .rejects.toEqual(expect.objectContaining({ statusCode: 400 }));
        expect(boarding.boardByIdCheck).not.toHaveBeenCalled();
    });
});

describe('vehicle seat map save', () => {
    const save = (prisma, body) => new TransitOpsService(prisma).saveSeatMap('veh-a', body, 'business-a');
    const withVehicle = (booked = []) => {
        const db = {
            transitVehicle: { findFirst: jest.fn(async () => ({ id: 'veh-a' })) },
            transitBookingSeat: { findMany: jest.fn(async () => booked), count: jest.fn(async () => booked.length) },
            transitSeatMap: { upsert: jest.fn(async ({ create }) => create) },
            transitTrip: { findMany: jest.fn(async () => [{ id: 'trip-a' }]), update: jest.fn(async () => ({})) },
            $executeRaw: jest.fn(async () => 1),
        };
        db.$transaction = jest.fn(async (cb) => cb(db));
        return db;
    };

    test("another business's vehicle reads as missing", async () => {
        const prisma = { ...withVehicle(), transitVehicle: { findFirst: jest.fn(async () => null) } };
        await expect(save(prisma, { layout: [{ seatId: '1A' }], rows: 1, cols: 1 })).rejects.toEqual(expect.objectContaining({ statusCode: 404 }));
        expect(prisma.transitVehicle.findFirst).toHaveBeenCalledWith({ where: { id: 'veh-a', businessProfileId: 'business-a' }, select: { id: true } });
        expect(prisma.transitSeatMap.upsert).not.toHaveBeenCalled();
    });

    test('an invalid grid is a 400', async () => {
        const prisma = withVehicle();
        await expect(save(prisma, { layout: [{ seatId: '1A' }], rows: 0, cols: 1 })).rejects.toEqual(expect.objectContaining({ statusCode: 400 }));
        expect(prisma.transitSeatMap.upsert).not.toHaveBeenCalled();
    });

    test('dropping a booked seat is a 409', async () => {
        const prisma = withVehicle([{ seatId: '1B' }]);
        await expect(save(prisma, { layout: [{ seatId: '1A' }, { seatId: '1B', type: 'NONE' }], rows: 1, cols: 2 }))
            .rejects.toEqual(expect.objectContaining({ statusCode: 409, code: 'SEAT_MAP_BOOKED_SEATS' }));
        expect(prisma.transitSeatMap.upsert).not.toHaveBeenCalled();
    });

    test('a valid grid saves', async () => {
        const prisma = withVehicle([{ seatId: '1A' }]);
        const out = await save(prisma, { layout: [{ seatId: '1A' }, { seatId: '1B', status: 'BLOCKED' }], rows: 1, cols: 2 });
        expect(out).toEqual(expect.objectContaining({ vehicleId: 'veh-a', rows: 1, cols: 2 }));
        // The open trip's counter follows the new grid: 1 bookable, 1 held.
        expect(prisma.transitTrip.update).toHaveBeenCalledWith({ where: { id: 'trip-a' }, data: { availableSeats: 0 } });
    });
});
