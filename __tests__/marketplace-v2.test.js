// __tests__/marketplace-v2.test.js
// =============================================================================
// AZAMAN MARKETPLACE V2 — COMPREHENSIVE TEST SUITE
// Tests all new marketplace services against a live PostgreSQL database.
// =============================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.test') });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const FollowService = require('../services/marketplace/followService');
const AdPostService = require('../services/marketplace/adPostService');
const DineInService = require('../services/marketplace/dineInService');
const { PenaltyPolicyService, MAX_PENALTY_PCT } = require('../services/marketplace/penaltyPolicyService');
const TrustScoreService = require('../services/marketplace/trustScoreService');
const ShowcaseService = require('../services/marketplace/showcaseService');
const StoryService = require('../services/storyService');
const { generateCheckInToken, generateTransitCheckInToken, verifyAndCheckIn } = require('../services/qrCheckInService');

const prisma = new PrismaClient();

let _seq = 0;
const _uniq = () => `${Date.now()}_${++_seq}`;
const TEST_PASSWORD = 'TestPass1!secure';

async function seedUser(overrides = {}) {
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    const id = _uniq();
    const user = await prisma.user.create({
        data: {
            username: overrides.username || `user_${id}`,
            email: overrides.email || `user_${id}@test.com`,
            password: hash,
            availableBalance: overrides.availableBalance ?? 1000.0,
            escrowLockedBalance: 0.0,
            disputeEscrowBalance: 0.0,
            azamanId: overrides.azamanId || `AZM-TEST-${id}`,
            ...overrides,
        },
    });
    if (Number(user.availableBalance) > 0) {
        await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'DEPOSIT_CRYPTO',
                amountUsdc: user.availableBalance,
                feeUsdc: 0,
                status: 'COMPLETED',
                txHash: `0x_test_${_uniq()}`,
            },
        });
    }
    return user;
}

async function seedBusiness(userId, overrides = {}) {
    const id = _uniq();
    const data = {
        userId,
        bizId: `BIZ-${id}`,
        businessName: overrides.businessName || `Test Business ${id}`,
        category: overrides.category || 'FOOD_BEVERAGE',
        isVerified: overrides.isVerified ?? true,
        kybStatus: overrides.kybStatus || 'VERIFIED',
    };
    if (overrides.isSuspended !== undefined) data.isSuspended = overrides.isSuspended;
    delete overrides.userId; delete overrides.businessName; delete overrides.category;
    delete overrides.isVerified; delete overrides.kybStatus; delete overrides.isSuspended;
    Object.assign(data, overrides);
    return prisma.businessProfile.create({ data });
}

async function cleanupAll() {
    await prisma.dineInTabItem.deleteMany();
    await prisma.dineInTab.deleteMany();
    await prisma.businessShowcase.deleteMany();
    await prisma.businessAdPost.deleteMany();
    await prisma.businessFollower.deleteMany();
    await prisma.penaltyPolicy.deleteMany();
    await prisma.customerTrustScore.deleteMany();
    await prisma.storyView.deleteMany();
    await prisma.story.deleteMany();
    await prisma.businessReview.deleteMany();
    await prisma.reservation.deleteMany();
    await prisma.transitBookingSeat.deleteMany();
    await prisma.transitBooking.deleteMany();
    await prisma.transitTrip.deleteMany();
    await prisma.transitVehicle.deleteMany();
    await prisma.smartEscrow.deleteMany();
    await prisma.businessProfile.deleteMany();
    await prisma.transactionHistory.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.user.deleteMany({ where: { username: { startsWith: 'user_' } } });
}

let followService, adPostService, dineInService, penaltyService, trustService, showcaseService, storyService;

beforeAll(async () => {
    followService = new FollowService(prisma, null);
    adPostService = new AdPostService(prisma, null, null);
    dineInService = new DineInService(prisma, null);
    penaltyService = new PenaltyPolicyService(prisma);
    trustService = new TrustScoreService(prisma);
    showcaseService = new ShowcaseService(prisma);
    storyService = new StoryService(null, prisma, null, null);
});

afterAll(async () => {
    await cleanupAll();
    await prisma.$disconnect();
});

