class StoryService {
    constructor(io, prisma, azmSpendService, uploadStorage) {
        this.io = io;
        this.prisma = prisma;
        this.azmSpendService = azmSpendService;
        this.uploadStorage = uploadStorage;
    }
 
    async create({ authorId, mediaUrl, mediaType, thumbnailUrl, caption, linkedBizId, durationSeconds }) {
        const story = await this.prisma.story.create({
            data: {
                userId: authorId, mediaUrl, 
                // Removed mediaType from schema, keeping it simple as we omitted it in Prisma
                caption: caption || null,
                businessProfileId: linkedBizId || null,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
            include: { user: { select: { id: true, username: true, profilePictureUrl: true } } },
        });
 
        // Real-time fanout: notify friends so their story rail updates live.
        const friendIds = await this._getFriendIds(authorId);
        for (const fid of friendIds) {
            this.io?.to(`user_${fid}`).emit('new_story', {
                storyId: story.id, authorId, createdAt: story.createdAt,
            });
        }
        return story;
    }
 
    async _getFriendIds(userId) {
        const friendships = await this.prisma.friendship.findMany({
            where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
            select: { requesterId: true, addresseeId: true },
        });
        return friendships.map(f => f.requesterId === userId ? f.addresseeId : f.requesterId);
    }
 
    // Fetch active (non-expired) stories from friends, grouped by author,
    // sorted with Telegram's proven tiered-priority approach:
    //   1. has an UNSEEN story        (always floats to top)
    //   2. is BOOSTED (azm spent > 0) (paid visibility, but only within the
    //                                   unseen/seen tier it already belongs to)
    //   3. most recent story first
    async getFeed(viewerId) {
        const friendIds = await this._getFriendIds(viewerId);
        friendIds.push(viewerId); // include own stories at index 0 downstream
 
        const stories = await this.prisma.story.findMany({
            where: {
                OR: [
                    { userId: { in: friendIds }, expiresAt: { gt: new Date() } },
                    {
                        businessProfileId: { not: null },
                        expiresAt: { gt: new Date() },
                        businessProfile: {
                            followers: { some: { userId: viewerId } }
                        }
                    }
                ],
            },
            orderBy: { createdAt: 'desc' },
            include: {
                user: { select: { id: true, username: true, profilePictureUrl: true } },
                views: { where: { viewerId }, select: { id: true } },
            },
        });
 
        const byAuthor = new Map();
        for (const s of stories) {
            if (!byAuthor.has(s.userId)) byAuthor.set(s.userId, []);
            byAuthor.get(s.userId).push(s);
        }
 
        const groups = [...byAuthor.entries()].map(([authorId, items]) => ({
            authorId,
            author: items[0].user,
            hasUnseen: items.some(i => i.views.length === 0),
            isBoosted: items.some(i => i.boostAzmSpent > 0),
            latestAt: items[0].createdAt,
            stories: items.map(i => ({
                id: i.id, mediaUrl: i.mediaUrl, caption: i.caption,
                linkedBizId: i.businessProfileId,
                boosted: i.boostAzmSpent > 0, seen: i.views.length > 0, createdAt: i.createdAt,
            })),
        }));
 
        // Tiered comparator -- same shape as Telegram's peerStoriesComparator.
        groups.sort((a, b) => {
            if (a.authorId === viewerId) return -1; // your own story ring always first
            if (b.authorId === viewerId) return 1;
            if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
            if (a.isBoosted !== b.isBoosted) return a.isBoosted ? -1 : 1;
            return new Date(b.latestAt) - new Date(a.latestAt);
        });
 
        return groups;
    }
 
    async markViewed(storyId, viewerId) {
        await this.prisma.storyView.upsert({
            where: { storyId_viewerId: { storyId: parseInt(storyId), viewerId } },
            update: {},
            create: { storyId: parseInt(storyId), viewerId },
        });
        const story = await this.prisma.story.findUnique({ where: { id: parseInt(storyId) }, select: { userId: true } });
        if (story) this.io?.to(`user_${story.userId}`).emit('story_viewed', { storyId, viewerId });
    }
 
    // Boost re-uses the EXISTING AZM ledger -- never invent a second balance.
    async boost(storyId, userId, amount) {
        const story = await this.prisma.story.findUnique({ where: { id: parseInt(storyId) } });
        if (!story) throw new Error('Story not found');
        if (story.userId !== userId) throw new Error('Only the author can boost their own story');
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid boost amount');
 
        await this.azmSpendService.debit({
            userId, amount, reason: 'STORY_BOOST', refId: storyId,
        });
        return this.prisma.story.update({
            where: { id: parseInt(storyId) },
            data: { boostAzmSpent: { increment: amount } },
        });
    }
 
    async remove(storyId, userId) {
        const story = await this.prisma.story.findUnique({ where: { id: parseInt(storyId) } });
        if (!story || story.userId !== userId) throw new Error('Not authorized');
        return this.prisma.story.delete({ where: { id: parseInt(storyId) } });
    }
 
    // Cron target -- run every 15 min: DELETE FROM "Story" WHERE "expiresAt" < now()
    async expireOldStories() {
        return this.prisma.story.deleteMany({
            where: { expiresAt: { lt: new Date() } }
        });
    }
}
 
module.exports = StoryService;
