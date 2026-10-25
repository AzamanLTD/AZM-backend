// __tests__/business-story-state.test.js
// =============================================================================
// Business story-state (marketplace personalisation, Backend B) — real
// PostgreSQL tests over the single story authority (Story/StoryView).
//
// Contract under test — the additive `storyState` block on business card
// DTOs (search response and followed-businesses response):
//   { hasActiveStory: boolean, hasUnseenStory: boolean|null, latestStoryAt: ISO|null }
//
// Required cases:
//   - no active stories / active+unseen / active+seen / expired latest
//   - anonymous vs authenticated response
//   - N+1: query count stays constant as businesses on the page grow
//   - existing card fields untouched (backward compatibility)
//   - service is read-only: no Story/StoryView rows are ever written
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[business-story-state.test] TEST_DATABASE_URL not set — skipping.');
}

describeOrSkip('Business story state (Backend B)', () => {
    let prisma;
    const seq = { n: 0 };
    const uniq = () => `bss_${Date.now()}_${++seq.n}`;
    const seeded = { users: [], businesses: [], stories: [], views: [] };

    // The service under test — a pure read layer over Story/StoryView.
    const { attachStoryState } = require('../services/marketplace/businessStoryStateService');

    const FUTURE = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
    const PAST = () => new Date(Date.now() - 60 * 1000);

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });
    afterAll(async () => {
        // Seed-scoped, dependency-ordered cleanup. No global truncation.
        await prisma.storyView.deleteMany({ where: { storyId: { in: seeded.stories } } });
        await prisma.story.deleteMany({ where: { id: { in: seeded.stories } } });
        await prisma.businessProfile.deleteMany({ where: { id: { in: seeded.businesses } } });
        for (const uid of seeded.users.slice().reverse()) {
            await prisma.user.delete({ where: { id: uid } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    async function seedBizWithStories(nStories, { expiresInFuture = true } = {}) {
        const owner = await prisma.user.create({
            data: {
                username: `o_${uniq()}`, email: `o_${uniq()}@azaman.test`,
                password: 'hashed-placeholder', azamanId: `AZM-${uniq()}`,
                availableBalance: 0, escrowLockedBalance: 0, disputeEscrowBalance: 0,
            },
        });
        seeded.users.push(owner.id);
        const biz = await prisma.businessProfile.create({
            data: {
                userId: owner.id, bizId: `BIZ-${uniq()}`,
                businessName: `StoryState ${uniq()}`, category: 'FOOD_BEVERAGE',
                isVerified: true, kybStatus: 'VERIFIED',
            },
        });
        seeded.businesses.push(biz.id);
        for (let i = 0; i < nStories; i++) {
            const st = await prisma.story.create({
                data: {
                    userId: owner.id, businessProfileId: biz.id,
                    mediaUrl: `https://cdn.test/${uniq()}.jpg`,
                    expiresAt: expiresInFuture ? FUTURE() : PAST(),
                },
            });
            seeded.stories.push(st.id);
        }
        return { owner, biz };
    }

    test('no active stories -> all-negative block, null timestamp', async () => {
        const { biz } = await seedBizWithStories(0);
        const rows = [{ id: biz.id, businessName: 'x' }];
        await attachStoryState(prisma, rows, 42);
        expect(rows[0].storyState).toEqual({
            hasActiveStory: false,
            hasUnseenStory: false,   // viewer 42 authenticated: nothing to see
            latestStoryAt: null,
        });
    });

    test('active story unseen by the viewer -> hasActiveStory true, hasUnseenStory true', async () => {
        const { biz, owner } = await seedBizWithStories(2);
        const rows = [{ id: biz.id }];
        await attachStoryState(prisma, rows, owner.id + 100000); // a viewer who saw nothing
        expect(rows[0].storyState.hasActiveStory).toBe(true);
        expect(rows[0].storyState.hasUnseenStory).toBe(true);
        expect(new Date(rows[0].storyState.latestStoryAt).getTime()).toBeGreaterThan(0);
    });

    test('all active stories seen -> hasUnseenStory false', async () => {
        const { biz, owner } = await seedBizWithStories(2);
        // The owner views both of their own stories (views are honest rows).
        const stories = await prisma.story.findMany({
            where: { businessProfileId: biz.id }, select: { id: true },
        });
        for (const s of stories) {
            const v = await prisma.storyView.create({
                data: { storyId: s.id, viewerId: owner.id },
            });
            seeded.views.push(v.id);
        }
        const rows = [{ id: biz.id }];
        await attachStoryState(prisma, rows, owner.id);
        expect(rows[0].storyState.hasActiveStory).toBe(true);
        expect(rows[0].storyState.hasUnseenStory).toBe(false);
        expect(rows[0].storyState.latestStoryAt).toBeTruthy();
    });

    test('latest story expired only -> hasActiveStory false', async () => {
        const { biz } = await seedBizWithStories(1, { expiresInFuture: false });
        const rows = [{ id: biz.id }];
        await attachStoryState(prisma, rows, 42);
        expect(rows[0].storyState).toEqual({
            hasActiveStory: false,
            hasUnseenStory: false,
            latestStoryAt: null,   // expired stories contribute nothing
        });
    });

    test('anonymous viewer -> hasUnseenStory is null, hasActiveStory still real', async () => {
        const { biz } = await seedBizWithStories(1);
        const rows = [{ id: biz.id }];
        await attachStoryState(prisma, rows, null);
        expect(rows[0].storyState.hasActiveStory).toBe(true);
        expect(rows[0].storyState.hasUnseenStory).toBeNull();
        expect(rows[0].storyState.latestStoryAt).toBeTruthy();
    });

    test('mixed page: per-business state is independent and correct', async () => {
        const none = await seedBizWithStories(0);
        const unseen = await seedBizWithStories(1);
        const expired = await seedBizWithStories(1, { expiresInFuture: false });
        const rows = [{ id: none.biz.id }, { id: unseen.biz.id }, { id: expired.biz.id }];
        await attachStoryState(prisma, rows, 42);
        expect(rows[0].storyState.hasActiveStory).toBe(false);
        expect(rows[1].storyState.hasActiveStory).toBe(true);
        expect(rows[1].storyState.hasUnseenStory).toBe(true);
        expect(rows[2].storyState.hasActiveStory).toBe(false);
    });

    test('N+1-free: query count is constant as page size grows', async () => {
        const rows = [];
        for (let i = 0; i < 3; i++) rows.push({ id: (await seedBizWithStories(1)).biz.id });
        const spyStory = jest.spyOn(prisma.story, 'findMany');
        const spyView = jest.spyOn(prisma.storyView, 'findMany');
        await attachStoryState(prisma, rows, 42);
        const smallCounts = [spyStory.mock.calls.length, spyView.mock.calls.length];

        const bigger = [...rows, ...rows, { id: (await seedBizWithStories(1)).biz.id }];
        spyStory.mockClear(); spyView.mockClear();
        await attachStoryState(prisma, bigger, 42);
        const bigCounts = [spyStory.mock.calls.length, spyView.mock.calls.length];

        expect(bigCounts).toEqual(smallCounts); // exactly 2 queries, page-size-independent
        spyStory.mockRestore(); spyView.mockRestore();
    });

    test('attachStoryState never writes and preserves existing card fields', async () => {
        const { biz } = await seedBizWithStories(1);
        const before = await prisma.story.count({ where: { businessProfileId: biz.id } });
        const rows = [{ id: biz.id, businessName: 'Keep Me', isVerified: true, averageRating: 4.5 }];
        await attachStoryState(prisma, rows, 42);
        const after = await prisma.story.count({ where: { businessProfileId: biz.id } });
        expect(after).toBe(before);
        expect(rows[0].businessName).toBe('Keep Me');
        expect(rows[0].isVerified).toBe(true);
        expect(rows[0].averageRating).toBe(4.5);
        expect(rows[0].storyState.hasActiveStory).toBe(true);
    });

    // ─── route-boundary wiring ──────────────────────────────────────────────

    test('optionalAuth resolves the viewer on the public search route without rejecting anonymous calls', async () => {
        const express = require('express');
        const jwt = require('jsonwebtoken');
        const { optionalAuth } = require('../middleware/optionalAuth');
        const { protect } = require('../middleware/authMiddleware');
        const app = express();
        const { prisma: shared } = require('../src/config/baseServices');
        app.set('prisma', shared);

        const seen = {};
        app.get('/anon', optionalAuth, (req, res) => { seen.anon = req.user || null; res.json({ ok: true }); });
        app.get('/authed', optionalAuth, (req, res) => { seen.authed = req.user ? req.user.id : null; res.json({ ok: true }); });
        app.get('/bad', optionalAuth, (req, res) => { seen.bad = req.user || null; res.json({ ok: true }); });
        const request = require('supertest');

        // Anonymous: proceeds with no req.user.
        expect((await request(app).get('/anon')).statusCode).toBe(200);
        expect(seen.anon).toBeNull();

        // Valid token: resolves req.user.id to the real user id.
        const { signAccessToken } = require('../services/authTokenService');
        const owner = seeded.users[seeded.users.length - 1];
        const token = signAccessToken({ id: owner, username: 'x', role: 'USER', tokenVersion: 0 });
        expect((await request(app).get('/authed').set('Authorization', `Bearer ${token}`)).statusCode).toBe(200);
        expect(seen.authed).toBe(owner);

        // Garbage token: still 200, anonymous.
        expect((await request(app).get('/bad').set('Authorization', 'Bearer not.a.jwt')).statusCode).toBe(200);
        expect(seen.bad).toBeNull();
        await shared.$disconnect().catch(() => {});
    });
});
