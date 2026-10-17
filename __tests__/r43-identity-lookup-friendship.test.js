// =============================================================================
// r43 — Identity lookup friendship state (Workstream C/D, 2026-10-17).
//
// The redesigned Send Money screen posted to POST /api/finance/internal-transfer
// (a route that never existed) and looked users up via
// GET /api/users/lookup?identifier= (equally nonexistent). The canonical
// user-to-user transfer rail is friendship-scoped:
// POST /api/friends/transfer/send { friendshipId, amount }.
//
// For an AZM-ID hit to reach that rail the lookup must answer one extra
// question truthfully: "what is the CALLER's relationship to this user?"
// This suite pins that contract on the service, DB-free (fake prisma):
//
//   • Target projection is UNCHANGED: { azamanId, displayName, avatar } —
//     no User.id, email, phone, balances or KYC fields leak (Requirement 18).
//   • friendship is the CALLER's own row only: { friendshipId, status } or
//     null for strangers; never any target-scoped field.
//   • Accepted / pending / absent rows project honestly; malformed IDs,
//     unknown users, deleted users and self-lookup still fail closed.
// =============================================================================

const { IdentityService, IdentityError, AZAMAN_ID_RE } = require('../services/identity/identity.service');

// ── Fake prisma — exactly the model surface lookupByAzamanId touches ────────
function fakePrisma({ user, friendship }) {
  return {
    user: {
      findUnique: async ({ where }) => (user && where.azamanId === user.azamanId ? user : null),
    },
    friendship: {
      findFirst: async ({ where }) => {
        if (!friendship) return null;
        const { requesterId, addresseeId } = where.OR[0];
        const other = requesterId; // caller side of the pair
        const target = addresseeId;
        const flip = where.OR[1];
        const matches =
          (friendship.requesterId === requesterId && friendship.addresseeId === addresseeId) ||
          (friendship.requesterId === flip.requesterId && friendship.addresseeId === flip.addresseeId);
        if (!matches) return null;
        return { id: friendship.id, status: friendship.status };
      },
    },
  };
}

const TARGET = {
  id: 77,
  azamanId: 'AZM-123456789',
  username: 'adjoa',
  displayName: 'Auntie Adjoa',
  profilePictureUrl: 'https://cdn.example/a.png',
  isDeleted: false,
};

