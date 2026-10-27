// services/marketplace/recommendationFeedbackService.js
// =============================================================================
// AZAMAN — RECOMMENDATION FEEDBACK ("Show less like this") (Backend D)
//
// A per-user business suppression signal for discovery ranking. Semantics:
//   - Scoped to (authenticated user, canonical business profile).
//   - Idempotent: the DB unique pair prevents duplicate rows; repeated
//     applies are honest repeats.
//   - Effect: DEMOTES the business to the end of the caller's personalised
//     ranking (see demoteSuppressed + searchBusinesses viewerId path). It
//     never deletes or archives the business globally, never removes a
//     follow, bookmark or review, and never overrides hard eligibility,
//     availability or safety rules (suspension/pause filters still run
//     first in search).
//   - Undo: DELETE of the row reliably restores the prior ranking — the
//     row was the ONLY personalisation signal for that pair.
//   - Private: never exposed publicly; other users' feedback is never
//     readable.
// =============================================================================

class RecommendationFeedbackService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    async #resolveBusiness(businessProfileId) {
        if (!businessProfileId || typeof businessProfileId !== 'string') {
            const err = new Error('A businessProfileId is required.');
            err.status = 400; err.code = 'VALIDATION_ERROR';
            throw err;
        }
        const business = await this.prisma.businessProfile.findUnique({
            where: { id: businessProfileId },
            select: { id: true, userId: true },
        });
        if (!business) {
            const err = new Error('Business not found.');
            err.status = 404; err.code = 'BUSINESS_NOT_FOUND';
            throw err;
        }
        return business;
    }

    // Apply "Show less like this". Idempotent by the DB unique pair.
    async applyShowLess(userId, businessProfileId) {
        await this.#resolveBusiness(businessProfileId);
        const existing = await this.prisma.businessRecommendationFeedback.findUnique({
            where: { userId_businessProfileId: { userId, businessProfileId } },
        });
        if (existing) {
            return { alreadyApplied: true, appliedAt: existing.createdAt };
        }
        try {
            const created = await this.prisma.businessRecommendationFeedback.create({
                data: { userId, businessProfileId, feedbackType: 'SHOW_LESS' },
            });
            return { alreadyApplied: false, appliedAt: created.createdAt };
        } catch (err) {
            // CONCURRENT FIRST-APPLY CONVERGENCE: the read-then-create above
            // races when two simultaneous first applies both see "absent" —
            // the loser would otherwise surface a P2002 500 and turn an
            // idempotent action into a failure. The unique pair is the
            // convergence point: on conflict, the loser re-reads the
            // winner's committed row and reports the SAME idempotent result
            // as a sequential duplicate apply. Exactly one row ever exists.
            if (err && err.code === 'P2002') {
                const converged = await this.prisma.businessRecommendationFeedback.findUnique({
                    where: { userId_businessProfileId: { userId, businessProfileId } },
                });
                return { alreadyApplied: true, appliedAt: converged?.createdAt ?? null };
            }
            throw err;
        }
    }

    // Undo — removes the suppression row. Idempotent no-op when absent.
    async undoShowLess(userId, businessProfileId) {
        await this.#resolveBusiness(businessProfileId);
        const removed = await this.prisma.businessRecommendationFeedback.deleteMany({
            where: { userId, businessProfileId },
        });
        return { removed: removed.count > 0 };
    }

    async isSuppressed(userId, businessProfileId) {
        if (!businessProfileId || typeof businessProfileId !== 'string') return false;
        const row = await this.prisma.businessRecommendationFeedback.findUnique({
            where: { userId_businessProfileId: { userId, businessProfileId } },
            select: { id: true },
        });
        return !!row;
    }

    // The caller's own suppressed set (ids only, for UI badges).
    async listSuppressed(userId, { limit, offset } = {}) {
        const take = Math.min(Number(limit) || 50, 100);
        const skip = Number(offset) || 0;
        const where = { userId };
        const [rows, total] = await this.prisma.$transaction([
            this.prisma.businessRecommendationFeedback.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take,
                skip,
            }),
            this.prisma.businessRecommendationFeedback.count({ where }),
        ]);
        return {
            total,
            suppressed: rows.map(r => ({
                businessProfileId: r.businessProfileId,
                feedbackType: r.feedbackType,
                appliedAt: r.createdAt,
            })),
        };
    }

    // One batched fetch of the caller's suppressed ids among a page of
    // businesses — the input to the ranking demotion below (N+1-free).
    async getSuppressedIds(userId, businessIds) {
        if (!businessIds || businessIds.length === 0) return new Set();
        const rows = await this.prisma.businessRecommendationFeedback.findMany({
            where: { userId, businessProfileId: { in: businessIds } },
            select: { businessProfileId: true },
        });
        return new Set(rows.map(r => r.businessProfileId));
    }

    // RANKING EFFECT: demote suppressed businesses to the END of the page,
    // preserving the existing order among both kept and demoted groups.
    // Pure ordering: nothing is removed, hidden or altered on the business.
    demoteSuppressed(rows, suppressedIds) {
        if (!suppressedIds || suppressedIds.size === 0 || !Array.isArray(rows)) return rows;
        const kept = [], demoted = [];
        for (const r of rows) {
            (suppressedIds.has(r.id) ? demoted : kept).push(r);
        }
        return kept.concat(demoted);
    }
}

module.exports = RecommendationFeedbackService;