// =============================================================================
// GROUP 1: FOLLOW SYSTEM
// =============================================================================
describe('Group 1: Follow System', () => {
    let user1, user2, biz1;

    beforeAll(async () => {
        user1 = await seedUser();
        user2 = await seedUser();
        biz1 = await seedBusiness(user2.id);
    });

    test('1.1 — User can follow a business', async () => {
        const result = await followService.follow(user1.id, biz1.id);
        expect(result.success).toBe(true);
        const isFollowing = await followService.isFollowing(user1.id, biz1.id);
        expect(isFollowing).toBe(true);
    });

    test('1.2 — Follow is idempotent', async () => {
        const result = await followService.follow(user1.id, biz1.id);
        expect(result.success).toBe(true);
        const count = await followService.getFollowerCount(biz1.id);
        expect(count).toBe(1);
    });

    test('1.3 — Cannot follow own business', async () => {
        await expect(followService.follow(user2.id, biz1.id)).rejects.toThrow('Cannot follow your own business');
    });

    test('1.4 — getFollowing returns followed businesses', async () => {
        const following = await followService.getFollowing(user1.id);
        expect(following).toHaveLength(1);
        expect(following[0].id).toBe(biz1.id);
    });

    test('1.5 — getFollowers returns followers', async () => {
        const followers = await followService.getFollowers(biz1.id);
        expect(followers).toHaveLength(1);
        expect(followers[0].id).toBe(user1.id);
    });

    test('1.6 — Unfollow works and is idempotent', async () => {
        await followService.unfollow(user1.id, biz1.id);
        expect(await followService.isFollowing(user1.id, biz1.id)).toBe(false);
        await followService.unfollow(user1.id, biz1.id); // should not error
    });

    test('1.7 — getFollowedBusinessIds returns empty when no follows', async () => {
        const ids = await followService.getFollowedBusinessIds(user1.id);
        expect(ids).toEqual([]);
    });
});

// =============================================================================
// GROUP 2: AD POSTS
// =============================================================================
describe('Group 2: Ad Posts', () => {
    let bizOwner, follower, nonFollower, biz;

    beforeAll(async () => {
        bizOwner = await seedUser();
        follower = await seedUser();
        nonFollower = await seedUser();
        biz = await seedBusiness(bizOwner.id);
        await followService.follow(follower.id, biz.id);
    });

    test('2.1 — Create ad post', async () => {
        const post = await adPostService.createAdPost({
            businessProfileId: biz.id,
            type: 'PROMOTION',
            title: 'Weekend Special',
            body: '20% off all meals!',
            ctaLabel: 'Order Now',
            ctaTarget: '/menu',
        });
        expect(post.id).toBeDefined();
        expect(post.templateType).toBe('PROMOTION');
    });

    test('2.2 — Ad post creates a linked Story', async () => {
        const stories = await prisma.story.findMany({ where: { businessProfileId: biz.id } });
        expect(stories.length).toBeGreaterThan(0);
    });

    test('2.3 — getActiveAdPosts returns non-expired', async () => {
        const posts = await adPostService.getActiveAdPosts(biz.id);
        expect(posts).toHaveLength(1);
    });

    test('2.4 — Feed only shows followed businesses', async () => {
        const followedIds = await followService.getFollowedBusinessIds(follower.id);
        const feed = await adPostService.getFeedAdPosts(follower.id, followedIds);
        expect(feed).toHaveLength(1);

        const emptyIds = await followService.getFollowedBusinessIds(nonFollower.id);
        const emptyFeed = await adPostService.getFeedAdPosts(nonFollower.id, emptyIds);
        expect(emptyFeed).toHaveLength(0);
    });

    test('2.5 — Delete ad post', async () => {
        const post = await adPostService.createAdPost({
            businessProfileId: biz.id, type: 'EVENT',
            title: 'Live Music', body: 'Jazz night!',
        });
        const result = await adPostService.deleteAdPost(post.id, biz.id);
        expect(result.success).toBe(true);
    });

    test('2.6 — Cannot delete another business ad', async () => {
        const post = await adPostService.createAdPost({
            businessProfileId: biz.id, type: 'GENERAL',
            title: 'Test', body: 'Test',
        });
        const otherBiz = await seedBusiness((await seedUser()).id);
        await expect(adPostService.deleteAdPost(post.id, otherBiz.id)).rejects.toThrow('Not authorized');
    });
});

