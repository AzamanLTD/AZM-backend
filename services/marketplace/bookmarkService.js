// services/marketplace/bookmarkService.js
// =============================================================================
// AZAMAN — BUSINESS BOOKMARK SERVICE (marketplace personalisation, Backend A)
//
// A user-scoped "saved business" collection. DISTINCT from BusinessFollower
// by design: following drives the story/ad feed and is a public relationship;
// bookmarking is a private, personal collection with no feed semantics.
// Ownership is absolute: every method receives the authenticated user's id
// from the route layer (protect middleware) and scopes every read/write to
// that caller — there is no path by which one user can list, add or remove
// another user's bookmark.
//
// The database enforces idempotency: @@unique(businessProfileId, customerId)
// means repeated saves cannot create duplicate relationships, and removes
// of absent rows are honest no-ops.
// =============================================================================

class BookmarkService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // Resolve and validate the business identity. Bookmarks reference the
    // canonical BusinessProfile.id — never a product, location row or
    // display name — and are refused for unknown or self-owned profiles,
    // mirroring the follow contract.
    async #resolveBusiness(businessProfileId) {
        if (!businessProfileId || typeof businessProfileId !== 'string') {
            const err = new Error('A businessProfileId is required.');
            err.status = 400; err.code = 'VALIDATION_ERROR';
            throw err;
        }
        const business = await this.prisma.businessProfile.findUnique({
            where: { id: businessProfileId },
            select: { id: true, userId: true, isSuspended: true },
        });
        if (!business) {
            const err = new Error('Business not found.');
            err.status = 404; err.code = 'BUSINESS_NOT_FOUND';
            throw err;
        }
        return business;
    }

    async bookmark(userId, businessProfileId) {
        const business = await this.#resolveBusiness(businessProfileId);
        if (business.userId === userId) {
            const err = new Error('Cannot bookmark your own business.');
            err.status = 400; err.code = 'OWN_BUSINESS';
            throw err;
        }

        const existing = await this.prisma.businessBookmark.findUnique({
            where: {
                businessProfileId_customerId: {
                    businessProfileId,
                    customerId: userId,
                },
            },
        });
        if (existing) {
            // Idempotent repeat: the relationship already exists, so no new
            // row is created and the response says so explicitly.
            return {
                alreadyBookmarked: true,
                bookmark: { businessProfileId, savedAt: existing.createdAt },
            };
        }

        const created = await this.prisma.businessBookmark.create({
            data: { customerId: userId, businessProfileId },
        });
        return {
            alreadyBookmarked: false,
            bookmark: { businessProfileId, savedAt: created.createdAt },
        };
    }

    async unbookmark(userId, businessProfileId) {
        // Validates the business identity first so an unknown/invalid ID is
        // distinguishable from a successful (or no-op) removal.
        await this.#resolveBusiness(businessProfileId);
        const removed = await this.prisma.businessBookmark.deleteMany({
            where: { customerId: userId, businessProfileId },
        });
        return { removed: removed.count > 0 };
    }

    async isBookmarked(userId, businessProfileId) {
        if (!businessProfileId || typeof businessProfileId !== 'string') return false;
        const record = await this.prisma.businessBookmark.findUnique({
            where: {
                businessProfileId_customerId: {
                    businessProfileId,
                    customerId: userId,
                },
            },
            select: { id: true },
        });
        return !!record;
    }

    // List the CALLER's saved businesses only, newest first, with real
    // pagination. Returns the canonical business profile fields the
    // marketplace cards already render plus the savedAt timestamp.
    async getBookmarks(userId, { limit, offset } = {}) {
        const take = Math.min(Number(limit) || 50, 100);
        const skip = Number(offset) || 0;
        const where = { customerId: userId };
        const [rows, total] = await this.prisma.$transaction([
            this.prisma.businessBookmark.findMany({
                where,
                include: {
                    businessProfile: {
                        select: {
                            id: true, bizId: true, businessName: true,
                            logoUrl: true,
                            category: true, isVerified: true,
                            averageRating: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
                take,
                skip,
            }),
            this.prisma.businessBookmark.count({ where }),
        ]);
        return {
            total,
            bookmarks: rows.map(r => ({
                businessProfileId: r.businessProfile.id,
                // bizId: the PUBLIC deep-link identifier the app's business
                // profile route consumes. Both ids ship: businessProfileId
                // stays the canonical key for writes/checks/deletes; bizId
                // is additive read-side convenience for navigation only.
                bizId: r.businessProfile.bizId,
                businessName: r.businessProfile.businessName,
                logoUrl: r.businessProfile.logoUrl,
                category: r.businessProfile.category,
                isVerified: r.businessProfile.isVerified,
                averageRating: r.businessProfile.averageRating,
                savedAt: r.createdAt,
            })),
        };
    }
}

module.exports = BookmarkService;
