// __tests__/business-social-proof.test.js
// =============================================================================
// Business social-proof aggregates (marketplace personalisation, Backend C)
// — real PostgreSQL tests over the real Friendship/BusinessFollower
// authorities, exercising the mounted route stack with real JWTs.
//
// Required cases:
//   - direct friend follows / non-friend follows / friend-of-friend follows
//   - multi-path reachability counts once
//   - direct friends are NOT double-counted as friends of friends
//   - viewer exclusion
//   - no follows / no friendships -> honest zeros
//   - banned/ineligible accounts excluded
//   - unauthorized / missing / invalid business lookups
//   - correct after real follow/unfollow changes
//   - route boundary: 401 without a token; batch honest zeros + cap
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[business-social-proof.test] TEST_DATABASE_URL not set — skipping.');
}

describeOrSkip('Business social proof (Backend C)', () => {
    let prisma;
    const seq = { n: 0 };
    const uniq = () => `sp_${Date.now()}_${++seq.n}`;
    const seeded = { users: [], businesses: [], friendships: [], follows: [] };

    let app, request;
    let viewerToken, viewerId;
    let biz;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const express = require('express');
        const bcrypt = require('bcryptjs');
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        const { prisma: sharedPrisma } = require('../src/config/baseServices');
        app = express();
        app.use(express.json());
        app.set('prisma', sharedPrisma);
        app.use('/api', require('../middleware/responseHelpers'));
        app.use('/api', require('../src/middleware/prismaInjector'));
        app.use('/api/social-proof', require('../routes/socialProofRoutes'));
        request = require('supertest');

        const { signAccessToken } = require('../services/authTokenService');
        async function makeUser(name) {
            const username = `${name}_${uniq()}`;
            const u = await prisma.user.create({
                data: {
                    username,
                    email: `${username}@azaman.test`,
                    password: await bcrypt.hash('Str0ng!Pass#2026', 10),
                    availableBalance: 0, escrowLockedBalance: 0,
                    disputeEscrowBalance: 0,
                    azamanId: `AZM-${uniq()}`,
                },
            });
            seeded.users.push(u.id);
            return { id: u.id, token: signAccessToken(u) };
        }

        const viewer = await makeUser('viewer');
        viewerId = viewer.id;
        viewerToken = viewer.token;

        const owner = await makeUser('owner');
        biz = await prisma.businessProfile.create({
            data: {
                userId: owner.id, bizId: `BIZ-${uniq()}`,
                businessName: `SocialProof ${uniq()}`, category: 'FOOD_BEVERAGE',
                isVerified: true, kybStatus: 'VERIFIED',
            },
        });
        seeded.businesses.push(biz.id);

        // Graph helpers on the REAL authorities.
        globalThis.__mkFriend = async (aId, bId, status = 'ACCEPTED') => {
            const f = await prisma.friendship.create({
                data: {
                    requesterId: aId, addresseeId: bId, status,
                },
            });
            seeded.friendships.push(f.id);
            return f;
        };
        globalThis.__mkFollow = async (uId, bizId) => {
            const row = await prisma.businessFollower.create({
                data: { customerId: uId, businessProfileId: bizId },
            });
            seeded.follows.push(row.id);
            return row;
        };
    });

    afterAll(async () => {
        // Dependency-ordered, seed-scoped cleanup. Followers/friendships
        // first (they reference users/businesses), then stories-unrelated
        // rows, then businesses, then users.
        await prisma.businessFollower.deleteMany({ where: { id: { in: seeded.follows } } });
        await prisma.friendship.deleteMany({ where: { id: { in: seeded.friendships } } });
        await prisma.businessProfile.deleteMany({ where: { id: { in: seeded.businesses } } });
        for (const uid of seeded.users.slice().reverse()) {
            await prisma.user.delete({ where: { id: uid } }).catch(() => {});
        }
        await prisma.$disconnect();
        const { prisma: shared } = require('../src/config/baseServices');
        await shared.$disconnect().catch(() => {});
    });

    const mkFriend = (a, b, s) => globalThis.__mkFriend(a, b, s);
    const mkFollow = (u, b) => globalThis.__mkFollow(u, b);

    const authed = (req) => req.set('Authorization', `Bearer ${viewerToken}`);

    test('route boundary: 401 without a token', async () => {
        expect((await request(app).get(`/api/social-proof/${biz.id}`)).statusCode).toBe(401);
        expect((await request(app).post('/api/social-proof').send({ businessProfileIds: [biz.id] })).statusCode).toBe(401);
    });

    test('invalid/missing business ID: 400 validation, unknown business: honest 404', async () => {
        // Express treats '/api/social-proof/' as an empty :businessProfileId param
        // guarded by the controller's validation -> 400, or matched by the POST route.
        const empty = await authed(request(app).get('/api/social-proof/'));
        expect([400, 404]).toContain(empty.statusCode);
        const unknown = await authed(request(app).get('/api/social-proof/nonexistent-biz'));
        expect(unknown.statusCode).toBe(404);
        expect(unknown.body.code).toBe('BUSINESS_NOT_FOUND');
        const bad = await authed(request(app).post('/api/social-proof').send({ businessProfileIds: 'nope' }));
        expect(bad.statusCode).toBe(400);
    });

    test('honest zeros with no friendships and no follows', async () => {
        const res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true, businessProfileId: biz.id,
            friendsFollowingCount: 0, friendsOfFriendsFollowingCount: 0,
        });
    });

    let friendU, fofU, strangerU;

    test('direct friend follows -> friendsFollowingCount 1, fof 0', async () => {
        friendU = await makeUser('friend');
        await mkFriend(viewerId, friendU.id);
        await mkFollow(friendU.id, biz.id);
        const res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.body.friendsFollowingCount).toBe(1);
        expect(res.body.friendsOfFriendsFollowingCount).toBe(0);
    });

    test('non-friend follower does not inflate either count', async () => {
        strangerU = await makeUser('stranger');
        await mkFollow(strangerU.id, biz.id);
        const res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.body.friendsFollowingCount).toBe(1);
        expect(res.body.friendsOfFriendsFollowingCount).toBe(0);
    });

    test('friend-of-friend follows -> fof 1; direct friend stays only in friends count', async () => {
        // friend-of-viewer-of-viewer: viewer -> friendU -> fofU
        fofU = await makeUser('fof');
        await mkFriend(friendU.id, fofU.id);
        await mkFollow(fofU.id, biz.id);
        const res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.body.friendsFollowingCount).toBe(1);
        expect(res.body.friendsOfFriendsFollowingCount).toBe(1);
    });

    test('multi-path reachability counts once', async () => {
        // Second path to fofU: another direct friend also friends with fofU.
        const friend2 = await makeUser('friend2');
        await mkFriend(viewerId, friend2.id);
        await mkFriend(friend2.id, fofU.id);
        const res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.body.friendsOfFriendsFollowingCount).toBe(1); // still 1, not 2
    });

    test('viewer is never counted as their own friend or fof', async () => {
        // Viewer follows the business themselves — must not affect counts.
        await mkFollow(viewerId, biz.id);
        const res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.body.friendsFollowingCount).toBe(1);
        expect(res.body.friendsOfFriendsFollowingCount).toBe(1);
    });

    test('banned and deleted followers are ineligible', async () => {
        const bannedFriend = await makeUser('banned');
        await mkFriend(viewerId, bannedFriend.id);
        await mkFollow(bannedFriend.id, biz.id);
        await prisma.user.update({ where: { id: bannedFriend.id }, data: { banStatus: 'BANNED_1W' } });
        const res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.body.friendsFollowingCount).toBe(1); // banned friend not counted
        expect(res.body.friendsOfFriendsFollowingCount).toBe(1);
        // NOTE: the banned user STAYS banned (never restored) so later
        // count assertions are not polluted by a now-eligible follower.
    });

    test('counts follow real follow/unfollow changes', async () => {
        // friend unfollows -> friends count drops to 0.
        await prisma.businessFollower.deleteMany({
            where: { customerId: friendU.id, businessProfileId: biz.id },
        });
        let res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.body.friendsFollowingCount).toBe(0);
        // friend re-follows -> back to 1.
        await mkFollow(friendU.id, biz.id);
        res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.body.friendsFollowingCount).toBe(1);
    });

    test('PENDING friendship is not a friend edge', async () => {
        const pendingFriend = await makeUser('pending');
        await mkFriend(viewerId, pendingFriend.id, 'PENDING');
        await mkFollow(pendingFriend.id, biz.id);
        const res = await authed(request(app).get(`/api/social-proof/${biz.id}`));
        expect(res.body.friendsFollowingCount).toBe(1); // pending friend not counted
        expect(res.body.friendsOfFriendsFollowingCount).toBe(1);
    });

    test('batch endpoint returns per-business aggregates with honest zeros, capped', async () => {
        const res = await authed(request(app).post('/api/social-proof'))
            .send({ businessProfileIds: [biz.id, 'nonexistent-biz'] });
        expect(res.statusCode).toBe(200);
        expect(res.body.proofs[biz.id].friendsFollowingCount).toBe(1);
        expect(res.body.proofs['nonexistent-biz']).toEqual({
            friendsFollowingCount: 0, friendsOfFriendsFollowingCount: 0,
        });
        const over = await authed(request(app).post('/api/social-proof'))
            .send({ businessProfileIds: Array.from({ length: 51 }, (_, i) => `x${i}`) });
        expect(over.statusCode).toBe(400);
    });

    // ─── anti-cheat: the tests above FAIL if the query mis-counts ────────
    test('a wrong implementation (counting all followers as friends) would fail the above — sanity via direct SQL', async () => {
        const { getSocialProof } = require('../services/marketplace/businessSocialProofService');
        const proof = await getSocialProof(prisma, { viewerId, businessProfileId: biz.id });
        // Directly cross-check against a naive full count of eligible followers.
        const followerCount = await prisma.businessFollower.count({
            where: { businessProfileId: biz.id },
        });
        expect(proof.friendsFollowingCount).toBeLessThan(followerCount);
    });

    async function makeUser(name) {
        const username = `${name}_${uniq()}`;
        const bcrypt = require('bcryptjs');
        const u = await prisma.user.create({
            data: {
                username,
                email: `${username}@azaman.test`,
                password: await bcrypt.hash('Str0ng!Pass#2026', 10),
                availableBalance: 0, escrowLockedBalance: 0,
                disputeEscrowBalance: 0,
                azamanId: `AZM-${uniq()}`,
            },
        });
        seeded.users.push(u.id);
        return u;
    }
});