// =============================================================================
// GROUP 3: STORY FEED READ PATH (THE CRITICAL GAP FIX)
// =============================================================================
describe('Group 3: Story Feed Read Path (Gap Fix)', () => {
    let bizOwner, follower, nonFollower, biz;

    beforeAll(async () => {
        bizOwner = await seedUser();
        follower = await seedUser();
        nonFollower = await seedUser();
        biz = await seedBusiness(bizOwner.id);
        await followService.follow(follower.id, biz.id);
        // nonFollower does NOT follow

        await prisma.story.create({
            data: {
                userId: bizOwner.id,
                mediaUrl: 'https://example.com/biz-story.jpg',
                caption: 'New menu!',
                businessProfileId: biz.id,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
        });
    });

    test('3.1 — Follower sees business stories', async () => {
        const feed = await storyService.getFeed(follower.id);
        const bizGroup = feed.find(g => g.isBusiness && g.business && g.business.id === biz.id);
        expect(bizGroup).toBeDefined();
        expect(bizGroup.stories.length).toBeGreaterThan(0);
    });

    test('3.2 — Non-follower does NOT see business stories', async () => {
        const feed = await storyService.getFeed(nonFollower.id);
        const bizGroup = feed.find(g => g.isBusiness && g.business && g.business.id === biz.id);
        expect(bizGroup).toBeUndefined();
    });

    test('3.3 — Business stories include profile info', async () => {
        const feed = await storyService.getFeed(follower.id);
        const bizGroup = feed.find(g => g.isBusiness);
        expect(bizGroup.business).toBeDefined();
        expect(bizGroup.business.businessName).toBe(biz.businessName);
    });

    test('3.4 — Expired stories excluded', async () => {
        await prisma.story.create({
            data: {
                userId: bizOwner.id,
                mediaUrl: 'https://example.com/expired.jpg',
                caption: 'Expired',
                businessProfileId: biz.id,
                expiresAt: new Date(Date.now() - 1000),
            },
        });
        const feed = await storyService.getFeed(follower.id);
        const bizGroup = feed.find(g => g.isBusiness && g.business && g.business.id === biz.id);
        const expired = bizGroup.stories.find(s => s.caption === 'Expired');
        expect(expired).toBeUndefined();
    });
});

// =============================================================================
// GROUP 4: PENALTY POLICY
// =============================================================================
describe('Group 4: Penalty Policy', () => {
    let biz;

    beforeAll(async () => {
        const owner = await seedUser();
        biz = await seedBusiness(owner.id);
    });

    test('4.1 — Default policy: 10%/10%/30min', async () => {
        const p = await penaltyService.getOrCreatePolicy(biz.id);
        expect(Number(p.customerNoShowPct)).toBe(0.10);
        expect(Number(p.businessNoShowPct)).toBe(0.10);
        expect(p.gracePeriodMins).toBe(30);
    });

    test('4.2 — Update within range', async () => {
        const p = await penaltyService.updatePolicy(biz.id, {
            customerPenaltyPct: 0.25, businessPenaltyPct: 0.15, gracePeriodMins: 45,
        });
        expect(Number(p.customerNoShowPct)).toBe(0.25);
        expect(Number(p.businessNoShowPct)).toBe(0.15);
        expect(p.gracePeriodMins).toBe(45);
    });

    test('4.3 — Cap at 50%', async () => {
        await expect(penaltyService.updatePolicy(biz.id, { customerPenaltyPct: 0.60 }))
            .rejects.toThrow('cannot exceed 0.5');
    });

    test('4.4 — No negative penalty', async () => {
        await expect(penaltyService.updatePolicy(biz.id, { customerPenaltyPct: -0.10 }))
            .rejects.toThrow('non-negative');
    });

    test('4.5 — computePenalty: customer direction', async () => {
        const { penaltyAmount, releaseAmount } = await penaltyService.computePenalty(biz.id, 100.0, 'customer');
        expect(penaltyAmount).toBe(25.0); // 25% of 100
        expect(releaseAmount).toBe(75.0);
    });

    test('4.6 — computePenalty: business direction', async () => {
        const { penaltyAmount, releaseAmount } = await penaltyService.computePenalty(biz.id, 100.0, 'business');
        expect(penaltyAmount).toBe(15.0); // 15% of 100
        expect(releaseAmount).toBe(85.0);
    });

    test('4.7 — MAX_PENALTY_PCT is 0.50', () => {
        expect(MAX_PENALTY_PCT).toBe(0.50);
    });
});

// =============================================================================
// GROUP 5: TRUST SCORE
// =============================================================================
describe('Group 5: Trust Score', () => {
    let user;

    beforeAll(async () => {
        user = await seedUser();
    });

    test('5.1 — New user: GOOD', async () => {
        const s = await trustService.getOrCreateScore(user.id);
        expect(s.trustLevel).toBe('GOOD');
    });

    test('5.2 — 5 bookings, 0 no-shows → EXCELLENT', async () => {
        for (let i = 0; i < 5; i++) await trustService.recordCompletedBooking(user.id);
        const s = await trustService.getTrustLevel(user.id);
        expect(s.trustLevel).toBe('EXCELLENT');
    });

    test('5.3 — 2 no-shows → CAUTION', async () => {
        await trustService.recordNoShow(user.id);
        await trustService.recordNoShow(user.id);
        const s = await trustService.getTrustLevel(user.id);
        expect(s.trustLevel).toBe('CAUTION');
    });

    test('5.4 — 4+ no-shows → RISK', async () => {
        await trustService.recordNoShow(user.id);
        await trustService.recordNoShow(user.id);
        const s = await trustService.getTrustLevel(user.id);
        expect(s.trustLevel).toBe('RISK');
    });
});

// =============================================================================
// GROUP 6: DINE-IN TABS
// =============================================================================
describe('Group 6: Dine-In Tabs', () => {
    let bizOwner, customer, biz;

    beforeAll(async () => {
        bizOwner = await seedUser();
        customer = await seedUser({ azamanId: `AZM-DINE-${_uniq()}` });
        biz = await seedBusiness(bizOwner.id);
    });

    test('6.1 — Open tab via AZM-ID', async () => {
        const tab = await dineInService.openTab({
            businessProfileId: biz.id, azamanId: customer.azamanId,
        });
        expect(tab.status).toBe('OPEN');
        expect(tab.customerId).toBe(customer.id);
    });

    test('6.2 — No double-open', async () => {
        await expect(dineInService.openTab({
            businessProfileId: biz.id, azamanId: customer.azamanId,
        })).rejects.toThrow('already has an open tab');
    });

    test('6.3 — Add items', async () => {
        const tabs = await dineInService.getBusinessTabs(biz.id, 'OPEN');
        const item = await dineInService.addItem({
            tabId: tabs[0].id, name: 'Jollof Rice', price: 25.0, quantity: 2,
        });
        expect(item.name).toBe('Jollof Rice');
        await dineInService.addItem({ tabId: tabs[0].id, name: 'Soda', price: 5.0 });
    });

    test('6.4 — Finalize computes total', async () => {
        const tabs = await dineInService.getBusinessTabs(biz.id, 'OPEN');
        const tab = await dineInService.finalizeTab(tabs[0].id);
        expect(tab.status).toBe('FINALIZED');
        expect(Number(tab.grandTotalUsdc)).toBe(55.0); // 2*25 + 1*5
    });

    test('6.5 — No items on finalized tab', async () => {
        const tabs = await dineInService.getBusinessTabs(biz.id, 'FINALIZED');
        await expect(dineInService.addItem({ tabId: tabs[0].id, name: 'Cake', price: 10.0 }))
            .rejects.toThrow('not OPEN');
    });

    test('6.6 — Customer confirms', async () => {
        const tabs = await dineInService.getBusinessTabs(biz.id, 'FINALIZED');
        const tab = await dineInService.confirmTab(tabs[0].id, customer.id);
        expect(tab.status).toBe('CLOSED');
    });

    test('6.7 — Cannot confirm others tab', async () => {
        const other = await seedUser();
        const tab = await dineInService.openTab({
            businessProfileId: biz.id, azamanId: customer.azamanId,
        });
        await dineInService.finalizeTab(tab.id);
        await expect(dineInService.confirmTab(tab.id, other.id)).rejects.toThrow('Not authorized');
        await dineInService.cancelTab(tab.id);
    });

    test('6.8 — Cancel open tab', async () => {
        const tab = await dineInService.openTab({
            businessProfileId: biz.id, azamanId: customer.azamanId,
        });
        await dineInService.cancelTab(tab.id);
        const fetched = await dineInService.getTab(tab.id);
        expect(fetched.status).toBe('CANCELLED');
    });

    test('6.9 — Customer tabs list', async () => {
        const tabs = await dineInService.getCustomerTabs(customer.id);
        expect(tabs.length).toBeGreaterThan(0);
    });

    test('6.10 — Nonexistent AZM-ID fails', async () => {
        await expect(dineInService.openTab({
            businessProfileId: biz.id, azamanId: 'AZM-FAKE-999',
        })).rejects.toThrow('No customer found');
    });
});

// =============================================================================
// GROUP 7: QR CHECK-IN
// =============================================================================
describe('Group 7: QR Check-In', () => {
    let bizOwner, customer, biz, reservation;

    beforeAll(async () => {
        bizOwner = await seedUser({ availableBalance: 0 });
        customer = await seedUser();
        biz = await seedBusiness(bizOwner.id, { category: 'REAL_ESTATE' });

        const now = new Date();
        reservation = await prisma.reservation.create({
            data: {
                businessProfileId: biz.id,
                customerId: customer.id,
                reservationRef: `RES-${_uniq()}`,
                partySize: 2,
                startDatetime: new Date(now.getTime() - 30 * 60 * 1000),
                endDatetime: new Date(now.getTime() + 2 * 60 * 60 * 1000),
                status: 'CONFIRMED',
                amountUsdc: 100.0,
            },
        });
    });

    test('7.1 — Generate check-in token', async () => {
        const result = await generateCheckInToken(prisma, {
            reservationId: reservation.id, customerId: customer.id,
        });
        expect(result.token).toBeDefined();
        expect(result.qrPayload).toBeDefined();
        expect(result.reservationRef).toBeDefined();
    });

    test('7.2 — Verify and check in', async () => {
        const gen = await generateCheckInToken(prisma, {
            reservationId: reservation.id, customerId: customer.id,
        });
        const result = await verifyAndCheckIn(prisma, {
            token: gen.token, businessUserId: bizOwner.id,
        });
        expect(result.success).toBe(true);
        expect(result.reservation.status).toBe('CHECKED_IN');
    });

    test('7.3 — Cannot gen token for others reservation', async () => {
        const other = await seedUser();
        await expect(generateCheckInToken(prisma, {
            reservationId: reservation.id, customerId: other.id,
        })).rejects.toThrow();
    });

    test('7.4 — Transit QR generate works', async () => {
        const vehicle = await prisma.transitVehicle.create({
            data: { businessProfileId: biz.id, type: 'BUS', capacity: 30 },
        });
        const trip = await prisma.transitTrip.create({
            data: {
                businessProfileId: biz.id, vehicleId: vehicle.id,
                routeName: 'Accra-Kumasi', origin: 'Accra', destination: 'Kumasi',
                departureAt: new Date(Date.now() + 30 * 60 * 1000),
                arrivalAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
                fareUsdc: 50.0, availableSeats: 28, status: 'SCHEDULED',
            },
        });
        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId: biz.id, customerId: customer.id,
                tripId: trip.id, status: 'CONFIRMED',
                pickupAddress: 'Accra Station', dropoffAddress: 'Kumasi Station',
                amountUsdc: 50.0, bookingRef: `TRN-${_uniq()}`,
            },
        });
        const result = await generateTransitCheckInToken(prisma, {
            bookingId: booking.id, customerId: customer.id,
        });
        expect(result.token).toBeDefined();
        expect(result.booking.id).toBe(booking.id);
    });
});

