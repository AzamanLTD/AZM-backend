// workers/transitBookingExpiryWorker.js
// =============================================================================
// AZAMAN — TRANSIT BOOKING EXPIRY WORKER (Phase 5.2)
//
// Cancels PENDING transit bookings (trip seat bookings) that have not been
// funded/confirmed within 15 minutes of creation. Frees the seat for other
// customers. Runs every 5 minutes.
//
// Pattern follows escrowExpiryWorker: constructor deps + start()/stop() + _tick.
// =============================================================================

const logger = require('../src/config/logger');

const FIVE_MIN_MS = 5 * 60 * 1000;
const PENDING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

class TransitBookingExpiryWorker {
    constructor(prisma, io, notificationService, { intervalMs = FIVE_MIN_MS } = {}) {
        this.prisma = prisma;
        this.io = io || null;
        this.notificationService = notificationService || null;
        this.intervalMs = intervalMs;
        this._timer = null;
        this._running = false;
    }

    start() {
        if (this._timer) return;
        logger.info({ intervalMs: this.intervalMs }, '[TransitBookingExpiryWorker] started');
        this._timer = setInterval(() => this._tick().catch(err => {
            logger.error({ err }, '[TransitBookingExpiryWorker] tick error');
        }), this.intervalMs);
        // Don't block process exit
        this._timer.unref();
    }

    stop() {
        if (!this._timer) return;
        clearInterval(this._timer);
        this._timer = null;
        logger.info('[TransitBookingExpiryWorker] stopped');
    }

    async _tick() {
        if (this._running) return;
        this._running = true;
        try {
            const cutoff = new Date(Date.now() - PENDING_TIMEOUT_MS);

            // Find PENDING transit bookings older than 15 minutes
            const staleBookings = await this.prisma.transitBooking.findMany({
                where: {
                    status: 'PENDING',
                    createdAt: { lt: cutoff },
                },
                include: {
                    seats: true,
                    businessProfile: { select: { id: true, businessName: true } },
                },
            });

            if (staleBookings.length === 0) return;

            logger.info({ count: staleBookings.length }, '[TransitBookingExpiryWorker] expiring stale bookings');

            for (const booking of staleBookings) {
                try {
                    // Delete seat reservations first (cascade handles this but be explicit)
                    await this.prisma.transitBookingSeat.deleteMany({
                        where: { bookingId: booking.id },
                    });

                    // Mark booking as CANCELLED
                    await this.prisma.transitBooking.update({
                        where: { id: booking.id },
                        data: { status: 'CANCELLED' },
                    });

                    logger.info({ bookingId: booking.id, bookingRef: booking.bookingRef },
                        '[TransitBookingExpiryWorker] expired pending booking');

                    // Notify customer via socket
                    if (this.io && booking.customerId) {
                        this.io.to(`user_${booking.customerId}`).emit('transit_booking_expired', {
                            bookingId: booking.id,
                            bookingRef: booking.bookingRef,
                            reason: 'Payment not completed within 15 minutes',
                        });
                    }

                    // Push notification
                    if (this.notificationService && booking.customerId) {
                        try {
                            await this.notificationService.send({
                                userId: booking.customerId,
                                title: 'Transit Booking Expired',
                                body: `Your booking ${booking.bookingRef} expired — seat released. Please book again.`,
                                type: 'TRANSIT_BOOKING_EXPIRED',
                                metadata: { bookingId: booking.id },
                            });
                        } catch (notifErr) {
                            logger.warn({ err: notifErr }, '[TransitBookingExpiryWorker] notification send failed');
                        }
                    }
                } catch (err) {
                    logger.error({ err, bookingId: booking.id },
                        '[TransitBookingExpiryWorker] failed to expire booking');
                }
            }
        } finally {
            this._running = false;
        }
    }
}

module.exports = TransitBookingExpiryWorker;
