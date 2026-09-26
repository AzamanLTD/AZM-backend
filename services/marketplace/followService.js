// services/marketplace/followService.js
// =============================================================================
// AZAMAN — BUSINESS FOLLOW SERVICE (2026-07-03)
// Customers follow businesses to receive ad posts in their story feed.
// =============================================================================

class FollowService {
    constructor(prisma, io) {
        this.prisma = prisma;
        this.io = io;
    }

    async follow(userId, businessProfileId) {
        const business = await this.prisma.businessProfile.findUnique({
            where: { id: businessProfileId },
            select: { userId: true, businessName: true, isSuspended: true },
        });
        if (!business) throw new Error('Business not found.');
        if (business.userId === userId) throw new Error('Cannot follow your own business.');
        if (business.isSuspended) throw new Error('This business is suspended.');

        await this.prisma.businessFollower.upsert({
            where: { businessProfileId_customerId: { customerId: userId, businessProfileId } },
            update: {},
            create: { customerId: userId, businessProfileId },
        });

        this.io?.to(`user_${business.userId}`).emit('new_follower', {
            businessProfileId,
            customerId: userId,
        });
        return { success: true };
    }

    async unfollow(userId, businessProfileId) {
        await this.prisma.businessFollower.deleteMany({
            where: { customerId: userId, businessProfileId },
        });
        return { success: true };
    }

    async isFollowing(userId, businessProfileId) {
        const record = await this.prisma.businessFollower.findUnique({
            where: { businessProfileId_customerId: { customerId: userId, businessProfileId } },
        });
        return !!record;
    }

    // FIX (2026-07-06): the caller (businessFollowerService.getFollowing) has
    // always passed a single `{ userId, limit, offset }` object here, but this
    // method's signature only ever accepted a bare `userId` -- meaning the
    // whole options object was being used AS the userId, so
    // `where: { customerId: userId }` filtered on a stringified object and
    // matched nothing. GET /api/follows/following was silently broken for
    // every caller since this was written. Also added real pagination
    // (take/skip), which never existed despite limit/offset being accepted
    // and threaded through from the controller the whole time.
    async getFollowing(userId, { limit, offset } = {}) {
        const take = Math.min(Number(limit) || 50, 100);
        const skip = Number(offset) || 0;
        const follows = await this.prisma.businessFollower.findMany({
            where: { customerId: userId },
            include: {
                businessProfile: {
                    select: {
                        id: true, businessName: true, logoUrl: true,
                        category: true, isVerified: true, averageRating: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take,
            skip,
        });
        return follows.map(f => ({ ...f.businessProfile, followedAt: f.createdAt }));
    }

    async getFollowers(businessProfileId, { limit, offset } = {}) {
        const take = Math.min(Number(limit) || 50, 100);
        const skip = Number(offset) || 0;
        const follows = await this.prisma.businessFollower.findMany({
            where: { businessProfileId },
            include: {
                customer: {
                    select: { id: true, username: true, profilePictureUrl: true, azamanId: true },
                },
            },
            orderBy: { createdAt: 'desc' },
            take,
            skip,
        });
        return follows.map(f => ({ ...f.customer, followedAt: f.createdAt }));
    }

    async getFollowedBusinessIds(customerId) {
        const follows = await this.prisma.businessFollower.findMany({
            where: { customerId },
            select: { businessProfileId: true },
        });
        return follows.map(f => f.businessProfileId);
    }

    async getFollowerCount(businessProfileId) {
        return this.prisma.businessFollower.count({ where: { businessProfileId } });
    }
}

module.exports = FollowService;
