// utils/escrow.js
// =============================================================================
// Thin compatibility wrapper around services/escrowService.js.
// Some older route files import `require('../utils/escrow')` and call
// `.dispute()`, `.refund()`, `.release()` — this wrapper maps those short
// names to the canonical escrowService functions.
// =============================================================================

const escrowService = require('../services/escrowService');

// Need a prisma instance — use the singleton from prisma/client.js
const prisma = require('../prisma/client');

module.exports = {
    /**
     * Raise a dispute on an escrow.
     * @param {string} escrowId
     * @param {string} reason
     * @param {string} [raisedById] - optional user ID
     */
    async dispute(escrowId, reason, raisedById) {
        return escrowService.raiseDispute(prisma, {
            escrowId,
            raisedById: raisedById || null,
            reason,
            evidenceUrls: [],
        });
    },

    /**
     * Refund an escrow (full refund to payer).
     * @param {string} escrowId
     * @param {string} [reason]
     */
    async refund(escrowId, reason) {
        return escrowService._refundEscrow(prisma, escrowId, reason || 'Refunded via utils/escrow wrapper');
    },

    /**
     * Release escrow funds to the payee.
     * @param {string} escrowId
     */
    async release(escrowId) {
        return escrowService._releaseEscrow(prisma, escrowId);
    },

    /**
     * Create a new escrow.
     */
    async create(data) {
        return escrowService.createEscrow(prisma, data);
    },

    /**
     * Fund an existing escrow.
     */
    async fund(escrowId, payerId) {
        return escrowService.fundEscrow(prisma, { escrowId, payerId });
    },
};
