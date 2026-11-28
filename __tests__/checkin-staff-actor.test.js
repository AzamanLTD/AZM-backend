// =============================================================================
// Front-desk staff can check guests in (QR and AZM-ID search) for their own
// business: the owner, or an ACTIVE employee whose role grants
// reservations.manage, acts as that business; anyone else acts as themselves,
// so the check-in authority (which compares the reservation's business owner)
// refuses them.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/requirePermission', () => ({
    resolveBusinessContext: jest.fn(),
    resolvePermissions: jest.fn(),
    requirePermission: () => (req, res, next) => next(),
}));

const perm = require('../middleware/requirePermission');
const { _checkInActorOwnerId, _checkInActor } = require('../controllers/marketplaceController');

const db = { businessProfile: { findUnique: jest.fn(async () => ({ userId: 20 })) } };

describe('who checks guests in', () => {
    beforeEach(() => { perm.resolveBusinessContext.mockReset(); perm.resolvePermissions.mockReset(); });

    test('the owner acts as themselves', async () => {
        perm.resolveBusinessContext.mockResolvedValue({ businessProfileId: 'bp-h', isBusinessOwner: true, isEmployee: false });
        expect(await _checkInActorOwnerId(db, { id: 20 })).toBe(20);
    });

    test('front-desk staff with reservations.manage act as the business', async () => {
        perm.resolveBusinessContext.mockResolvedValue({ businessProfileId: 'bp-h', isBusinessOwner: false, isEmployee: true });
        perm.resolvePermissions.mockResolvedValue(['reservations.view', 'reservations.manage']);
        expect(await _checkInActorOwnerId(db, { id: 31 })).toBe(20);
        expect(perm.resolvePermissions).toHaveBeenCalledWith(db, 31, 'bp-h');
    });

    test('staff without it, and people with no business, act as themselves', async () => {
        perm.resolveBusinessContext.mockResolvedValue({ businessProfileId: 'bp-h', isBusinessOwner: false, isEmployee: true });
        perm.resolvePermissions.mockResolvedValue(['reservations.view']);
        expect(await _checkInActorOwnerId(db, { id: 32 })).toBe(32);
        perm.resolveBusinessContext.mockResolvedValue(null);
        expect(await _checkInActorOwnerId(db, { id: 33 })).toBe(33);
    });

    // An AZM-ID search adds the passenger's transit bookings, ID name and ID
    // status only for the owner or staff with a transit manifest permission.
    test('front-desk staff see reservations, not the passenger transit details', async () => {
        perm.resolveBusinessContext.mockResolvedValue({ businessProfileId: 'bp-h', isBusinessOwner: false, isEmployee: true });
        perm.resolvePermissions.mockResolvedValue(['reservations.manage']);
        expect(await _checkInActor(db, { id: 31 })).toEqual({ ownerId: 20, transit: false });
        perm.resolvePermissions.mockResolvedValue(['reservations.manage', 'transit.manifests.view']);
        expect(await _checkInActor(db, { id: 31 })).toEqual({ ownerId: 20, transit: true });
        perm.resolveBusinessContext.mockResolvedValue({ businessProfileId: 'bp-h', isBusinessOwner: true, isEmployee: false });
        expect(await _checkInActor(db, { id: 20 })).toEqual({ ownerId: 20, transit: true });
    });
});
