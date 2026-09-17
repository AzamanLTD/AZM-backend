// workers/transitReminderWorker.js
// =============================================================================
// AZAMAN — TRANSIT REMINDER WORKER (Marketplace v2, 2026-07-03)
//
// Runs every 15 minutes. Finds confirmed transit bookings departing within the
// next 60-75 minutes where no reminder has been sent yet. Sends a push
// notification to the customer with trip details.
//
// Seat display note: TransitBookingSeat has no Prisma relation to a seat
// entity — `seatId` is the stored seat identifier (from the transit seat-map
// layout), and that is what the reminder shows. Do NOT reintroduce a
// `seat: { include / select }` clause here; it does not exist on the model.
//
// Registered in src/workers/index.js as scheduler job 'transit-reminders'.
// =============================================================================

const logger = require('../src/config/logger');

const REMINDER_WINDOW_MINS = 60; // send reminder 60 min before departure
const SWEEP_BUFFER_MINS = 15; // check bookings departing within 60-75 min

const sweepTransitReminders = async (prisma) => {
    const now = new Date();
    const windowStart = new Date(now.getTime() + REMINDER_WINDOW_MINS * 60 * 1000);
    const windowEnd = new Date(now.getTime() + (REMINDER_WINDOW_MINS + SWEEP_BUFFER_MINS) * 60 * 1000);

    // Find confirmed bookings departing in the window
    const upcoming = await prisma.transitBooking.findMany({
        where: {
            status: 'CONFIRMED',
            trip: { departureAt: { gte: windowStart, lte: windowEnd } },
            reminderSentAt: null, // haven't sent a reminder yet
        },
        include: {
            trip: {
                select: {
                    routeName: true, origin: true, destination: true,
                    departureAt: true, vehicle: { select: { type: true, make: true, model: true } }
                }
            },
            businessProfile: { select: { businessName: true } },
            // No `seat` relation exists on TransitBookingSeat — seatId is the
            // stored seat identifier and is used directly for the reminder text.
            seats: { select: { seatId: true } },
        }
    });

    const results = { processed: 0, sent: 0, errors: 0 };

    for (const booking of upcoming) {
        try {
            results.processed++;

            const departureTime = new Date(booking.trip.departureAt).toLocaleString('en-GH', {
                hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'
            });

            const seatLabels = booking.seats.map(s => s.seatId).join(', ');

            // Notification model has no `type`/`metadata` columns and
            // `MARKETPLACE` is not a NotificationCategory value — the original
            // create payload could never validate against the real schema.
            // `type` rides inside actionPayload (the model's Json column),
            // matching how notificationService._ensureDeepLink expects extra
            // fields to travel, and the category falls back to GENERAL —
            // the same normalization notificationService applies to unknown
            // categories.
            await prisma.notification.create({
                data: {
                    userId: booking.customerId,
                    category: 'GENERAL',
                    title: `Trip departing soon: ${booking.trip.routeName}`,
                    body: `Your trip to ${booking.trip.destination} departs at ${departureTime}. Seat(s): ${seatLabels}. Vehicle: ${booking.trip.vehicle?.type || 'N/A'}.`,
                    actionPayload: {
                        action: 'TRANSIT_REMINDER',
                        type: 'TRANSIT_REMINDER',
                        bookingId: booking.id,
                        tripId: booking.tripId,
                        routeName: booking.trip.routeName,
                        departureAt: booking.trip.departureAt,
                    },
                }
            });

            // Mark reminder as sent
            await prisma.transitBooking.update({
                where: { id: booking.id },
                data: { reminderSentAt: new Date() }
            });

            // Real-time push
            if (global._io) {
                global._io.to(`user_${booking.customerId}`).emit('transit_reminder', {
                    bookingId: booking.id,
                    routeName: booking.trip.routeName,
                    origin: booking.trip.origin,
                    destination: booking.trip.destination,
                    departureAt: booking.trip.departureAt,
                    seats: seatLabels,
                });
            }

            results.sent++;
        } catch (err) {
            results.errors++;
            logger.error(`[transitReminderWorker] Booking ${booking.id}:`, err.message);
        }
    }

    if (results.processed > 0) {
        logger.info(`[transitReminderWorker] Processed: ${results.processed}, Sent: ${results.sent}, Errors: ${results.errors}`);
    }

    return results;
};

module.exports = { sweepTransitReminders, REMINDER_WINDOW_MINS };
