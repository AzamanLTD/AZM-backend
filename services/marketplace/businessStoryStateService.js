// services/marketplace/businessStoryStateService.js
// =============================================================================
// AZAMAN — BUSINESS STORY STATE (marketplace personalisation, Backend B)
//
// The authoritative active/unseen story signal for BUSINESS LISTING cards,
// so the frontend can draw a story ring from real state instead of inferring
// story availability from a logo/description/review/follow.
//
// SINGLE STORY AUTHORITY: the Story/StoryView models and the existing
// storyService.getFeed semantics. This service only READS them and attaches
// a compact, additive `storyState` block to business DTO rows.
//
// CONTRACT of the attached block (per business row):
//   storyState: {
//     hasActiveStory: boolean,        // any Story for this business with expiresAt > now
//     hasUnseenStory: boolean | null, // null when the viewer is anonymous;
//                                     // true iff an ACTIVE story has no
//                                     // StoryView row for this viewer
//     latestStoryAt: string | null     // ISO-8601 createdAt of the newest
//                                     // ACTIVE story — the ring-ordering
//                                     // timestamp
//   }
//
// PRIVACY: only booleans and a timestamp leave the server — never story
// contents, media URLs, viewer lists, viewer identities or any private
// metadata. The unseen signal is computed from the existing StoryView model
// so the existing view privacy semantics (StoryView rows only exist when
// the viewer actually viewed) apply unchanged.
//
// N+1-FREE: exactly TWO queries per page regardless of page size — one
// grouped fetch of active stories for all businesses on the page, and one
// (only for authenticated viewers) fetch of the viewer's StoryView rows for
// those stories.
// =============================================================================

async function attachStoryState(prisma, businessRows, viewerId) {
    if (!Array.isArray(businessRows) || businessRows.length === 0) return businessRows;
    const bizIds = businessRows.map(r => (typeof r === 'string' ? r : r.id)).filter(Boolean);

    // Query 1: all ACTIVE stories on this page, newest per business.
    const now = new Date();
    const activeStories = await prisma.story.findMany({
        where: { businessProfileId: { in: bizIds }, expiresAt: { gt: now } },
        select: { id: true, businessProfileId: true, createdAt: true },
    });

    const stateByBiz = new Map();
    const allActiveIds = [];
    for (const s of activeStories) {
        allActiveIds.push(s.id);
        let st = stateByBiz.get(s.businessProfileId);
        if (!st) {
            st = { hasActiveStory: true, hasUnseenStory: viewerId == null ? null : false, latestStoryAt: s.createdAt, activeIds: [] };
            stateByBiz.set(s.businessProfileId, st);
        }
        if (s.createdAt > st.latestStoryAt) st.latestStoryAt = s.createdAt;
        st.activeIds.push(s.id);
    }

    // Query 2 (authenticated only): the viewer's views among those stories.
    const seenSet = new Set();
    if (viewerId != null && allActiveIds.length > 0) {
        const views = await prisma.storyView.findMany({
            where: { storyId: { in: allActiveIds }, viewerId },
            select: { storyId: true },
        });
        for (const v of views) seenSet.add(v.storyId);
    }
    if (viewerId != null) {
        for (const st of stateByBiz.values()) {
            st.hasUnseenStory = st.activeIds.some(id => !seenSet.has(id));
        }
    }

    for (const row of businessRows) {
        const id = typeof row === 'string' ? row : row.id;
        const st = stateByBiz.get(id);
        row.storyState = st ? {
            hasActiveStory: true,
            hasUnseenStory: st.hasUnseenStory,
            latestStoryAt: st.latestStoryAt.toISOString(),
        } : {
            hasActiveStory: false,
            hasUnseenStory: viewerId == null ? null : false,
            latestStoryAt: null,
        };
    }
    return businessRows;
}

module.exports = { attachStoryState };
