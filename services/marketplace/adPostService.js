// services/marketplace/adPostService.js
// =============================================================================
// AZAMAN — BUSINESS AD POST SERVICE (2026-07-03)
// Structured ad posts (not free-text). Businesses create promotions that
// appear in their followers' story feeds. Each post has a type, CTA, and
// optional media. Posts expire after 24h (like stories).
//
// WRITE PATH: createAdPost() → creates BusinessAdPost + Story (linked to
//   businessProfileId) so the story feed read path picks it up.
// READ PATH: storyService.getFeed() now includes stories from followed
//   businesses (see Section 51 of the implementation guide).
// =============================================================================

const STORY_DURATION_HOURS = 24;

class AdPostService {
    constructor(prisma, io, storyService) {
        this.prisma = prisma;
        this.io = io;
        this.storyService = storyService;
    }

    /**
     * Create a structured ad post. Also creates a Story linked to the
     * business so it appears in followers' feeds.
     */
    async createAdPost({ businessProfileId, type, title, body, mediaUrl, ctaLabel, ctaTarget }) {
        if (!businessProfileId) throw new Error('businessProfileId is required.');
        if (!title) throw new Error('title is required.');
        if (!body) throw new Error('body is required.');

        const business = await this.prisma.businessProfile.findUnique({
            where: { id: businessProfileId },
            select: { userId: true, businessName: true, logoUrl: true, isSuspended: true },
        });
        if (!business) throw new Error('Business not found.');
        if (business.isSuspended) throw new Error('Cannot post ads while suspended.');

        const expiresAt = new Date(Date.now() + STORY_DURATION_HOURS * 60 * 60 * 1000);

        // Create the structured ad post
        const adPost = await this.prisma.businessAdPost.create({
            data: {
                businessProfileId,
                templateType: type || 'GENERAL',
                title,
                bodyText: body,
                mediaUrl: mediaUrl || business.logoUrl || null,
                ctaLabel: ctaLabel || null,
                ctaTarget: ctaTarget || null,
                expiresAt,
            },
        });

        // Also create a Story linked to the business profile so the
        // existing story feed read path (now updated to include business
        // stories from followed businesses) picks it up.
        if (true) {
            await this.prisma.story.create({
                data: {
                    userId: business.userId,
                    mediaUrl: mediaUrl || business.logoUrl || 'https://placehold.co/400x600?text=' + encodeURIComponent(title),
                    caption: `${title} — ${body}${ctaLabel ? ' | ' + ctaLabel : ''}`,
                    businessProfileId,
                    expiresAt,
                },
            });
        }

        // Notify all followers in real-time
        const followers = await this.prisma.businessFollower.findMany({
            where: { businessProfileId },
            select: { customerId: true },
        });
        for (const f of followers) {
            this.io?.to(`user_${f.customerId}`).emit('new_business_ad', {
                adPostId: adPost.id,
                businessProfileId,
                title,
                type: adPost.type,
            });
        }

        return adPost;
    }

    /**
     * Get active (non-expired) ad posts for a business.
     */
    async getActiveAdPosts(businessProfileId) {
        return this.prisma.businessAdPost.findMany({
            where: {
                businessProfileId,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Get ad posts for a user's feed (from followed businesses).
     */
    async getFeedAdPosts(userId, followedBusinessIds) {
        if (!followedBusinessIds || followedBusinessIds.length === 0) return [];
        return this.prisma.businessAdPost.findMany({
            where: {
                businessProfileId: { in: followedBusinessIds },
                expiresAt: { gt: new Date() },
            },
            include: {
                businessProfile: {
                    select: { id: true, businessName: true, logoUrl: true },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Delete an ad post (business owner only).
     */
    async deleteAdPost(adPostId, businessProfileId) {
        const post = await this.prisma.businessAdPost.findUnique({
            where: { id: adPostId },
        });
        if (!post) throw new Error('Ad post not found.');
        if (post.businessProfileId !== businessProfileId) {
            throw new Error('Not authorized to delete this ad post.');
        }
        await this.prisma.businessAdPost.delete({ where: { id: adPostId } });
        return { success: true };
    }
}

module.exports = AdPostService;
