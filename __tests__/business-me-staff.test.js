// =============================================================================
// GET /api/business/me — the business the caller works for. Staff (ACTIVE
// employment) used to get 404, so the business portal sent every employee to
// sign-up and no permission-gated page was reachable. Now:
//   • the owner gets their business and access { isOwner: true, ['*'] };
//   • staff get their employer's business, their own permissions, and none
//     of the owner's personal account details (only the username);
//   • anyone else: 404.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../services/businessActor', () => ({ resolveBusinessActor: jest.fn() }));

const { resolveBusinessActor } = require('../services/businessActor');
const ctrl = require('../controllers/businessController');

const PROFILE = {
    id: 'bp-1', bizId: 'BIZ-1', businessName: 'Chef Abby', userId: 20,
    user: { id: 20, username: 'abby', profilePictureUrl: 'x', azamanId: 'AZM-000000020', kycStatus: 'VERIFIED' },
};
const prisma = { businessProfile: { findFirst: jest.fn(async ({ where }) => (where.id === 'bp-1' ? JSON.parse(JSON.stringify(PROFILE)) : null)) } };
const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const call = async (userId) => {
    const r = res();
    await ctrl.getMyBusiness({ app: { get: () => prisma }, user: { id: userId } }, r);
    return { status: r.status.mock.calls[0][0], body: r.json.mock.calls[0][0] };
};

beforeEach(() => jest.clearAllMocks());

test('the owner gets their business, with every right', async () => {
    resolveBusinessActor.mockResolvedValue({ businessProfileId: 'bp-1', ownerUserId: 20, actorUserId: 20, isOwner: true, permissions: ['*'] });
    const out = await call(20);
    expect(out.status).toBe(200);
    expect(out.body.business.user.azamanId).toBe('AZM-000000020');
    expect(out.body.access).toEqual({ isOwner: true, permissions: ['*'] });
});

test("staff get their employer's business and their own rights, not the owner's account details", async () => {
    resolveBusinessActor.mockResolvedValue({ businessProfileId: 'bp-1', ownerUserId: 20, actorUserId: 31, isOwner: false, permissions: ['reservations.view', 'reservations.manage'] });
    const out = await call(31);
    expect(out.status).toBe(200);
    expect(out.body.business.id).toBe('bp-1');
    expect(out.body.business.user).toEqual({ username: 'abby' });
    expect(out.body.access).toEqual({ isOwner: false, permissions: ['reservations.view', 'reservations.manage'] });
});

test('anyone else: 404', async () => {
    resolveBusinessActor.mockResolvedValue(null);
    expect((await call(99)).status).toBe(404);
});
