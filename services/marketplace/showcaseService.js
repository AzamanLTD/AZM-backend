// services/marketplace/showcaseService.js
// =============================================================================
// AZAMAN — BUSINESS SHOWCASE SERVICE (2026-07-03)
// Hotel showcase media management — full-bleed slideshow on hotel profile.
// Businesses upload ambiance/room/amenity photos that display at the top
// of their profile page.
// =============================================================================

class ShowcaseService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    /**
     * Add a showcase media item.
     */
    async addMedia({ businessProfileId, mediaUrl, mediaType, caption, displayOrder }) {
        if (!businessProfileId) throw new Error('businessProfileId is required.');
        if (!mediaUrl) throw new Error('mediaUrl is required.');

        const business = await this.prisma.businessProfile.findUnique({
            where: { id: businessProfileId },
            select: { id: true, category: true },
        });
        if (!business) throw new Error('Business not found.');

        return this.prisma.businessShowcase.create({
            data: {
                businessProfileId,
                mediaUrl,
                mediaType: mediaType || 'IMAGE',
                caption: caption || null,
                displayOrder: displayOrder ?? 0,
                isActive: true,
            },
        });
    }

    /**
     * Get all active showcase media for a business, ordered by displayOrder.
     */
    async getShowcase(businessProfileId) {
        return this.prisma.businessShowcase.findMany({
            where: { businessProfileId, isActive: true },
            orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
        });
    }

    /**
     * Update a showcase item (reorder, change caption, etc.)
     */
    async updateMedia(mediaId, { caption, displayOrder, isActive }) {
        const data = {};
        if (caption !== undefined) data.caption = caption;
        if (displayOrder !== undefined) data.displayOrder = displayOrder;
        if (isActive !== undefined) data.isActive = isActive;

        return this.prisma.businessShowcase.update({
            where: { id: mediaId },
            data,
        });
    }

    /**
     * Remove a showcase item (soft delete via isActive=false).
     */
    async removeMedia(mediaId) {
        return this.prisma.businessShowcase.update({
            where: { id: mediaId },
            data: { isActive: false },
        });
    }

    /**
     * Reorder showcase media (batch update displayOrder).
     * @param {Array<{id: string, displayOrder: number}>} items
     */
    async reorderMedia(items) {
        const updates = items.map(item =>
            this.prisma.businessShowcase.update({
                where: { id: item.id },
                data: { displayOrder: item.displayOrder },
            })
        );
        await this.prisma.$transaction(updates);
        return { success: true };
    }
}

module.exports = ShowcaseService;
