
exports.someFunc = async () => {
    /**
     * Generate a check-in token for a transit booking.
     * Includes seat IDs and validates departure time.
     * @param {string} bookingId
     * @param {Array<string>} seatIds
     * @returns {Promise<{token: string, expiresAt: Date}>}
     */
    async generateTransitCheckInToken(bookingId, seatIds = []) {
        const booking = await this.prisma.transitBooking.findUnique({
            where: { id: bookingId },
            include: { trip: { select: { scheduledAt: true } } },
        });
        if (!booking) throw new Error('Transit booking not found.');
        if (booking.status !== 'CONFIRMED') throw new Error('Booking must be confirmed.');

        // Validate departure hasn't passed
        const now = new Date();
        if (new Date(booking.trip.scheduledAt) < now) {
            throw new Error('Cannot generate QR — departure time has passed.');
        }

        const payload = {
            type: 'TRANSIT_CHECKIN',
            bookingId,
            seatIds,
            issuedAt: now.toISOString(),
        };

        const crypto = require('crypto');
        const secret = process.env.QR_HMAC_SECRET || 'azaman-transit-secret';
        const hmac = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
        const token = Buffer.from(JSON.stringify({ ...payload, hmac })).toString('base64');
        const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 min TTL

        return { token, expiresAt };
    }

};
