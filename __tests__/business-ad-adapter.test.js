// __tests__/business-ad-adapter.test.js
// =============================================================================
// Regression test for businessAdService.js -- the adapter every real REST
// call goes through (adPostController -> adPostRoutes -> /api/ad-posts/*).
// Every method here previously called a nonexistent method name on
// AdPostService, or called a real method with the wrong argument shape.
// See businessAdService.js header comment for the full breakdown.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const {
    createAdPost,
    removeAdPost,
    getActiveAds,
    getFeedAds,
    expireOldAds,
} = require('../services/businessAdService');
const { followBusiness } = require('../services/businessFollowerService');

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
    await prisma.businessAdPost.deleteMany();
    await prisma.story.deleteMany();
    await prisma.businessFollower.deleteMany();
    await prisma.businessProfile.deleteMany({ where: { businessName: { startsWith: 'Test Business ' } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: 'user_' } } });
}

let owner, follower, nonFollower, biz, ownerBiz;

beforeAll(async () => {
    owner = await seedUser();
    follower = await seedUser();
    nonFollower = await seedUser();
    biz = await seedBusiness(owner.id);
    await followBusiness(prisma, { customerId: follower.id, businessProfileId: biz.id });
});

afterAll(async () => {
    await cleanupAll();
    await prisma.$disconnect();
});

describe('businessAdService adapter (real API call path)', () => {
    let adPost;

    test('createAdPost works through the adapter (previously crashed: "AdPostService is not a constructor")', async () => {
        adPost = await createAdPost(prisma, {
            businessProfileId: biz.id,
            userId: owner.id,
            templateType: 'PROMO',
            title: 'Weekend Special',
            bodyText: '20% off everything this weekend.',
        });
        expect(adPost.id).toBeDefined();
        expect(adPost.title).toBe('Weekend Special');
    });

    test('getActiveAds returns the created ad for the business', async () => {
        const ads = await getActiveAds(prisma, { businessProfileId: biz.id });
        expect(ads.some(a => a.id === adPost.id)).toBe(true);
    });

    test('getFeedAds returns the ad for a follower (previously always broken: svc.getFeed is not a function)', async () => {
        const result = await getFeedAds(prisma, { customerId: follower.id, limit: 10, offset: 0 });
        expect(result.ads.some(a => a.id === adPost.id)).toBe(true);
    });

    test('getFeedAds returns empty for a non-follower', async () => {
        const result = await getFeedAds(prisma, { customerId: nonFollower.id, limit: 10, offset: 0 });
        expect(result.ads.some(a => a.id === adPost.id)).toBe(false);
    });

    test('removeAdPost resolves the caller\'s own business profile and deletes (previously always broken: svc.deleteAd is not a function)', async () => {
        const result = await removeAdPost(prisma, { adPostId: adPost.id, userId: owner.id });
        expect(result.success).toBe(true);
        const ads = await getActiveAds(prisma, { businessProfileId: biz.id });
        expect(ads.some(a => a.id === adPost.id)).toBe(false);
    });

    test('expireOldAds sweeps expired posts (method previously did not exist at all)', async () => {
        const expiredAd = await prisma.businessAdPost.create({
            data: {
                businessProfileId: biz.id,
                templateType: 'PROMO',
                title: 'Old Promo',
                bodyText: 'expired',
                expiresAt: new Date(Date.now() - 60 * 60 * 1000),
            },
        });
        const result = await expireOldAds(prisma);
        expect(result.expired).toBeGreaterThanOrEqual(1);
        const stillThere = await prisma.businessAdPost.findUnique({ where: { id: expiredAd.id } });
        expect(stillThere).toBeNull();
    });
});
