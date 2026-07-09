// workers/transitReminderWorker.js
// =============================================================================
// AZAMAN — TRANSIT REMINDER WORKER (Marketplace v2, 2026-07-03)
//
// Runs every 15 minutes. Finds confirmed transit bookings departing within the
// next 60-75 minutes where no reminder has been sent yet. Sends a push
// notification to the customer with trip details.
//
// Registration in server.js:
//   const { sweepTransitReminders } = require('./workers/transitReminderWorker');
//   cron.schedule('*/15 * * * *', () => sweepTransitReminders(prisma));
// =============================================================================

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
            seats: { include: { seat: { select: { label: true } } } },
        }
    });

    const results = { processed: 0, sent: 0, errors: 0 };

    for (const booking of upcoming) {
        try {
            results.processed++;

            const departureTime = new Date(booking.trip.departureAt).toLocaleString('en-GH', {
                hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'
            });

            const seatLabels = booking.seats.map(s => s.seat?.label || 'N/A').join(', ');

            await prisma.notification.create({
                data: {
                    userId: booking.customerId,
                    type: 'TRANSIT_REMINDER',
                    category: 'MARKETPLACE',
                    title: `Trip departing soon: ${booking.trip.routeName}`,
                    body: `Your trip to ${booking.trip.destination} departs at ${departureTime}. Seat(s): ${seatLabels}. Vehicle: ${booking.trip.vehicle?.type || 'N/A'}.`,
                    metadata: {
                        bookingId: booking.id,
                        tripId: booking.tripId,
                        routeName: booking.trip.routeName,
                        departureAt: booking.trip.departureAt,
                    },
                    isRead: false,
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
            console.error(`[transitReminderWorker] Booking ${booking.id}:`, err.message);
        }
    }

    if (results.processed > 0) {
        console.log(`[transitReminderWorker] Processed: ${results.processed}, Sent: ${results.sent}, Errors: ${results.errors}`);
    }

    return results;
};

module.exports = { sweepTransitReminders, REMINDER_WINDOW_MINS };
