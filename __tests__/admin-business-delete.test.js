// __tests__/admin-business-delete.test.js
// =============================================================================
// Tests for two new admin endpoints:
//
//   DELETE /api/admin/businesses/:bizId  — hard-delete a BusinessProfile
//   DELETE /api/admin/ad-posts/:id       — admin-bypass delete of an ad post
//
// Both are mounted under the admin router which enforces protect + adminOnly
// globally. We test the controller functions directly against a real Prisma
// client (same pattern as business-ad-adapter.test.js) so we get real DB
// coverage without spinning up the HTTP server.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const businessAdminCtrl = require('../controllers/businessAdminController');

// ─── helpers ─────────────────────────────────────────────────────────────────

let _seq = 0;
const _uniq = () => `adTest_${Date.now()}_${++_seq}`;

async function seedUser() {
    const hash = await bcrypt.hash('TestPass1!secure', 10);
    const id = _uniq();
    return prisma.user.create({
        data: {
            username: `usr_${id}`,
            email: `usr_${id}@test.com`,
            password: hash,
            availableBalance: 0.0,
            escrowLockedBalance: 0.0,
            disputeEscrowBalance: 0.0,
            azamanId: `AZM-${id}`,
        },
    });
}

async function seedBusiness(userId) {
    const id = _uniq();
    return prisma.businessProfile.create({
        data: {
            userId,
            bizId: `BIZ-${id}`,
            businessName: `BizDel ${id}`,
            category: 'FOOD_BEVERAGE',
            isVerified: true,
            kybStatus: 'VERIFIED',
        },
    });
}

async function seedAdPost(businessProfileId) {
    const id = _uniq();
    return prisma.businessAdPost.create({
        data: {
            businessProfileId,
            templateType: 'BANNER',
            title: `Ad ${id}`,
            bodyText: 'Test body',
            expiresAt: new Date(Date.now() + 86400_000),
            status: 'ACTIVE',
        },
    });
}

// Minimal fake req/res helpers — mirrors the pattern in other test files
function fakeRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

function fakeReq(params = {}) {
    return {
        params,
        body: {},
        app: {
            get: (k) => {
                if (k === 'prisma') return prisma;
                if (k === 'socketio') return null;
                return undefined;
            },
        },
    };
}

// ─── global cleanup ──────────────────────────────────────────────────────────

afterAll(async () => {
    // Clean up any leftovers from failed tests
    await prisma.businessAdPost.deleteMany({ where: { title: { startsWith: 'Ad adTest_' } } });
    await prisma.businessProfile.deleteMany({ where: { businessName: { startsWith: 'BizDel ' } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: 'usr_adTest_' } } });
    await prisma.$disconnect();
});

// =============================================================================
// DELETE /api/admin/businesses/:bizId
// =============================================================================

