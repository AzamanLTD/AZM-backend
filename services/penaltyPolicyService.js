// services/penaltyPolicyService.js
// =============================================================================
// AZAMAN — Booking Penalty Policy Service (Phase 5)
//
// Handles penalty logic for business no-shows (business cancels booking):
//   - Full refund to customer
//   - Optional penalty deducted from business stake
//   - Trust score impact for the business
//
// Called by bookingEscrowService.processBusinessNoShow() to avoid the
// circular self-reference that was there before (bookingEscrowService was
// importing itself via penaltyPolicyService which didn't exist).
// =============================================================================

const logger = require('../src/config/logger');

const MAX_PENALTY_PCT = 0.10; // 10% of escrow amount max penalty for business no-show

/**
 * Process a business no-show: full refund to customer + optional business penalty.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} params
 * @param {string} params.escrowId - The escrow to refund
 * @param {string} params.bookingType - 'transit' | 'hotel' | 'reservation' | 'dinein'
 * @param {string} params.bookingId - The booking ID
 * @param {string} params.businessProfileId - The business that no-showed
 * @param {string} params.reason - Why the business no-showed
 */
async function processBusinessNoShow(prisma, {
    escrowId,
    bookingType,
    bookingId,
    businessProfileId,
    reason,
}) {
    logger.info({ escrowId, bookingType, bookingId, businessProfileId, reason },
        '[penaltyPolicy] processing business no-show');

    // 1. Refund the escrow (full refund to customer)
    let refundResult = null;
    try {
        const escrowService = require('./escrowService');
        refundResult = await escrowService._refundEscrow(prisma, escrowId,
            `Business no-show: ${reason}`);
    } catch (err) {
        logger.error({ err, escrowId },
            '[penaltyPolicy] failed to refund escrow for business no-show');
        throw err;
    }

    // 2. Apply business penalty (deduct from stake, log it)
    let penaltyApplied = false;
    let penaltyAmount = 0;
    try {
        const escrow = await prisma.smartEscrow.findUnique({
            where: { id: escrowId },
            select: { amountUsdc: true, payerId: true, payeeId: true },
        });

        if (escrow) {
            penaltyAmount = parseFloat(escrow.amountUsdc) * MAX_PENALTY_PCT;

            // Deduct penalty from business stake balance if it exists
            const stake = await prisma.businessProfile.findUnique({
                where: { id: businessProfileId },
                select: { stakeBalance: true, businessName: true },
            });

            if (stake && parseFloat(stake.stakeBalance || '0') >= penaltyAmount) {
                await prisma.businessProfile.update({
                    where: { id: businessProfileId },
                    data: {
                        stakeBalance: {
                            decrement: penaltyAmount,
                        },
                    },
                });
                penaltyApplied = penaltyAmount > 0;

                logger.info({ businessProfileId, penaltyAmount },
                    '[penaltyPolicy] business stake penalized for no-show');
            } else {
                logger.warn({ businessProfileId, penaltyAmount, stakeBalance: stake?.stakeBalance },
                    '[penaltyPolicy] insufficient stake for penalty — skipping deduction');
            }
        }
    } catch (err) {
        // Penalty failure should not block the refund
        logger.error({ err, businessProfileId },
            '[penaltyPolicy] failed to apply business penalty — refund already processed');
    }

    // 3. Log the no-show event for audit trail
    try {
        await prisma.auditLog.create({
            data: {
                action: 'BUSINESS_NO_SHOW',
                entity: bookingType.toUpperCase(),
                entityId: bookingId,
                userId: null,
                metadata: {
                    businessProfileId,
                    escrowId,
                    reason,
                    refundAmount: refundResult?.refundAmount || null,
                    penaltyAmount,
                    penaltyApplied,
                    penaltyPct: MAX_PENALTY_PCT,
                },
            },
        });
    } catch (err) {
        // AuditLog may not exist — don't block
        logger.warn({ err }, '[penaltyPolicy] could not write audit log');
    }

    return {
        refunded: true,
        penaltyApplied,
        penaltyAmount,
        refundResult,
    };
}

module.exports = { processBusinessNoShow, MAX_PENALTY_PCT };
