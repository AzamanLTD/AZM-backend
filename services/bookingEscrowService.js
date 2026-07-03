
exports.MAX_PENALTY_PCT = 0.50;
    /**
     * Process a business no-show — business failed to fulfill a booking.
     * Refunds the customer fully and penalizes the business.
     * @param {string} escrowId
     * @param {string} businessProfileId
     * @returns {Promise<object>}
     */
    async processBusinessNoShow(escrowId, businessProfileId) {
        const escrow = await this.prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        if (!escrow) throw new Error('Escrow not found.');
        if (escrow.status !== 'FUNDED') throw new Error('Escrow must be FUNDED to process business no-show.');

        // Full refund to customer
        const updated = await this.prisma.smartEscrow.update({
            where: { id: escrowId },
            data: { status: 'REFUNDED', releasedAt: new Date() },
        });

        // Record business default notification
        try {
            await this.prisma.notification.create({
                data: {
                    userId: escrow.buyerId,
                    type: 'PENALTY_REFUNDED',
                    category: 'MARKETPLACE',
                    title: 'Business no-show — refund issued',
                    body: `The business failed to fulfill your booking. A full refund of ${escrow.amount} USDC has been issued.`,
                    metadata: { escrowId, businessProfileId },
                    isRead: false,
                },
            });
        } catch (e) {
            console.error('[bookingEscrow] Notification failed:', e.message);
        }

        return updated;
    }


