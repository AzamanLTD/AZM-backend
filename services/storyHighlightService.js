// services/storyHighlightService.js
// Story Highlights — permanent collections of stories on a user's profile.
// Like Instagram highlights: pick expired/active stories, group them, show on profile.

'use strict';

const createHighlight = async (prisma, { userId, title, coverUrl, storyIds }) => {
  if (!title?.trim()) throw new Error('Title is required');
  if (title.length > 50) throw new Error('Title must be 50 characters or less');

  return prisma.$transaction(async (tx) => {
    const highlight = await tx.storyHighlight.create({
      data: {
        userId,
        title: title.trim(),
        coverUrl: coverUrl || null,
        items: storyIds?.length ? {
          create: await Promise.all(storyIds.map(async (sid) => {
            const story = await tx.story.findUnique({ where: { id: sid }, select: { mediaUrl: true, mediaType: true, caption: true } });
            return {
              storyId: sid,
              mediaUrl: story?.mediaUrl || '',
              mediaType: story?.mediaType || 'IMAGE',
              caption: story?.caption || null,
            };
          })),
        } : undefined,
      },
      include: { items: true },
    });
    return highlight;
  });
};

const listHighlights = async (prisma, { userId }) => {
  return prisma.storyHighlight.findMany({
    where: { userId },
    include: { items: { orderBy: { addedAt: 'asc' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
  });
};

const getHighlight = async (prisma, { highlightId, requesterId }) => {
  const hl = await prisma.storyHighlight.findUnique({
    where: { id: highlightId },
    include: { items: { orderBy: { addedAt: 'asc' } } },
  });
  if (!hl) throw new Error('Highlight not found');
  return hl;
};

const deleteHighlight = async (prisma, { highlightId, userId }) => {
  const hl = await prisma.storyHighlight.findUnique({ where: { id: highlightId } });
  if (!hl || hl.userId !== userId) throw new Error('Highlight not found');
  return prisma.storyHighlight.delete({ where: { id: highlightId } });
};

const addItemToHighlight = async (prisma, { highlightId, userId, storyId }) => {
  const hl = await prisma.storyHighlight.findUnique({ where: { id: highlightId } });
  if (!hl || hl.userId !== userId) throw new Error('Highlight not found');

  const story = await prisma.story.findUnique({ where: { id: storyId }, select: { mediaUrl: true, mediaType: true, caption: true } });
  if (!story) throw new Error('Story not found');

  return prisma.storyHighlightItem.create({
    data: { highlightId, storyId, mediaUrl: story.mediaUrl, mediaType: story.mediaType, caption: story.caption },
  });
};

const removeItemFromHighlight = async (prisma, { highlightId, itemId, userId }) => {
  const hl = await prisma.storyHighlight.findUnique({ where: { id: highlightId } });
  if (!hl || hl.userId !== userId) throw new Error('Highlight not found');
  return prisma.storyHighlightItem.delete({ where: { id: itemId } });
};

// ── Close Friends ──────────────────────────────────────────────────────────────

const listCloseFriends = async (prisma, { userId }) => {
  const entries = await prisma.storyCloseFriend.findMany({
    where: { userId },
    include: { friend: { select: { id: true, username: true, profilePictureUrl: true } } },
    orderBy: { addedAt: 'desc' },
  });
  return entries.map(e => e.friend);
};

const addCloseFriend = async (prisma, { userId, friendId }) => {
  if (userId === friendId) throw new Error('Cannot add yourself as a close friend');
  const existing = await prisma.storyCloseFriend.findUnique({
    where: { userId_friendId: { userId, friendId } },
  });
  if (existing) throw new Error('Already in close friends list');
  return prisma.storyCloseFriend.create({ data: { userId, friendId } });
};

const removeCloseFriend = async (prisma, { userId, friendId }) => {
  return prisma.storyCloseFriend.deleteMany({ where: { userId, friendId } });
};

// ── Story Analytics ────────────────────────────────────────────────────────────

const getStoryAnalytics = async (prisma, { storyId, userId }) => {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { id: true, userId: true, businessProfileId: true, createdAt: true, expiresAt: true },
  });
  if (!story) throw new Error('Story not found');

  if (story.userId !== userId && !story.businessProfileId) {
    throw new Error('Not authorized to view analytics');
  }

  let analytics = await prisma.storyAnalytics.findUnique({ where: { storyId } });
  if (!analytics) {
    const [viewCount, uniqueViewers, reactions, replies] = await Promise.all([
      prisma.storyView.count({ where: { storyId } }),
      prisma.storyView.findMany({ where: { storyId }, select: { viewerId: true }, distinct: ['viewerId'] }),
      prisma.storyReaction.count({ where: { storyId } }),
      prisma.directMessage.count({ where: { storyRefId: storyId } }),
    ]);

    analytics = await prisma.storyAnalytics.upsert({
      where: { storyId },
      create: {
        storyId,
        businessProfileId: story.businessProfileId,
        viewCount,
        uniqueViewerCount: uniqueViewers.length,
        reactionCount: reactions,
        replyCount: replies,
      },
      update: {
        viewCount,
        uniqueViewerCount: uniqueViewers.length,
        reactionCount: reactions,
        replyCount: replies,
      },
    });
  }

  const viewers = await prisma.storyView.findMany({
    where: { storyId },
    include: { viewer: { select: { id: true, username: true, profilePictureUrl: true } } },
    orderBy: { viewedAt: 'desc' },
    take: 50,
  });

  return { ...analytics, viewers: viewers.map(v => ({ id: v.viewer.id, username: v.viewer.username, avatar: v.viewer.profilePictureUrl, viewedAt: v.viewedAt })) };
};

const getBusinessStoryAnalytics = async (prisma, { businessProfileId, userId, dateFrom, dateTo }) => {
  const biz = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { ownerId: true } });
  if (!biz || biz.ownerId !== userId) throw new Error('Not authorized');

  const where = {
    businessProfileId,
    ...(dateFrom || dateTo ? {
      story: {
        createdAt: {
          ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
          ...(dateTo ? { lte: new Date(dateTo) } : {}),
        },
      },
    } : {}),
  };

  const analytics = await prisma.storyAnalytics.findMany({
    where,
    include: { story: { select: { id: true, mediaUrl: true, caption: true, createdAt: true, expiresAt: true } } },
    orderBy: { story: { createdAt: 'desc' } },
    take: 100,
  });

  const totals = analytics.reduce((acc, a) => ({
    totalViews: acc.totalViews + a.viewCount,
    totalUniqueViewers: acc.totalUniqueViewers + a.uniqueViewerCount,
    totalReactions: acc.totalReactions + a.reactionCount,
    totalReplies: acc.totalReplies + a.replyCount,
    totalShares: acc.totalShares + a.shareCount,
    totalProfileClicks: acc.totalProfileClicks + a.profileClickCount,
  }), { totalViews: 0, totalUniqueViewers: 0, totalReactions: 0, totalReplies: 0, totalShares: 0, totalProfileClicks: 0 });

  return { stories: analytics, totals };
};

module.exports = {
  createHighlight, listHighlights, getHighlight, deleteHighlight,
  addItemToHighlight, removeItemFromHighlight,
  listCloseFriends, addCloseFriend, removeCloseFriend,
  getStoryAnalytics, getBusinessStoryAnalytics,
};
