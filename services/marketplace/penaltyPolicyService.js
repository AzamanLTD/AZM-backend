// services/marketplace/penaltyPolicyService.js
// =============================================================================
// AZAMAN — PENALTY POLICY SERVICE (2026-07-03)
// Per-business penalty configuration. Caps at MAX_PENALTY_PCT (50%) to
// prevent abuse. Supports bidirectional penalties (customer no-show AND
// business no-show).
// =============================================================================

const MAX_PENALTY_PCT = 0.50; // hard cap — no business can set above this

class PenaltyPolicyService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    /**
     * Get or create a penalty policy for a business.
     * Defaults: 10% customer penalty, 10% business penalty, 30 min grace.
     */
    async getOrCreatePolicy(businessProfileId) {
        return this.prisma.penaltyPolicy.upsert({
            where: { businessProfileId },
            update: {},
            create: {
                businessProfileId,
                customerNoShowPct: 0.1,
                businessNoShowPct: 0.1,
                gracePeriodMins: 30,
            },
        });
    }

    /**
     * Update penalty policy. Enforces MAX_PENALTY_PCT cap.
     */
    async updatePolicy(businessProfileId, { customerPenaltyPct, businessPenaltyPct, gracePeriodMins }) {
        const data = {};
        if (customerPenaltyPct !== undefined) {
            const val = Number(customerPenaltyPct);
            if (!Number.isFinite(val) || val < 0) throw new Error('customerPenaltyPct must be non-negative.');
            if (val > MAX_PENALTY_PCT) throw new Error(`customerPenaltyPct cannot exceed ${MAX_PENALTY_PCT} (50%).`);
            data.customerNoShowPct = parseFloat(val.toFixed(4));
        }
        if (businessPenaltyPct !== undefined) {
            const val = Number(businessPenaltyPct);
            if (!Number.isFinite(val) || val < 0) throw new Error('businessPenaltyPct must be non-negative.');
            if (val > MAX_PENALTY_PCT) throw new Error(`businessPenaltyPct cannot exceed ${MAX_PENALTY_PCT} (50%).`);
            data.businessNoShowPct = parseFloat(val.toFixed(4));
        }
        if (gracePeriodMins !== undefined) {
            const val = Number(gracePeriodMins);
            if (!Number.isFinite(val) || val < 0 || val > 120) throw new Error('gracePeriodMins must be between 0 and 120.');
            data.gracePeriodMins = Math.round(val);
        }

        // Ensure the policy exists first
        await this.getOrCreatePolicy(businessProfileId);

        return this.prisma.penaltyPolicy.update({
            where: { businessProfileId },
            data,
        });
    }

    /**
     * Compute the penalty amount for a given escrow amount.
     * @param {string} businessProfileId
     * @param {number} escrowAmount - the total escrowed amount
     * @param {'customer'|'business'} direction - who is being penalized
     * @returns {Promise<{ penaltyAmount: number, releaseAmount: number, policy: object }>}
     */
    async computePenalty(businessProfileId, escrowAmount, direction = 'customer') {
        const policy = await this.getOrCreatePolicy(businessProfileId);
        const pct = direction === 'customer' 
            ? Number(policy.customerNoShowPct) 
            : Number(policy.businessNoShowPct);
        
        const penaltyAmount = parseFloat((escrowAmount * pct).toFixed(6));
        const releaseAmount = parseFloat((escrowAmount - penaltyAmount).toFixed(6));

        return { penaltyAmount, releaseAmount, policy };
    }
}

module.exports = { PenaltyPolicyService, MAX_PENALTY_PCT };
