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
const prismaWith = (booked = []) => ({
    transitTrip: { findUnique: jest.fn(async () => trip), update: jest.fn(async ({ data }) => ({ ...trip, ...data })) },
    transitBookingSeat: { findMany: jest.fn(async () => booked) },
    transitSeatMap: { upsert: jest.fn(async ({ create }) => create) },
});
const cells = [{ seatId: '1A' }, { seatId: '1B', status: 'BLOCKED' }];

describe('seat map save', () => {
    test('a stranger cannot save', async () => {
        resolvePermissions.mockResolvedValue([]);
        const prisma = prismaWith(); const r = res();
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
        }
    });
    test('blocking or removing a booked seat is refused', async () => {
        resolvePermissions.mockResolvedValue(['*']);
        const prisma = prismaWith([{ seatId: '1B' }]); const r = res();
        await ctrl.saveSeatMap({ prisma, params: { tripId: 't1' }, user: { id: 1 }, body: { layout: cells, rows: 1, cols: 2 } }, r);
        expect(r.status).toHaveBeenCalledWith(409);
        expect(r.json.mock.calls[0][0].seats).toEqual(['1B']);
        expect(prisma.transitSeatMap.upsert).not.toHaveBeenCalled();
    });
    test('the owner saves; tier fares merge into metadata', async () => {
        resolvePermissions.mockResolvedValue(['*']);
        const prisma = prismaWith([{ seatId: '1A' }]); const r = res();
        await ctrl.saveSeatMap({ prisma, params: { tripId: 't1' }, user: { id: 1 }, body: { layout: cells, rows: 1, cols: 2, tierFares: { VIP: 8 } } }, r);
        expect(r.status).not.toHaveBeenCalled();
        expect(prisma.transitTrip.update.mock.calls[0][0].data.metadata).toEqual({ x: 1, tierFares: { VIP: 8 } });
    });
});

describe('seat map read', () => {
    test('passenger names only for the business', async () => {
        const booked = [{ seatId: '1A', passengerName: 'Ama' }];
        resolvePermissions.mockResolvedValue([]);
        let r = res();
        await ctrl.getSeatMap({ prisma: prismaWith(booked), params: { tripId: 't1' }, user: { id: 9 } }, r);
        expect(r.json.mock.calls[0][0].bookedSeats).toEqual([{ seatId: '1A' }]);
        resolvePermissions.mockResolvedValue(['transit.manifests.view']);
        r = res();
        await ctrl.getSeatMap({ prisma: prismaWith(booked), params: { tripId: 't1' }, user: { id: 2 } }, r);
        expect(r.json.mock.calls[0][0].bookedSeats).toEqual(booked);
    });
});

test('a blocked seat is a seat but not bookable', () => {
    expect(layout.isSeatCell(cells[1])).toBe(true);
    expect([...layout.bookableSeatIds(cells)]).toEqual(['1A']);
});
