// __tests__/business-bookmarks.test.js
// =============================================================================
// Business bookmark API (marketplace personalisation, Backend A) — real
// PostgreSQL integration tests through the EXACT route boundary the app
// uses: the real bookmarkRoutes (protect middleware included) + the real
// prismaInjector mounted on a minimal Express app, with real users and real
// bcrypt passwords in the database and real JWTs signed with the repo's
// test secret. (The full server.js boot is heavyweight for this sandbox;
// the contract under test — route, controller, service, protect, Prisma —
// is fully covered by the mounted stack.) Activated only when
// TEST_DATABASE_URL is set (CI and local disposable DBs).
//
// Covers the required contract cases:
//   - save / idempotent repeat save (no duplicate row)
//   - idempotent remove / re-add after removal
//   - owner-scoping: user A never sees or removes user B's bookmark
//   - unknown business ID fails honestly (404), missing ID fails 400
//   - own-business bookmark refused
//   - list returns only the caller's bookmarks with real pagination
//   - route-boundary auth: no token -> 401
//   - referential integrity: business deletion cascades bookmarks away
//   - NO global truncation: cleanup deletes only the rows this suite seeds
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn(
        '[business-bookmarks.test] TEST_DATABASE_URL not set — skipping. ' +
        'Set it to a disposable Postgres URL to enable.');
}

