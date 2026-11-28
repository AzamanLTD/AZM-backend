// The seat-map save: only the trip's business, validated, and never dropping
// a booked seat; passenger names only for the business; blocked seats are
// not bookable.
jest.mock('../middleware/requirePermission', () => ({ resolvePermissions: jest.fn() }));
const { resolvePermissions } = require('../middleware/requirePermission');
const ctrl = require('../controllers/marketplaceSeatMapController');
const layout = require('../services/transitSeatLayout');

const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const trip = { id: 't1', businessProfileId: 'b1', vehicleId: 'v1', metadata: { x: 1 }, fareUsdc: 5,
    vehicle: { capacity: 4, seatMap: { rows: 1, cols: 2, layout: [] } } };
// The trip's business is b1, owned by user 1; user 9 is an employee whose
// status the test sets (ACTIVE by default).
const prismaWith = (booked = [], { employeeStatus = 'ACTIVE' } = {}) => {
    const db = {
        transitTrip: {
            findUnique: jest.fn(async () => trip),
            findMany: jest.fn(async () => [{ id: 't1' }, { id: 't2' }]),
            update: jest.fn(async ({ where, data }) => ({ ...trip, id: where.id, ...data })),
        },
        transitBookingSeat: { findMany: jest.fn(async () => booked), count: jest.fn(async () => booked.length) },
        transitSeatMap: { upsert: jest.fn(async ({ create }) => create) },
        businessProfile: { findUnique: jest.fn(async () => ({ userId: 1 })) },
        businessEmployee: { findUnique: jest.fn(async () => (employeeStatus ? { status: employeeStatus } : null)) },
        $executeRaw: jest.fn(async () => 1),
    };
    db.$transaction = jest.fn(async (cb) => cb(db));
    return db;
};
const cells = [{ seatId: '1A' }, { seatId: '1B', status: 'BLOCKED' }];

describe('seat map save', () => {
    test('a stranger cannot save', async () => {
        resolvePermissions.mockResolvedValue([]);
        const prisma = prismaWith([], { employeeStatus: null }); const r = res();
        await ctrl.saveSeatMap({ prisma, params: { tripId: 't1' }, user: { id: 9 }, body: { layout: cells, rows: 1, cols: 2 } }, r);
        expect(r.status).toHaveBeenCalledWith(403);
        expect(prisma.transitSeatMap.upsert).not.toHaveBeenCalled();
    });
    test('staff without transit.fleet.manage cannot save', async () => {
        resolvePermissions.mockResolvedValue(['transit.trips.view']);
        const r = res();
        await ctrl.saveSeatMap({ prisma: prismaWith(), params: { tripId: 't1' }, user: { id: 9 }, body: { layout: cells, rows: 1, cols: 2 } }, r);
        expect(r.status).toHaveBeenCalledWith(403);
    });
    test('bad input is refused', async () => {
        resolvePermissions.mockResolvedValue(['*']);
        for (const body of [{ layout: cells, rows: 0, cols: 2 }, { layout: [], rows: 1, cols: 1 },
            { layout: [{ seatId: '1A' }, { seatId: '1A' }], rows: 1, cols: 2 },
            { layout: cells, rows: 1, cols: 2, tierFares: { VIP: -1 } }, { layout: cells, rows: 1, cols: 2, tierFares: { GOLD: 3 } }]) {
            const r = res();
            await ctrl.saveSeatMap({ prisma: prismaWith(), params: { tripId: 't1' }, user: { id: 1 }, body }, r);
            expect(r.status).toHaveBeenCalledWith(400);
            expect(r.json.mock.calls[0][0].code).toBe('SEAT_MAP_INVALID');
        }
    });
    test('blocking or removing a booked seat is refused', async () => {
        resolvePermissions.mockResolvedValue(['*']);
        const prisma = prismaWith([{ seatId: '1B' }]); const r = res();
        await ctrl.saveSeatMap({ prisma, params: { tripId: 't1' }, user: { id: 1 }, body: { layout: cells, rows: 1, cols: 2 } }, r);
        expect(r.status).toHaveBeenCalledWith(409);
        expect(r.json.mock.calls[0][0].code).toBe('SEAT_MAP_BOOKED_SEATS');
        expect(r.json.mock.calls[0][0].seats).toEqual(['1B']);
        expect(prisma.transitSeatMap.upsert).not.toHaveBeenCalled();
    });
    test('the owner saves: one transaction, trip counters reset, tier fares merged', async () => {
        const prisma = prismaWith([{ seatId: '1A' }]); const r = res();
        await ctrl.saveSeatMap({ prisma, params: { tripId: 't1' }, user: { id: 1 }, body: { layout: cells, rows: 1, cols: 2, tierFares: { VIP: 8 } } }, r);
        expect(r.status).not.toHaveBeenCalled();
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.$executeRaw).toHaveBeenCalled(); // the trip rows are held
        const updates = prisma.transitTrip.update.mock.calls.map((c) => c[0]);
        // 1A bookable (1B blocked), 1 seat held: 0 left on each open trip.
        expect(updates.filter((u) => 'availableSeats' in u.data)).toEqual([
            { where: { id: 't1' }, data: { availableSeats: 0 } },
            { where: { id: 't2' }, data: { availableSeats: 0 } },
        ]);
        expect(updates.find((u) => u.data.metadata).data.metadata).toEqual({ x: 1, tierFares: { VIP: 8 } });
        expect(r.json.mock.calls[0][0].tierFares).toEqual({ VIP: 8 });
    });

    test('an employee on leave cannot save, whatever their stored permissions', async () => {
        resolvePermissions.mockResolvedValue(['*']);
        const prisma = prismaWith([], { employeeStatus: 'ON_LEAVE' }); const r = res();
        await ctrl.saveSeatMap({ prisma, params: { tripId: 't1' }, user: { id: 9 }, body: { layout: cells, rows: 1, cols: 2 } }, r);
        expect(r.status).toHaveBeenCalledWith(403);
        expect(prisma.transitSeatMap.upsert).not.toHaveBeenCalled();
    });
});

describe('seat map read', () => {
    test('passenger names only for the business', async () => {
        const booked = [{ seatId: '1A', passengerName: 'Ama' }];
        resolvePermissions.mockResolvedValue([]);
        let r = res();
        await ctrl.getSeatMap({ prisma: prismaWith(booked, { employeeStatus: null }), params: { tripId: 't1' }, user: { id: 9 } }, r);
        expect(r.json.mock.calls[0][0].bookedSeats).toEqual([{ seatId: '1A' }]);
        resolvePermissions.mockResolvedValue(['transit.manifests.view']);
        r = res();
        await ctrl.getSeatMap({ prisma: prismaWith(booked), params: { tripId: 't1' }, user: { id: 9 } }, r);
        expect(r.json.mock.calls[0][0].bookedSeats).toEqual(booked);
    });
});

test('a blocked seat is a seat but not bookable', () => {
    expect(layout.isSeatCell(cells[1])).toBe(true);
    expect([...layout.bookableSeatIds(cells)]).toEqual(['1A']);
});
