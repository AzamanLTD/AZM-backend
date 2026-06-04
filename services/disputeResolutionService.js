// services/disputeResolutionService.js
// =============================================================================
// AZAMAN — DISPUTE RESOLUTION SERVICE (Phase Q14)
//
// Structured admin dispute workflow:
//   1. Admin views disputed trade details (chat, proofs, history)
//   2. Admin rules: BUYER_WINS | VENDOR_WINS | SPLIT
//   3. System auto-executes escrow release based on ruling
//   4. Both parties notified, stats updated
//
// Escrow math:
//   - BUYER_WINS: full disputeEscrowBalance → buyer's availableBalance
//   - VENDOR_WINS: full disputeEscrowBalance → vendor's availableBalance
//   - SPLIT: buyerAmount → buyer, vendorAmount → vendor (must sum to escrow)
// =============================================================================

class DisputeResolutionService {
    constructor(prisma, notificationService) {
        this.prisma = prisma;
        this.notificationService = notificationService;
    }

    /**
     * Resolve a disputed trade.
     *
     * @param {Object} params
     * @param {number} params.tradeId
     * @param {number} params.adminId
     * @param {string} params.ruling - BUYER_WINS | VENDOR_WINS | SPLIT
     * @param {string} params.reason - Admin's explanation
     * @param {number} [params.buyerPercent] - For SPLIT: % to buyer (0-100)
     */
    async resolveDispute({ tradeId, adminId, ruling, reason, buyerPercent }) {
        // Validate ruling
        if (!['BUYER_WINS', 'VENDOR_WINS', 'SPLIT'].includes(ruling)) {
            throw new Error('Invalid ruling. Must be BUYER_WINS, VENDOR_WINS, or SPLIT');
        }

        if (ruling === 'SPLIT' && (buyerPercent == null || buyerPercent < 0 || buyerPercent > 100)) {
            throw new Error('SPLIT ruling requires buyerPercent between 0 and 100');
        }

        if (!reason || reason.trim().length < 10) {
            throw new Error('Reason is required and must be at least 10 characters');
        }

        // Fetch the trade
        const trade = await this.prisma.trade.findUnique({
            where: { id: tradeId },
            select: {
                id: true,
                status: true,
                userId: true,
                vendorId: true,
                amountCrypto: true,
                crypto: true,
                type: true,
            },
        });

        if (!trade) throw new Error('Trade not found');
        if (trade.status !== 'DISPUTED') {
            throw new Error(`Trade is not in DISPUTED status. Current: ${trade.status}`);
        }

        // Check no existing resolution
        const existing = await this.prisma.disputeResolution.findUnique({
            where: { tradeId },
        });
        if (existing) {
            throw new Error('This dispute has already been resolved');
        }

        // Determine escrow holder based on trade type
        // SELL ad: vendor escrowed → disputeEscrowBalance is on vendor
        // BUY ad: user escrowed → disputeEscrowBalance is on user
        const escrowHolderId = trade.type === 'BUY' ? trade.userId : trade.vendorId;
        const escrowHolder = await this.prisma.user.findUnique({
            where: { id: escrowHolderId },
            select: { disputeEscrowBalance: true },
        });

        const totalEscrow = Number(escrowHolder.disputeEscrowBalance);
        if (totalEscrow <= 0) {
            throw new Error('No escrow funds found for this trade. Cannot resolve.');
        }

        // Calculate split amounts
        let buyerAmount = 0;
        let vendorAmount = 0;

        switch (ruling) {
            case 'BUYER_WINS':
                buyerAmount = totalEscrow;
                vendorAmount = 0;
                break;
            case 'VENDOR_WINS':
                buyerAmount = 0;
                vendorAmount = totalEscrow;
                break;
            case 'SPLIT':
                buyerAmount = totalEscrow * (buyerPercent / 100);
                vendorAmount = totalEscrow - buyerAmount;
                break;
        }

        // Execute atomically
        const resolution = await this.prisma.$transaction(async (tx) => {
            // 1. Release escrow from holder
            await tx.user.update({
                where: { id: escrowHolderId },
                data: { disputeEscrowBalance: { decrement: totalEscrow } },
            });

            // 2. Credit buyer
            if (buyerAmount > 0) {
                await tx.user.update({
                    where: { id: trade.userId },
                    data: { availableBalance: { increment: buyerAmount } },
                });
            }

            // 3. Credit vendor
            if (vendorAmount > 0) {
                await tx.user.update({
                    where: { id: trade.vendorId },
                    data: { availableBalance: { increment: vendorAmount } },
                });
            }

            // 4. Update trade status
            await tx.trade.update({
                where: { id: tradeId },
                data: { status: 'COMPLETED', completedAt: new Date() },
            });

            // 5. Create resolution record
            const res = await tx.disputeResolution.create({
                data: {
                    tradeId,
                    adminId,
                    ruling,
                    reason: reason.trim(),
                    buyerAmount,
                    vendorAmount,
                    totalEscrow,
                    status: 'EXECUTED',
                    executedAt: new Date(),
                },
            });

            return res;
        });

        // 6. Notify both parties (fire-and-forget)
        const rulingText = ruling === 'BUYER_WINS' ? 'in your favor'
            : ruling === 'VENDOR_WINS' ? 'in the vendor\'s favor'
            : `split (${buyerPercent}% / ${100 - buyerPercent}%)`;

        setImmediate(async () => {
            try {
                // Notify buyer
                await this.notificationService.sendNotification({
                    userId: trade.userId,
                    title: 'Dispute Resolved',
                    body: `Trade #${tradeId} dispute resolved ${ruling === 'BUYER_WINS' ? 'in your favor' : ruling === 'VENDOR_WINS' ? 'in the vendor\'s favor' : 'with a split'}. ${buyerAmount > 0 ? `$${buyerAmount.toFixed(2)} credited.` : ''}`,
                    category: 'TRADE',
                    actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) },
                });

                // Notify vendor
                await this.notificationService.sendNotification({
                    userId: trade.vendorId,
                    title: 'Dispute Resolved',
                    body: `Trade #${tradeId} dispute resolved ${ruling === 'VENDOR_WINS' ? 'in your favor' : ruling === 'BUYER_WINS' ? 'in the buyer\'s favor' : 'with a split'}. ${vendorAmount > 0 ? `$${vendorAmount.toFixed(2)} credited.` : ''}`,
                    category: 'TRADE',
                    actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) },
                });
            } catch (err) {
                console.error('[DisputeResolution] notification error:', err.message);
            }
        });

        return resolution;
    }

    /**
     * Get resolution history (admin view).
     */
    async getResolutionHistory({ limit = 20, cursor } = {}) {
        const where = {};
        const findArgs = {
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                trade: {
                    select: { id: true, userId: true, vendorId: true, amountCrypto: true, type: true },
                },
            },
        };

        if (cursor) {
            findArgs.cursor = { id: cursor };
            findArgs.skip = 1;
        }

        return this.prisma.disputeResolution.findMany(findArgs);
    }
}

module.exports = DisputeResolutionService;