// =============================================================================
// GROUP 8: KYB GATE
// =============================================================================
describe('Group 8: KYB Gate', () => {
    let verifiedOwner, unverifiedOwner;

    beforeAll(async () => {
        verifiedOwner = await seedUser();
        unverifiedOwner = await seedUser();
        await seedBusiness(verifiedOwner.id, { kybStatus: 'VERIFIED' });
        await seedBusiness(unverifiedOwner.id, { kybStatus: 'UNVERIFIED' });
    });

    function mockReq(userId) {
        return { user: { id: userId }, app: { get: (k) => k === 'prisma' ? prisma : null } };
    }
    function mockRes() {
        const r = { statusCode: 200, body: null };
        r.status = (c) => { r.statusCode = c; return r; };
        r.json = (d) => { r.body = d; return r; };
        return r;
    }

    test('8.1 — Verified business passes', async () => {
        const kybGate = require('../middleware/kybGate');
        const req = mockReq(verifiedOwner.id);
        const res = mockRes();
        let next = false;
        await kybGate(req, res, () => { next = true; });
        expect(next).toBe(true);
    });

    test('8.2 — Unverified blocked with 403', async () => {
        const kybGate = require('../middleware/kybGate');
        const req = mockReq(unverifiedOwner.id);
        const res = mockRes();
        let next = false;
        await kybGate(req, res, () => { next = true; });
        expect(next).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('KYB_REQUIRED');
    });

    test('8.3 — Non-business user passes', async () => {
        const kybGate = require('../middleware/kybGate');
        const regular = await seedUser();
        const req = mockReq(regular.id);
        const res = mockRes();
        let next = false;
        await kybGate(req, res, () => { next = true; });
        expect(next).toBe(true);
    });
});