describe('r43 identity lookup friendship state', () => {
  describe('A. target projection is unchanged (Requirement 18)', () => {
    it('exposes exactly { azamanId, displayName, avatar, friendship } — never User.id', async () => {
      const svc = new IdentityService(
        fakePrisma({ user: TARGET, friendship: null }));
      const profile = await svc.lookupByAzamanId(1, 'AZM-123456789');
      expect(Object.keys(profile).sort()).toEqual(
        ['avatar', 'azamanId', 'displayName', 'friendship'].sort());
      expect(profile.azamanId).toBe('AZM-123456789');
      expect(profile.displayName).toBe('Auntie Adjoa');
      expect(profile.avatar).toBe('https://cdn.example/a.png');
      expect(profile.friendship).toBeNull();
      expect(profile.id).toBeUndefined();
      expect(profile.email).toBeUndefined();
      expect(profile.kycStatus).toBeUndefined();
    });

    it('displayName falls back to username when displayName is null', async () => {
      const svc = new IdentityService(
        fakePrisma({ user: { ...TARGET, displayName: null }, friendship: null }));
      const profile = await svc.lookupByAzamanId(1, 'AZM-123456789');
      expect(profile.displayName).toBe('adjoa');
    });

    it('avatar is null when no profile picture exists', async () => {
      const svc = new IdentityService(
        fakePrisma({ user: { ...TARGET, profilePictureUrl: null }, friendship: null }));
      const profile = await svc.lookupByAzamanId(1, 'AZM-123456789');
      expect(profile.avatar).toBeNull();
    });
  });

  describe('B. the caller\'s friendship row projects honestly', () => {
    it('an ACCEPTED friendship yields { friendshipId, status: "ACCEPTED" }', async () => {
      const friendship = {
        id: 'fs-1', status: 'ACCEPTED', requesterId: 1, addresseeId: 77,
      };
      const svc = new IdentityService(fakePrisma({ user: TARGET, friendship }));
      const profile = await svc.lookupByAzamanId(1, 'AZM-123456789');
      expect(profile.friendship).toEqual({ friendshipId: 'fs-1', status: 'ACCEPTED' });
    });

    it('works when the CALLER is the addressee (friendship was incoming)', async () => {
      const friendship = {
        id: 'fs-2', status: 'ACCEPTED', requesterId: 77, addresseeId: 1,
      };
      const svc = new IdentityService(fakePrisma({ user: TARGET, friendship }));
      const profile = await svc.lookupByAzamanId(1, 'AZM-123456789');
      expect(profile.friendship).toEqual({ friendshipId: 'fs-2', status: 'ACCEPTED' });
    });

    it('a PENDING friendship is reported as PENDING — never promoted', async () => {
      const friendship = {
        id: 'fs-3', status: 'PENDING', requesterId: 77, addresseeId: 1,
      };
      const svc = new IdentityService(fakePrisma({ user: TARGET, friendship }));
      const profile = await svc.lookupByAzamanId(1, 'AZM-123456789');
      expect(profile.friendship).toEqual({ friendshipId: 'fs-3', status: 'PENDING' });
    });

    it('strangers (no row) get friendship: null — the client must fail closed', async () => {
      const svc = new IdentityService(fakePrisma({ user: TARGET, friendship: null }));
      const profile = await svc.lookupByAzamanId(1, 'AZM-123456789');
      expect(profile.friendship).toBeNull();
    });

    it('a friendship row for a DIFFERENT pair never leaks into the profile', async () => {
      const friendship = {
        id: 'fs-4', status: 'ACCEPTED', requesterId: 2, addresseeId: 77,
      };
      const svc = new IdentityService(fakePrisma({ user: TARGET, friendship }));
      const profile = await svc.lookupByAzamanId(1, 'AZM-123456789');
      expect(profile.friendship).toBeNull();
    });
  });

  describe('C. lookup still fails closed exactly as before', () => {
    it('a malformed Azaman ID is rejected before any DB access', async () => {
      const svc = new IdentityService(fakePrisma({ user: TARGET, friendship: null }));
      await expect(svc.lookupByAzamanId(1, 'AZM-12345'))
        .rejects.toMatchObject({ code: 'AZAMAN_ID_INVALID' });
      await expect(svc.lookupByAzamanId(1, 'adjoa'))
        .rejects.toMatchObject({ code: 'AZAMAN_ID_INVALID' });
      await expect(svc.lookupByAzamanId(1, ''))
        .rejects.toMatchObject({ code: 'AZAMAN_ID_INVALID' });
    });

    it('an unknown AZM ID is USER_NOT_FOUND (404), friendship never queried', async () => {
      const svc = new IdentityService(fakePrisma({ user: null, friendship: null }));
      await expect(svc.lookupByAzamanId(1, 'AZM-999999999'))
        .rejects.toMatchObject({ code: 'USER_NOT_FOUND', httpStatus: 404 });
    });

    it('a deleted user is USER_NOT_FOUND', async () => {
      const svc = new IdentityService(
        fakePrisma({ user: { ...TARGET, isDeleted: true }, friendship: null }));
      await expect(svc.lookupByAzamanId(1, 'AZM-123456789'))
        .rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });

    it('self-lookup is rejected AZAMAN_ID_SELF even with a friendship row present', async () => {
      const friendship = {
        id: 'fs-5', status: 'ACCEPTED', requesterId: 1, addresseeId: 77,
      };
      const svc = new IdentityService(fakePrisma({ user: TARGET, friendship }));
      await expect(svc.lookupByAzamanId(77, 'AZM-123456789'))
        .rejects.toMatchObject({ code: 'AZAMAN_ID_SELF' });
    });
  });

  describe('D. AZAMAN_ID_RE stays the strict wire contract', () => {
    it('matches only AZM- followed by exactly 9 digits', () => {
      expect(AZAMAN_ID_RE.test('AZM-123456789')).toBe(true);
      expect(AZAMAN_ID_RE.test('AZM-12345678')).toBe(false);
      expect(AZAMAN_ID_RE.test('AZM-1234567890')).toBe(false);
      expect(AZAMAN_ID_RE.test('azm-123456789')).toBe(false);
      expect(AZAMAN_ID_RE.test('AZM-12345678a')).toBe(false);
    });
  });

  describe('E. error shape', () => {
    it('IdentityError carries code + httpStatus for the route wrapper', () => {
      const e = new IdentityError('X', 'msg', 418);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('IdentityError');
      expect(e.code).toBe('X');
      expect(e.httpStatus).toBe(418);
    });

    it('constructor enforces prisma (no silent undefined client)', () => {
      expect(() => new IdentityService()).toThrow(/prisma required/);
    });
  });
});
