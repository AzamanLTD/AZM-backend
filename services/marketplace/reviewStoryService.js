Operations
promoteReviewToStory — Creates a Story from a BusinessReview with businessProfileId set (the viral loop key). Uses review photos, business logo, or a default image. Caption includes star rating + business name + review comment.
getBusinessStories — Returns active (non-expired) stories for a business, used in the viral loop display.
Source Code
services/reviewStoryService.js
// services/reviewStoryService.js
// =============================================================================
// AZAMAN — REVIEW → STORY PROMOTION SERVICE (2026-07-02)
//
// When a customer leaves a positive review, this service optionally creates
// a Story with businessProfileId set, enabling the viral loop:
//   review → story → tap → business profile → new customer
//
// BusinessReview.photoUrls (added in this migration) provides the media for
// the story. If no photos, uses the business logo or a default marketplace image.
// =============================================================================

const STORY_DURATION_HOURS = 24;

// =============================================================================
// promoteReviewToStory — creates a Story from a BusinessReview.
// =============================================================================
const promoteReviewToStory = async (prisma, { reviewId, userId }) => {
    if (!reviewId) throw new Error('reviewId is required.');
    if (!userId) throw new Error('userId is required.');

    const review = await prisma.businessReview.findUnique({
        where: { id: reviewId },
        include: {
            businessProfile: { select: { id: true, businessName: true, logoUrl: true } },
            reviewer: { select: { id: true, username: true } },
        }
    });
    if (!review) throw new Error('Review not found.');
    if (review.reviewerId !== userId) throw new Error('Only the reviewer can share their review as a story.');

    // Build caption from review
    const stars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
    const captionParts = [
        `${stars} ${review.businessProfile.businessName}`,
        review.comment || '',
    ].filter(Boolean);
    const caption = captionParts.join('\n');

    // Determine media URL: prefer review photos, then business logo, then default
    let mediaUrl;
    let photos = review.photoUrls;
    if (typeof photos === 'string') {
        try { photos = JSON.parse(photos); } catch { photos = null; }
    }
    if (photos && Array.isArray(photos) && photos.length > 0) {
        mediaUrl = photos[0];
    } else if (review.businessProfile.logoUrl) {
        mediaUrl = review.businessProfile.logoUrl;
    } else {
        // Use a placeholder marketplace image
        mediaUrl = 'https://res.cloudinary.com/azaman/image/upload/v1/marketplace/review-default.png';
    }

    // Create the story with businessProfileId (the viral loop key)
    const story = await prisma.story.create({
        data: {
            userId,
            businessProfileId: review.businessProfile.id,
            mediaUrl,
            caption,
            expiresAt: new Date(Date.now() + STORY_DURATION_HOURS * 60 * 60 * 1000),
        }
    });

    return { success: true, story, review };
};

// =============================================================================
// getBusinessStories — get stories associated with a business (for the viral loop).
// =============================================================================
const getBusinessStories = async (prisma, { businessProfileId }) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');

    const stories = await prisma.story.findMany({
        where: {
            businessProfileId,
            expiresAt: { gt: new Date() }
        },
        orderBy: { createdAt: 'desc' },
        include: {
            user: { select: { id: true, username: true, profilePictureUrl: true } },
        }
    });

    return stories;
};

module.exports = { promoteReviewToStory, getBusinessStories, STORY_DURATION_HOURS };


