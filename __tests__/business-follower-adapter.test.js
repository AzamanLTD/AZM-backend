// __tests__/business-follower-adapter.test.js
// =============================================================================
// Regression test for the businessFollowerService.js adapter -- this is the
// layer the REAL REST API (followController -> followRoutes -> /api/follows/*)
// actually calls. The existing marketplace-v2.test.js suite instantiates
// FollowService directly and calls it with correct positional args, which
// completely bypasses this adapter and is why a full end-to-end break here
// went uncaught:
//   1. businessFollowerService.js did `const { FollowService } =
//      require('./marketplace/followService')` -- a destructure of a named
//      export that doesn't exist (followService.js does
//      `module.exports = FollowService`, a bare class). FollowService was
//      `undefined`, so `new FollowService(prisma)` threw
//      "FollowService is not a constructor" on every single call.
//   2. Even with the import fixed, every wrapper method called the real
//      service with a single `{ userId, businessProfileId }` object where
//      FollowService expects two positional args -- so `businessProfileId`
//      was always `undefined`.
//   3. getFollowing/getFollowers ignored the limit/offset they were handed.
// This test exercises the actual exported adapter functions end to end.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const {
    followBusiness,
    unfollowBusiness,
    isFollowing,
    getFollowers,
    getFollowing,
    getFollowedBusinessIds,
} = require('../services/businessFollowerService');

const TEST_PASSWORD = 'TestPass1!secure';
let _seq = 0;
const _uniq = () => `${Date.now()}_${++_seq}`;

async function seedUser() {
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    const id = _uniq();
    return prisma.user.create({
        data: {
            username: `user_${id}`,
            email: `user_${id}@test.com`,
            password: hash,
            availableBalance: 0.0,
            escrowLockedBalance: 0.0,
            disputeEscrowBalance: 0.0,
            azamanId: `AZM-TEST-${id}`,
        },
    });
}

async function seedBusiness(userId) {
    const id = _uniq();
    return prisma.businessProfile.create({
        data: {
            userId,
            bizId: `BIZ-${id}`,
            businessName: `Test Business ${id}`,
            category: 'FOOD_BEVERAGE',
            isVerified: true,
            kybStatus: 'VERIFIED',
        },
    });
}

async function cleanupAll() {
    await prisma.businessFollower.deleteMany();
    await prisma.businessProfile.deleteMany({ where: { businessName: { startsWith: 'Test Business ' } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: 'user_' } } });
}

let owner, follower1, follower2, biz;

beforeAll(async () => {
    owner = await seedUser();
    follower1 = await seedUser();
    follower2 = await seedUser();
    biz = await seedBusiness(owner.id);
});

afterAll(async () => {
    await cleanupAll();
    await prisma.$disconnect();
});

describe('businessFollowerService adapter (real API call path)', () => {
    test('followBusiness works through the adapter (previously crashed: "FollowService is not a constructor")', async () => {
        const result = await followBusiness(prisma, { customerId: follower1.id, businessProfileId: biz.id });
        expect(result.success).toBe(true);
    });

    test('isFollowing reflects the follow, through the adapter', async () => {
        const following = await isFollowing(prisma, { customerId: follower1.id, businessProfileId: biz.id });
        expect(following).toBe(true);
    });

    test('getFollowing returns the followed business with correct arg wiring (previously always empty/broken)', async () => {
        const following = await getFollowing(prisma, { customerId: follower1.id, limit: 10, offset: 0 });
        expect(following).toHaveLength(1);
        expect(following[0].id).toBe(biz.id);
    });

    test('getFollowing/getFollowers respect limit/offset pagination', async () => {
        await followBusiness(prisma, { customerId: follower2.id, businessProfileId: biz.id });
        const page1 = await getFollowers(prisma, { businessProfileId: biz.id, limit: 1, offset: 0 });
        const page2 = await getFollowers(prisma, { businessProfileId: biz.id, limit: 1, offset: 1 });
        expect(page1).toHaveLength(1);
        expect(page2).toHaveLength(1);
        expect(page1[0].id).not.toBe(page2[0].id);
    });

    test('getFollowedBusinessIds returns the ids for a follower', async () => {
        const ids = await getFollowedBusinessIds(prisma, { userId: follower1.id });
        expect(ids).toContain(biz.id);
    });

    test('unfollowBusiness works through the adapter', async () => {
        await unfollowBusiness(prisma, { customerId: follower1.id, businessProfileId: biz.id });
        const following = await isFollowing(prisma, { customerId: follower1.id, businessProfileId: biz.id });
        expect(following).toBe(false);
    });
});
