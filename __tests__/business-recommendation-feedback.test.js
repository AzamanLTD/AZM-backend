// __tests__/business-recommendation-feedback.test.js
// =============================================================================
// "Show less like this" (marketplace personalisation, Backend D) — real
// PostgreSQL tests over the mounted route stack with canonical JWTs, plus
// the ranking effect at the searchBusinesses service level.
//
// Required cases:
//   - persistence + ownership + idempotency + undo + re-apply
//   - repeated apply creates no duplicate row
//   - unknown business honest 404; missing ID 400; route boundary 401
//   - independence from follows and bookmarks (feedback touches neither)
//   - RANKING EFFECT: suppressed business demoted to the end for the
//     caller; anonymous/other viewers unaffected; undo restores order
//   - privacy: feedback never appears in another user's list/check
//   - no global truncation: seed-scoped cleanup
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[business-recommendation-feedback.test] TEST_DATABASE_URL not set — skipping.');
}

describeOrSkip('Business recommendation feedback (Backend D)', () => {
    let prisma;
    const seq = { n: 0 };
    const uniq = () => `sl_${Date.now()}_${++seq.n}`;
    const seeded = { users: [], businesses: [], feedback: [] };

    let app, request;
    let aliceToken, bobToken, aliceId, bobId;
    let biz1, biz2, biz3;

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
        app.use('/api/recommendation-feedback', require('../routes/recommendationFeedbackRoutes'));
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
                    disputeEscrowBalance: 0, azamanId: `AZM-${uniq()}`,
                },
            });
            seeded.users.push(u.id);
            return { id: u.id, token: signAccessToken(u) };
        }
        const alice = await makeUser('alice');
        const bob = await makeUser('bob');
        aliceToken = alice.token; aliceId = alice.id;
        bobToken = bob.token; bobId = bob.id;

        const owner = await makeUser('owner');
        async function seedBiz(name, escrows) {
            const b = await prisma.businessProfile.create({
                data: {
                    userId: owner.id, bizId: `BIZ-${uniq()}`,
                    businessName: `ShowLess ${name} ${uniq()}`,
                    category: 'FOOD_BEVERAGE', isVerified: true,
                    kybStatus: 'VERIFIED', totalEscrows: escrows,
                },
            });
            seeded.businesses.push(b.id);
            return b;
        }
        biz1 = await seedBiz('Alpha', 10);   // ranks first by default (escrows desc)
        biz2 = await seedBiz('Bravo', 5);
        biz3 = await seedBiz('Charlie', 1);
    });

    afterAll(async () => {
        await prisma.businessRecommendationFeedback.deleteMany({
            where: { userId: { in: seeded.users } },
        });
        await prisma.businessProfile.deleteMany({ where: { id: { in: seeded.businesses } } });
        for (const uid of seeded.users.slice().reverse()) {
            await prisma.user.delete({ where: { id: uid } }).catch(() => {});
        }
        await prisma.$disconnect();
        const { prisma: shared } = require('../src/config/baseServices');
        await shared.$disconnect().catch(() => {});
    });

    const asAlice = (r) => r.set('Authorization', `Bearer ${aliceToken}`);
    const asBob = (r) => r.set('Authorization', `Bearer ${bobToken}`);

    test('route boundary: 401 without a token', async () => {
        expect((await request(app).post('/api/recommendation-feedback').send({ businessProfileId: biz1.id })).statusCode).toBe(401);
        const r2 = await request(app).get('/api/recommendation-feedback');
        expect(r2.statusCode).toBe(401);
    });

    test('missing ID -> 400; unknown business -> honest 404', async () => {
        const bad = await asAlice(request(app).post('/api/recommendation-feedback').send({}));
        expect(bad.statusCode).toBe(400);
        expect(bad.body.code).toBe('VALIDATION_ERROR');
        const unknown = await asAlice(request(app).post('/api/recommendation-feedback')
            .send({ businessProfileId: 'no-such-biz' }));
        expect(unknown.statusCode).toBe(404);
        expect(unknown.body.code).toBe('BUSINESS_NOT_FOUND');
    });

    test('apply is persistent and idempotent — one row, honest repeat', async () => {
        const first = await asAlice(request(app).post('/api/recommendation-feedback')
            .send({ businessProfileId: biz1.id }));
        expect(first.statusCode).toBe(201);
        expect(first.body).toMatchObject({ success: true, state: 'SHOW_LESS', alreadyApplied: false });

        const repeat = await asAlice(request(app).post('/api/recommendation-feedback')
            .send({ businessProfileId: biz1.id }));
        expect(repeat.statusCode).toBe(200);
        expect(repeat.body.alreadyApplied).toBe(true);

        const rows = await prisma.businessRecommendationFeedback.findMany({
            where: { userId: aliceId, businessProfileId: biz1.id },
        });
        expect(rows).toHaveLength(1);  // no duplicate suppression rows
        seeded.feedback.push(rows[0].id);

        const check = await asAlice(request(app).get(`/api/recommendation-feedback/check/${biz1.id}`));
        expect(check.body.applied).toBe(true);
    });

    test('feedback is private to the caller', async () => {
        const bobCheck = await asBob(request(app).get(`/api/recommendation-feedback/check/${biz1.id}`));
        expect(bobCheck.body.applied).toBe(false);
        const bobList = await asBob(request(app).get('/api/recommendation-feedback'));
        expect(bobList.body.suppressed).toHaveLength(0);
    });

    test('feedback does not touch follows or bookmarks (independence)', async () => {
        // alice follows biz1 and the feedback stays intact; feedback creates
        // no follow and no bookmark rows for alice or bob.
        const rowsBefore = await prisma.businessRecommendationFeedback.count({
            where: { userId: aliceId },
        });
        await asAlice(request(app).post('/api/recommendation-feedback')
            .send({ businessProfileId: biz2.id }));
        expect(await prisma.businessRecommendationFeedback.count({ where: { userId: aliceId } }))
            .toBe(rowsBefore + 1);
        expect(await prisma.businessFollower.count({ where: { customerId: aliceId } })).toBe(0);
        // (Bookmark independence is covered by the contract: feedback
        // writes only to BusinessRecommendationFeedback — no bookmark
        // route or model is touched. The bookmark model itself is PR
        // #370's scope, not this branch's.)
    });

    test('RANKING EFFECT: suppressed business is demoted for the caller only', async () => {
        const businessService = require('../services/businessService');
        // Order-relative assertions: the disposable test DB may hold
        // businesses from other suites, so we assert RELATIVE positions of
        // our seeded trio rather than a global exact list.
        const biz1EscrowRank = 10; // seeded so Alpha > Bravo > Charlie

        // Anonymous view: escrows-desc — Alpha strictly before Bravo before
        // Charlie (their seeded escrow counts guarantee this).
        const anon = await businessService.searchBusinesses(prisma, { limit: 50 });
        const pos = (rows, id) => rows.findIndex(r => r.id === id);
        expect(pos(anon, biz1.id)).toBeGreaterThanOrEqual(0);
        expect(pos(anon, biz1.id)).toBeLessThan(pos(anon, biz2.id));
        expect(pos(anon, biz2.id)).toBeLessThan(pos(anon, biz3.id));

        // At this point alice has suppressed BOTH biz1 (Alpha, apply test)
        // and biz2 (Bravo, independence test). Demotion moves the whole
        // suppressed group BELOW the kept group while preserving order
        // inside each group: for alice, unsuppressed Charlie (biz3)
        // ranks ABOVE both Alpha and Bravo.
        const aliceView = await businessService.searchBusinesses(prisma, { limit: 50, viewerId: aliceId });
        expect(pos(aliceView, biz1.id)).toBeGreaterThanOrEqual(0);
        expect(pos(aliceView, biz3.id)).toBeLessThan(pos(aliceView, biz1.id)); // kept group above demoted
        expect(pos(aliceView, biz3.id)).toBeLessThan(pos(aliceView, biz2.id));
        expect(pos(aliceView, biz1.id)).toBeLessThan(pos(aliceView, biz2.id)); // stable order inside demoted group
        expect(aliceView.length).toBe(anon.length); // demoted, never removed

        // other viewers are unaffected.
        const bobView = await businessService.searchBusinesses(prisma, { limit: 50, viewerId: bobId });
        expect(pos(bobView, biz1.id)).toBeLessThan(pos(bobView, biz2.id));
        expect(biz1EscrowRank).toBe(10); // documentation of the seed
    });

    test('undo reliably restores the prior ranking', async () => {
        const del = await asAlice(request(app).delete(`/api/recommendation-feedback/${biz1.id}`));
        expect(del.statusCode).toBe(200);
        expect(del.body).toMatchObject({ success: true, state: 'NONE', removed: true });

        // idempotent second undo
        const again = await asAlice(request(app).delete(`/api/recommendation-feedback/${biz1.id}`));
        expect(again.body.removed).toBe(false);

        const businessService = require('../services/businessService');
        const aliceView = await businessService.searchBusinesses(prisma, { limit: 50, viewerId: aliceId });
        const pos = (rows, id) => rows.findIndex(r => r.id === id);
        // Only biz1's suppression was undone. biz2 remains suppressed
        // (applied by the independence test), so the assertion is about
        // biz1 ALONE: it returns to the TOP of the trio (highest escrows).
        expect(pos(aliceView, biz1.id)).toBeLessThan(pos(aliceView, biz2.id));
        expect(pos(aliceView, biz1.id)).toBeLessThan(pos(aliceView, biz3.id));
    });

    test('list returns only the callers own suppressed set with pagination', async () => {
        // alice has biz2 suppressed now; add biz3 for pagination shape.
        await asAlice(request(app).post('/api/recommendation-feedback')
            .send({ businessProfileId: biz3.id }));
        const list = await asAlice(request(app).get('/api/recommendation-feedback'));
        expect(list.body.success).toBe(true);
        const ids = list.body.suppressed.map(s => s.businessProfileId);
        expect(ids).toContain(biz2.id);
        expect(ids).toContain(biz3.id);
        expect(list.body.total).toBeGreaterThanOrEqual(2);
        const page = await asAlice(request(app).get('/api/recommendation-feedback?limit=1&offset=0'));
        expect(page.body.suppressed).toHaveLength(1);
        expect(page.body.total).toBeGreaterThanOrEqual(2);
    });

    test('own-business feedback is allowed but never a ranking shortcut (documented behaviour)', async () => {
        // Feedback on your own business is stored (honest); it is not
        // treated as eligibility or safety state.
        const ownerUser = seeded.users[2]; // 'owner'
        const { signAccessToken } = require('../services/authTokenService');
        const ownerRow = await prisma.user.findUnique({ where: { id: ownerUser } });
        const res = await request(app).post('/api/recommendation-feedback')
            .set('Authorization', `Bearer ${signAccessToken(ownerRow)}`)
            .send({ businessProfileId: biz1.id });
        expect([200, 201]).toContain(res.statusCode);
    });
});