describeOrSkip('Business bookmark API (integration)', () => {
    let app;
    let request;
    let prisma;
    const seq = { n: 0 };
    const uniq = () => `bmk_${Date.now()}_${++seq.n}`;

    // Seeded rows for dependency-ordered cleanup (NO global truncation).
    const seeded = { users: [], businesses: [] };

    let aliceToken, bobToken;
    let aliceId, bobId;
    let bizA, bizB, bizC; // A/B saved by alice; C saved by bob

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET =
            process.env.JWT_SECRET || 'test_secret_exactly_32_characters_long';
        request = require('supertest');
        const express = require('express');
        const bcrypt = require('bcryptjs');
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        // Minimal app carrying the EXACT production middleware stack for
        // /api/bookmarks: responseHelpers + prismaInjector (as src/routes
        // mounts them under /api) + the real routes with protect. The
        // shared prisma singleton is registered on the app the same way
        // server.js registers it (protect reads req.app.get('prisma')).
        const { prisma: sharedPrisma } = require('../src/config/baseServices');
        app = express();
        app.use(express.json());
        app.set('prisma', sharedPrisma);
        app.use('/api', require('../middleware/responseHelpers'));
        app.use('/api', require('../src/middleware/prismaInjector'));
        app.use('/api/bookmarks', require('../routes/bookmarkRoutes'));
        // Public business profile route — mounted for the deep-link contract
        // test (GET /api/business/:bizId must resolve the bookmarked row).
        app.use('/api/business', require('../routes/businessRoutes'));

        // Real users with real bcrypt hashes; access tokens minted by the
        // repo's own canonical signer (authTokenService), so protect's
        // Phase-K tokenVersion check runs against an honest claim.
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
            return { token: signAccessToken(u), id: u.id };
        }

        const alice = await makeUser('alice');
        const bob = await makeUser('bob');
        aliceToken = alice.token;
        bobToken = bob.token;
        aliceId = alice.id;
        bobId = bob.id;

        // Real business profiles owned by a third seeded user.
        const owner = await prisma.user.create({
            data: {
                username: `owner_${uniq()}`,
                email: `owner_${uniq()}@azaman.test`,
                password: 'hashed-by-test-placeholder-not-used-for-login',
                availableBalance: 0, escrowLockedBalance: 0, disputeEscrowBalance: 0,
                azamanId: `AZM-${uniq()}`,
            },
        });
        seeded.users.push(owner.id);

        async function seedBiz(name) {
            const b = await prisma.businessProfile.create({
                data: {
                    userId: owner.id,
                    bizId: `BIZ-${uniq()}`,
                    businessName: `BookmarkTest ${name}`,
                    category: 'FOOD_BEVERAGE',
                    isVerified: true,
                    kybStatus: 'VERIFIED',
                },
            });
            seeded.businesses.push(b.id);
            return b;
        }
        bizA = await seedBiz('Alpha');
        bizB = await seedBiz('Bravo');
        bizC = await seedBiz('Charlie');
    });

    afterAll(async () => {
        // Dependency-ordered, seed-scoped cleanup only. BusinessProfile and
        // User both cascade their bookmarks; the explicit bookmark deleteMany
        // is defensive and unconditionally safe (scoped to our users).
        await prisma.businessBookmark.deleteMany({
            where: { customerId: { in: seeded.users } },
        });
        await prisma.businessProfile.deleteMany({
            where: { id: { in: seeded.businesses } },
        });
        // Users created via /api/auth/register may own marketplace rows; the
        // dependency order is users LAST for that reason.
        for (const uid of seeded.users.slice().reverse()) {
            await prisma.user.delete({ where: { id: uid } }).catch(() => {});
        }
        await prisma.$disconnect();
        // The minimal app registered the shared baseServices singleton
        // (protect reads req.app.get('prisma')); close it so the jest
        // worker can exit cleanly instead of being force-killed with an
        // open DB handle.
        const { prisma: shared } = require('../src/config/baseServices');
        await shared.$disconnect().catch(() => {});
    });

    // ─── route-boundary auth ────────────────────────────────────────────────

    test('unauthenticated requests are rejected with 401 at the route boundary', async () => {
        expect((await request(app).post('/api/bookmarks').send({ businessProfileId: bizA.id })).statusCode).toBe(401);
        expect((await request(app).get('/api/bookmarks')).statusCode).toBe(401);
        expect((await request(app).delete(`/api/bookmarks/${bizA.id}`)).statusCode).toBe(401);
    });

    // ─── save / idempotency ─────────────────────────────────────────────────

    test('bookmarking a valid business returns 201 with explicit BOOKMARKED state', async () => {
        const res = await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .send({ businessProfileId: bizA.id });
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.state).toBe('BOOKMARKED');
        expect(res.body.alreadyBookmarked).toBe(false);
        expect(res.body.bookmark.businessProfileId).toBe(bizA.id);
        expect(res.body.bookmark.savedAt).toBeTruthy();
    });

    test('repeated bookmark creates no duplicate row and reports alreadyBookmarked', async () => {
        const res = await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .send({ businessProfileId: bizA.id });
        expect(res.statusCode).toBe(200);
        expect(res.body.state).toBe('BOOKMARKED');
        expect(res.body.alreadyBookmarked).toBe(true);
        const rows = await prisma.businessBookmark.findMany({
            where: { customerId: aliceId, businessProfileId: bizA.id },
        });
        expect(rows).toHaveLength(1);
    });

    test('missing businessProfileId fails with 400, not a fake success', async () => {
        const res = await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .send({});
        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    test('unknown business ID fails honestly with 404 BUSINESS_NOT_FOUND', async () => {
        const res = await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .send({ businessProfileId: 'nonexistent-profile-id' });
        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('BUSINESS_NOT_FOUND');
    });

    test('users cannot bookmark their own business', async () => {
        const ownerBiz = await prisma.businessProfile.create({
            data: {
                userId: aliceId,
                bizId: `BIZ-${uniq()}`,
                businessName: 'Alice Own Biz',
                category: 'FOOD_BEVERAGE',
                isVerified: true,
                kybStatus: 'VERIFIED',
            },
        });
        seeded.businesses.push(ownerBiz.id);
        const res = await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .send({ businessProfileId: ownerBiz.id });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('OWN_BUSINESS');
    });

    // ─── remove / re-add ────────────────────────────────────────────────────

    test('unbookmark is idempotent with explicit NOT_BOOKMARKED state', async () => {
        const first = await request(app)
            .delete(`/api/bookmarks/${bizA.id}`)
            .set('Authorization', `Bearer ${aliceToken}`);
        expect(first.statusCode).toBe(200);
        expect(first.body.state).toBe('NOT_BOOKMARKED');
        expect(first.body.removed).toBe(true);

        const second = await request(app)
            .delete(`/api/bookmarks/${bizA.id}`)
            .set('Authorization', `Bearer ${aliceToken}`);
        expect(second.statusCode).toBe(200);
        expect(second.body.removed).toBe(false);
    });

    test('re-adding after removal creates a fresh bookmark', async () => {
        const res = await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .send({ businessProfileId: bizA.id });
        expect(res.statusCode).toBe(201);
        expect(res.body.alreadyBookmarked).toBe(false);
        const check = await request(app)
            .get(`/api/bookmarks/check/${bizA.id}`)
            .set('Authorization', `Bearer ${aliceToken}`);
        expect(check.body.bookmarked).toBe(true);
    });

    test('unbookmarking an unknown business fails honestly with 404', async () => {
        const res = await request(app)
            .delete('/api/bookmarks/nonexistent-profile-id')
            .set('Authorization', `Bearer ${aliceToken}`);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('BUSINESS_NOT_FOUND');
    });

    // ─── owner scoping ──────────────────────────────────────────────────────

    test('user B cannot see or remove user A bookmarks', async () => {
        // Alice has bizA; bob bookmarks bizC.
        await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${bobToken}`)
            .send({ businessProfileId: bizC.id });

        // Bob's check on bizA (alice's bookmark) must be false.
        const check = await request(app)
            .get(`/api/bookmarks/check/${bizA.id}`)
            .set('Authorization', `Bearer ${bobToken}`);
        expect(check.body.bookmarked).toBe(false);

        // Bob "unbookmarking" bizA is a no-op for alice's row.
        const del = await request(app)
            .delete(`/api/bookmarks/${bizA.id}`)
            .set('Authorization', `Bearer ${bobToken}`);
        expect(del.statusCode).toBe(200);
        expect(del.body.removed).toBe(false);

        // Alice's bookmark is untouched.
        const aliceCheck = await request(app)
            .get(`/api/bookmarks/check/${bizA.id}`)
            .set('Authorization', `Bearer ${aliceToken}`);
        expect(aliceCheck.body.bookmarked).toBe(true);
    });

    test('list returns only the callers actual saved profiles', async () => {
        await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .send({ businessProfileId: bizB.id });

        const aliceList = await request(app)
            .get('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`);
        expect(aliceList.statusCode).toBe(200);
        expect(aliceList.body.success).toBe(true);
        const aliceIds = aliceList.body.bookmarks.map(b => b.businessProfileId);
        expect(aliceIds).toContain(bizA.id);
        expect(aliceIds).toContain(bizB.id);
        expect(aliceIds).not.toContain(bizC.id);
        expect(aliceList.body.total).toBeGreaterThanOrEqual(2);

        const bobList = await request(app)
            .get('/api/bookmarks')
            .set('Authorization', `Bearer ${bobToken}`);
        const bobIds = bobList.body.bookmarks.map(b => b.businessProfileId);
        expect(bobIds).toEqual([bizC.id]);

        // Card fields the frontend renders are present and real.
        const first = aliceList.body.bookmarks[0];
        expect(first).toHaveProperty('businessName');
        expect(first).toHaveProperty('category');
        expect(first).toHaveProperty('isVerified');
        expect(first).toHaveProperty('savedAt');
    });

    test('deep-link contract: list returns BOTH ids and bizId opens the correct public profile route', async () => {
        await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .send({ businessProfileId: bizB.id });

        const list = await request(app)
            .get('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .expect(200);

        // Every row ships BOTH identifiers, accurately paired.
        for (const b of list.body.bookmarks) {
            expect(typeof b.businessProfileId).toBe('string');
            expect(typeof b.bizId).toBe('string');
            expect(b.bizId).toMatch(/^BIZ-/);
        }
        const rowB = list.body.bookmarks.find(b => b.businessProfileId === bizB.id);
        expect(rowB).toBeTruthy();
        expect(rowB.bizId).toBe(bizB.bizId);

        // The public deep link resolves the SAME profile the canonical id
        // refers to — the bookmark card can navigate straight from the row.
        const profile = await request(app)
            .get(`/api/business/${rowB.bizId}`)
            .expect(200);
        expect(profile.body.business.id).toBe(bizB.id);
        expect(profile.body.business.businessName).toBe(bizB.businessName);

        // Account isolation is unchanged by the new field: bob never sees it.
        const bobList = await request(app)
            .get('/api/bookmarks')
            .set('Authorization', `Bearer ${bobToken}`);
        expect(bobList.body.bookmarks.find(b => b.bizId === bizB.bizId)).toBeFalsy();

        // Ordering and pagination unchanged (newest first, limit respected).
        const paged = await request(app)
            .get('/api/bookmarks?limit=1')
            .set('Authorization', `Bearer ${aliceToken}`)
            .expect(200);
        expect(paged.body.bookmarks.length).toBe(1);
        expect(paged.body.bookmarks[0].businessProfileId)
            .toBe(list.body.bookmarks[0].businessProfileId);
    });

    test('list pagination is real (limit/offset)', async () => {
        const page = await request(app)
            .get('/api/bookmarks?limit=1&offset=0')
            .set('Authorization', `Bearer ${aliceToken}`);
        expect(page.statusCode).toBe(200);
        expect(page.body.bookmarks).toHaveLength(1);
        expect(page.body.total).toBeGreaterThanOrEqual(2);
    });

    // ─── referential integrity ──────────────────────────────────────────────

    test('deleting a business profile cascades its bookmarks away', async () => {
        const victimOwner = await prisma.user.create({
            data: {
                username: `vowner_${uniq()}`,
                email: `vowner_${uniq()}@azaman.test`,
                password: 'hashed-by-test-placeholder-not-used-for-login',
                availableBalance: 0, escrowLockedBalance: 0, disputeEscrowBalance: 0,
                azamanId: `AZM-${uniq()}`,
            },
        });
        seeded.users.push(victimOwner.id);
        const victim = await prisma.businessProfile.create({
            data: {
                userId: victimOwner.id,
                bizId: `BIZ-${uniq()}`,
                businessName: 'Cascade Victim',
                category: 'FOOD_BEVERAGE',
                isVerified: true,
                kybStatus: 'VERIFIED',
            },
        });
        await request(app)
            .post('/api/bookmarks')
            .set('Authorization', `Bearer ${aliceToken}`)
            .send({ businessProfileId: victim.id });
        expect(
            (await prisma.businessBookmark.findMany({
                where: { customerId: aliceId, businessProfileId: victim.id },
            })).length
        ).toBe(1);

        await prisma.businessProfile.delete({ where: { id: victim.id } });
        expect(
            await prisma.businessBookmark.findFirst({
                where: { businessProfileId: victim.id },
            })
        ).toBeNull();
    });
});