// =============================================================================
// GROUP 9: SHOWCASE
// =============================================================================
describe('Group 9: Showcase', () => {
    let biz;

    beforeAll(async () => {
        const owner = await seedUser();
        biz = await seedBusiness(owner.id, { category: 'REAL_ESTATE' });
    });

    test('9.1 — Add media', async () => {
        const m = await showcaseService.addMedia({
            businessProfileId: biz.id, mediaUrl: 'https://example.com/pool.jpg',
            caption: 'Pool', displayOrder: 0,
        });
        expect(m.id).toBeDefined();
        expect(m.isActive).toBe(true);
    });

    test('9.2 — Get ordered showcase', async () => {
        await showcaseService.addMedia({ businessProfileId: biz.id, mediaUrl: 'https://example.com/lobby.jpg', caption: 'Lobby', displayOrder: 1 });
        await showcaseService.addMedia({ businessProfileId: biz.id, mediaUrl: 'https://example.com/room.jpg', caption: 'Room', displayOrder: 2 });
        const s = await showcaseService.getShowcase(biz.id);
        expect(s).toHaveLength(3);
        expect(s[0].displayOrder).toBeLessThan(s[1].displayOrder);
    });

    test('9.3 — Update media', async () => {
        const s = await showcaseService.getShowcase(biz.id);
        const u = await showcaseService.updateMedia(s[0].id, { caption: 'Updated' });
        expect(u.caption).toBe('Updated');
    });

    test('9.4 — Remove (soft delete)', async () => {
        const s = await showcaseService.getShowcase(biz.id);
        await showcaseService.removeMedia(s[s.length - 1].id);
        const after = await showcaseService.getShowcase(biz.id);
        expect(after).toHaveLength(s.length - 1);
    });

    test('9.5 — Reorder', async () => {
        const s = await showcaseService.getShowcase(biz.id);
        await showcaseService.reorderMedia(s.map((m, i) => ({ id: m.id, displayOrder: i + 10 })));
        const r = await showcaseService.getShowcase(biz.id);
        expect(r[0].displayOrder).toBe(10);
    });
});