describe('businessAdminCtrl.deleteBusiness', () => {
    test('404 for unknown bizId', async () => {
        const req = fakeReq({ bizId: 'BIZ-000000000' });
        const res = fakeRes();
        await businessAdminCtrl.deleteBusiness(req, res);
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: false })
        );
    });

    test('successfully hard-deletes a business with no open tickets', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user.id);

        const req = fakeReq({ bizId: biz.bizId });
        const res = fakeRes();
        await businessAdminCtrl.deleteBusiness(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: true })
        );

        // Confirm it's actually gone from the DB
        const gone = await prisma.businessProfile.findUnique({ where: { id: biz.id } });
        expect(gone).toBeNull();

        // User itself should still exist (only the profile was deleted)
        const userStill = await prisma.user.findUnique({ where: { id: user.id } });
        expect(userStill).not.toBeNull();

        await prisma.user.delete({ where: { id: user.id } });
    });

    test('cascade: deletes ad posts owned by the business', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user.id);
        const ad = await seedAdPost(biz.id);

        const req = fakeReq({ bizId: biz.bizId });
        const res = fakeRes();
        await businessAdminCtrl.deleteBusiness(req, res);

        expect(res.status).toHaveBeenCalledWith(200);

        // Ad post must be gone via Cascade
        const goneAd = await prisma.businessAdPost.findUnique({ where: { id: ad.id } });
        expect(goneAd).toBeNull();

        await prisma.user.delete({ where: { id: user.id } });
    });

    test('409 when business has an OPEN ticket — blocks deletion', async () => {
        const user = await seedUser();
        const counterUser = await seedUser();
        const biz = await seedBusiness(user.id);

        // Ticket requires creatorId + counterpartyId + name + type + targetAmount + targetCurrency
        const ticket = await prisma.ticket.create({
            data: {
                creatorId: user.id,
                counterpartyId: counterUser.id,
                businessProfileId: biz.id,
                name: 'Pending service',
                type: 'ESCROW',
                targetAmount: 10.0,
                targetCurrency: 'USDC',
                status: 'OPEN',
                lastActivityAt: new Date(),
            },
        });

        const req = fakeReq({ bizId: biz.bizId });
        const res = fakeRes();
        await businessAdminCtrl.deleteBusiness(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                success: false,
                message: expect.stringContaining('active ticket'),
            })
        );

        // Business must still exist
        const still = await prisma.businessProfile.findUnique({ where: { id: biz.id } });
        expect(still).not.toBeNull();

        // Cleanup (order matters — ticket before profile before users)
        await prisma.ticket.delete({ where: { id: ticket.id } });
        await prisma.businessProfile.delete({ where: { id: biz.id } });
        await prisma.user.deleteMany({ where: { id: { in: [user.id, counterUser.id] } } });
    });

    test('cannot delete same business twice — second call returns 404', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user.id);
        const bizId = biz.bizId;

        const res1 = fakeRes();
        await businessAdminCtrl.deleteBusiness(fakeReq({ bizId }), res1);
        expect(res1.status).toHaveBeenCalledWith(200);

        const res2 = fakeRes();
        await businessAdminCtrl.deleteBusiness(fakeReq({ bizId }), res2);
        expect(res2.status).toHaveBeenCalledWith(404);

        await prisma.user.delete({ where: { id: user.id } });
    });
});

// =============================================================================
// DELETE /api/admin/ad-posts/:id
// =============================================================================

describe('businessAdminCtrl.deleteAdPost', () => {
    test('404 for non-existent ad post UUID', async () => {
        const req = fakeReq({ id: '00000000-0000-0000-0000-000000000000' });
        const res = fakeRes();
        await businessAdminCtrl.deleteAdPost(req, res);
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: false })
        );
    });

    test('admin can delete any ad post regardless of ownership', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user.id);
        const ad = await seedAdPost(biz.id);

        const req = fakeReq({ id: ad.id });
        const res = fakeRes();
        await businessAdminCtrl.deleteAdPost(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: true })
        );

        const gone = await prisma.businessAdPost.findUnique({ where: { id: ad.id } });
        expect(gone).toBeNull();

        // Business itself should survive (only the ad was removed)
        const bizStill = await prisma.businessProfile.findUnique({ where: { id: biz.id } });
        expect(bizStill).not.toBeNull();

        await prisma.businessProfile.delete({ where: { id: biz.id } });
        await prisma.user.delete({ where: { id: user.id } });
    });

    test('deleting the same ad post twice returns 404 on the second call', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user.id);
        const ad = await seedAdPost(biz.id);

        const res1 = fakeRes();
        await businessAdminCtrl.deleteAdPost(fakeReq({ id: ad.id }), res1);
        expect(res1.status).toHaveBeenCalledWith(200);

        const res2 = fakeRes();
        await businessAdminCtrl.deleteAdPost(fakeReq({ id: ad.id }), res2);
        expect(res2.status).toHaveBeenCalledWith(404);

        await prisma.businessProfile.delete({ where: { id: biz.id } });
        await prisma.user.delete({ where: { id: user.id } });
    });
});
