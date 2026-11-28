// =============================================================================
// Front-desk work is done by staff, not only the owner. The reservation
// endpoints resolve who acts for which business (services/businessActor):
//   • staff with reservations.manage or hotel.front_desk.manage confirm,
//     decline, check in, check out and mark no-shows for their business;
//   • reservations.view is enough to see the list;
//   • the lifecycle is called with the business's owner id (what it
//     compares) and the business's own id, never the caller's;
//   • anyone else gets 403 and nothing runs.
// Drivers with transit.manifests.manage board for their operator the same way.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../services/businessActor', () => ({ resolveBusinessActor: jest.fn() }));
jest.mock('../services/reservationLifecycleService', () => ({
    confirmReservation: jest.fn(async () => ({ id: 'r1', reservationRef: 'RES-1', customerId: 10, confirmedAt: new Date() })),
    checkOutReservation: jest.fn(async () => ({ id: 'r1', status: 'CHECKED_OUT' })),
    markNoShowReservation: jest.fn(async () => ({ id: 'r1', status: 'NO_SHOW' })),
    checkInReservation: jest.fn(async () => ({ id: 'r1', status: 'CHECKED_IN' })),
}));
jest.mock('../services/webhookEmitter', () => ({ emitWebhookEvent: jest.fn() }));
jest.mock('../services/stayPaymentService', () => ({ isPaidReservation: jest.fn(async () => false), qrCheckInRequiredError: jest.fn() }));

const { resolveBusinessActor } = require('../services/businessActor');
const lifecycle = require('../services/reservationLifecycleService');
const ctrl = require('../controllers/reservationController');

const staff = { businessProfileId: 'bp-h', ownerUserId: 20, actorUserId: 31, isOwner: false, permissions: ['hotel.front_desk.manage'] };
const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const reqFor = (extra = {}) => {
    const prisma = { reservation: { findMany: jest.fn(async () => []) } };
    return {
        app: { get: (k) => (k === 'prisma' ? prisma : null) },
        user: { id: 31 }, params: { reservationId: 'r1' }, body: {}, query: {}, ...extra,
    };
};

beforeEach(() => jest.clearAllMocks());

describe('front desk staff', () => {
    test.each([
        ['confirm', 'confirmReservation', (c) => expect(c).toEqual(expect.objectContaining({ businessProfileId: 'bp-h' }))],
        ['check out', 'checkOutReservation', (c) => expect(c).toEqual(expect.objectContaining({ businessUserId: 20 }))],
        ['mark a no-show', 'markNoShowReservation', (c) => expect(c).toEqual(expect.objectContaining({ businessUserId: 20 }))],
        ['check in by hand', 'checkInReservation', (c) => expect(c).toEqual(expect.objectContaining({ businessUserId: 20 }))],
    ])('can %s for their business', async (_label, fn, check) => {
        resolveBusinessActor.mockResolvedValue(staff);
        const r = res();
        await ctrl[fn](reqFor(), r);
        expect(r.status).toHaveBeenCalledWith(200);
        check(lifecycle[fn].mock.calls[0][1]);
        expect(resolveBusinessActor.mock.calls[0][2].anyOf).toEqual(['reservations.manage', 'hotel.front_desk.manage']);
    });

    test('someone without a right gets 403 and nothing runs', async () => {
        resolveBusinessActor.mockResolvedValue(null);
        for (const fn of ['confirmReservation', 'checkOutReservation', 'markNoShowReservation', 'checkInReservation', 'listBusinessReservations']) {
            const r = res();
            await ctrl[fn](reqFor(), r);
            expect(r.status).toHaveBeenCalledWith(403);
        }
        expect(lifecycle.confirmReservation).not.toHaveBeenCalled();
        expect(lifecycle.checkInReservation).not.toHaveBeenCalled();
    });

    test('the list needs any reservations or front-desk right, and shows the business\'s own', async () => {
        resolveBusinessActor.mockResolvedValue({ ...staff, permissions: ['reservations.view'] });
        const req = reqFor();
        const r = res();
        await ctrl.listBusinessReservations(req, r);
        expect(r.status).toHaveBeenCalledWith(200);
        expect(resolveBusinessActor.mock.calls[0][2].anyOf).toEqual(['reservations.view', 'reservations.manage', 'hotel.front_desk.manage']);
        const prisma = req.app.get('prisma');
        expect(prisma.reservation.findMany.mock.calls[0][0].where).toEqual({ businessProfileId: 'bp-h' });
    });
});