// =============================================================================
// GROUP 10: BIDIRECTIONAL PENALTY
// =============================================================================
describe('Group 10: Bidirectional Penalty', () => {
    let bizOwner, customer, biz;

    beforeAll(async () => {
        bizOwner = await seedUser();
        customer = await seedUser();
        biz = await seedBusiness(bizOwner.id);
        await penaltyService.updatePolicy(biz.id, {
            customerPenaltyPct: 0.20, businessPenaltyPct: 0.30,
        });
    });

    test('10.1 — Customer no-show: 20%', async () => {
        const { penaltyAmount, releaseAmount } = await penaltyService.computePenalty(biz.id, 200.0, 'customer');
        expect(penaltyAmount).toBe(40.0);
        expect(releaseAmount).toBe(160.0);
    });

    test('10.2 — Business no-show: 30%', async () => {
        const { penaltyAmount, releaseAmount } = await penaltyService.computePenalty(biz.id, 200.0, 'business');
        expect(penaltyAmount).toBe(60.0);
        expect(releaseAmount).toBe(140.0);
    });

    test('10.3 — Both capped at 50%', async () => {
        await expect(penaltyService.updatePolicy(biz.id, { businessPenaltyPct: 0.60 }))
            .rejects.toThrow('cannot exceed 0.5');
    });

    test('10.4 — Trust score updated after no-show', async () => {
        const before = await trustService.getTrustLevel(customer.id);
        await trustService.recordNoShow(customer.id);
        const after = await trustService.getTrustLevel(customer.id);
        expect(after.noShowCount).toBe(before.noShowCount + 1);
    });
});