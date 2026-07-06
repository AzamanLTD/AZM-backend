// __tests__/azm-friends-leaderboard.test.js
// =============================================================================
// Tests for AzmRewardService.getFriendsLeaderboard() and the accompanying
// GET /api/azm/friends-leaderboard endpoint wiring (2026-07-06).
//
// Covers:
//   A. Ranks caller + ACCEPTED friends by total AzmRewardLog earned (desc)
//   B. PENDING/REJECTED/BLOCKED friendships are excluded entirely
//   C. Friendship direction doesn't matter (requester vs addressee)
//   D. A user with zero AzmRewardLog rows still appears, ranked last, at 0
//   E. myRank correctly reflects the caller's position
//   F. getRewardSummary() now also returns loginStreak/lastLoginAt
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[azm-friends-leaderboard.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('AzmRewardService.getFriendsLeaderboard', () => {
    let prisma, AzmRewardService, service;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ({ AzmRewardService } = require('../services/azmRewardService'));
        service = new AzmRewardService(prisma, null);
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        // Sequential deletes (not TRUNCATE) per project convention to avoid
        // 40P01 deadlocks under concurrent test-file execution.
        await prisma.azmRewardLog.deleteMany({});
        await prisma.friendship.deleteMany({});
        await prisma.transactionHistory.deleteMany({});
        await prisma.user.deleteMany({});
        await new Promise((r) => setTimeout(r, 150));
    }, 15000);

    async function credit(userId, amount, source = 'TRADE_COMPLETE') {
        await prisma.azmRewardLog.create({
            data: { userId, amount, source, balanceAfter: amount, reason: 'test seed' },
        });
    }

    async function friend(aId, bId, status = 'ACCEPTED') {
        return prisma.friendship.create({
            data: { requesterId: aId, addresseeId: bId, status },
        });
    }

    test('ranks caller + accepted friends by total AZM earned, descending', async () => {
        const me = await seedUser(prisma);
        const alice = await seedUser(prisma);
        const bob = await seedUser(prisma);

        await credit(me.id, 30);
        await credit(alice.id, 100);
        await credit(bob.id, 10);

        await friend(me.id, alice.id);
        await friend(bob.id, me.id); // direction reversed on purpose

        const result = await service.getFriendsLeaderboard(me.id);

        expect(result.leaderboard.map((r) => r.userId)).toEqual([alice.id, me.id, bob.id]);
        expect(result.leaderboard[0].totalEarned).toBe(100);
        expect(result.myRank).toBe(2);
        expect(result.totalMembers).toBe(3);
        expect(result.leaderboard.find((r) => r.userId === me.id).isMe).toBe(true);
    });

    test('excludes PENDING, REJECTED, and BLOCKED friendships entirely', async () => {
        const me = await seedUser(prisma);
        const pendingFriend = await seedUser(prisma);
        const rejectedFriend = await seedUser(prisma);
        const blockedFriend = await seedUser(prisma);
        const acceptedFriend = await seedUser(prisma);

        await credit(pendingFriend.id, 500);
        await credit(rejectedFriend.id, 500);
        await credit(blockedFriend.id, 500);
        await credit(acceptedFriend.id, 5);

        await friend(me.id, pendingFriend.id, 'PENDING');
        await friend(me.id, rejectedFriend.id, 'REJECTED');
        await friend(me.id, blockedFriend.id, 'BLOCKED');
        await friend(me.id, acceptedFriend.id, 'ACCEPTED');

        const result = await service.getFriendsLeaderboard(me.id);
        const ids = result.leaderboard.map((r) => r.userId);

        expect(ids).toContain(me.id);
        expect(ids).toContain(acceptedFriend.id);
        expect(ids).not.toContain(pendingFriend.id);
        expect(ids).not.toContain(rejectedFriend.id);
        expect(ids).not.toContain(blockedFriend.id);
        expect(result.totalMembers).toBe(2);
    });

    test('a friend with zero AzmRewardLog rows still appears, ranked last at 0', async () => {
        const me = await seedUser(prisma);
        const quietFriend = await seedUser(prisma);
        await credit(me.id, 15);
        await friend(me.id, quietFriend.id);

        const result = await service.getFriendsLeaderboard(me.id);
        const quiet = result.leaderboard.find((r) => r.userId === quietFriend.id);

        expect(quiet).toBeDefined();
        expect(quiet.totalEarned).toBe(0);
        expect(quiet.rank).toBe(2);
        expect(result.myRank).toBe(1);
    });

    test('respects the limit parameter', async () => {
        const me = await seedUser(prisma);
        for (let i = 0; i < 5; i++) {
            const f = await seedUser(prisma);
            await credit(f.id, i + 1);
            await friend(me.id, f.id);
        }

        const result = await service.getFriendsLeaderboard(me.id, 3);
        expect(result.leaderboard.length).toBe(3);
        expect(result.totalMembers).toBe(6); // me + 5 friends, unaffected by limit
    });
});

describeOrSkip('AzmRewardService.getRewardSummary — streak fields', () => {
    let prisma, AzmRewardService, service;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ({ AzmRewardService } = require('../services/azmRewardService'));
        service = new AzmRewardService(prisma, null);
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.azmRewardLog.deleteMany({});
        await prisma.transactionHistory.deleteMany({});
        await prisma.user.deleteMany({});
        await new Promise((r) => setTimeout(r, 150));
    }, 15000);

    test('getRewardSummary includes loginStreak and lastLoginAt', async () => {
        const lastLogin = new Date('2026-07-05T10:00:00Z');
        const user = await seedUser(prisma, { loginStreak: 7, lastLoginAt: lastLogin });

        const summary = await service.getRewardSummary(user.id);

        expect(summary.loginStreak).toBe(7);
        expect(new Date(summary.lastLoginAt).getTime()).toBe(lastLogin.getTime());
    });

    test('defaults loginStreak to 0 when never set', async () => {
        const user = await seedUser(prisma);
        const summary = await service.getRewardSummary(user.id);
        expect(summary.loginStreak).toBe(0);
    });
});
