// controllers/transitController.js
// =============================================================================
// AZAMAN — TRANSIT BOOKING CONTROLLER (B-11, 2026-06-28)
//
// Handles ride-hailing / delivery booking lifecycle: create, list, get,
// cancel, complete. All endpoints are authenticated.
//
// Routes (mounted at /api/transit):
//   POST   /api/transit/bookings          — create a booking
//   GET    /api/transit/bookings          — list caller's bookings
//   GET    /api/transit/bookings/:id      — booking detail
//   PATCH  /api/transit/bookings/:id/status — update status (cancel/complete)
// =============================================================================

const VALID_TRANSITIONS = {
    PENDING:      ['CONFIRMED', 'CANCELLED'],
    CONFIRMED:    ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS:  ['COMPLETED', 'CANCELLED'],
    COMPLETED:    [],
    CANCELLED:    [],
    NO_SHOW:      [],
};

function _isValidTransition(current, next) {
    const allowed = VALID_TRANSITIONS[current];
    return allowed && allowed.includes(next);
}

// POST /api/transit/bookings
exports.createBooking = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const {
            businessProfileId, vehicleId, pickupAddress, dropoffAddress,
            pickupLatitude, pickupLongitude, dropoffLatitude, dropoffLongitude,
            scheduledAt, amountUsdc, customerNote, metadata
        } = req.body;

        if (!businessProfileId || !pickupAddress || !dropoffAddress || amountUsdc == null) {
            return res.status(400).json({
                success: false,
                message: 'businessProfileId, pickupAddress, dropoffAddress, and amountUsdc are required.'
            });
        }

        const bizProfile = await prisma.businessProfile.findUnique({
            where: { id: businessProfileId },
            select: { id: true, isSuspended: true }
        });
        if (!bizProfile) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }
        if (bizProfile.isSuspended) {
            return res.status(403).json({ success: false, message: 'Business is suspended.' });
        }

        if (vehicleId) {
            const vehicle = await prisma.transitVehicle.findUnique({
                where: { id: vehicleId },
                select: { id: true, businessProfileId: true, isActive: true }
            });
            if (!vehicle || vehicle.businessProfileId !== businessProfileId) {
                return res.status(400).json({ success: false, message: 'Vehicle not found for this business.' });
            }
            if (!vehicle.isActive) {
                return res.status(409).json({ success: false, message: 'Vehicle is not active.' });
            }
        }

        const count = await prisma.transitBooking.count();
        const bookingRef = `TRN-${String(Date.now()).slice(-6)}-${String((count + 1) % 10000).padStart(4, '0')}`;

        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId,
                vehicleId: vehicleId || null,
                customerId: userId,
                status: 'PENDING',
                pickupAddress,
                dropoffAddress,
                pickupLatitude: pickupLatitude ? parseFloat(pickupLatitude) : null,
                pickupLongitude: pickupLongitude ? parseFloat(pickupLongitude) : null,
                dropoffLatitude: dropoffLatitude ? parseFloat(dropoffLatitude) : null,
                dropoffLongitude: dropoffLongitude ? parseFloat(dropoffLongitude) : null,
                scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
                amountUsdc: parseFloat(amountUsdc),
                customerNote: customerNote || null,
                bookingRef,
                metadata: metadata || null
            },
            include: {
                vehicle: true,
                businessProfile: {
                    select: { id: true, businessName: true, logoUrl: true }
                }
            }
        });

        return res.status(201).json({ success: true, booking });
    } catch (err) {
        console.error('[transit.createBooking] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/transit/bookings
exports.listBookings = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { status, role, cursor } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

        const where = {};
        if (role === 'business') {
            const profile = await prisma.businessProfile.findUnique({ where: { userId }, select: { id: true } });
            if (profile) where.businessProfileId = profile.id;
            else return res.status(200).json({ success: true, bookings: [], hasMore: false });
        } else {
            where.customerId = userId;
        }
        if (status) where.status = String(status).toUpperCase();

        const bookings = await prisma.transitBooking.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit + 1,
            include: {
                vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true, driverPhone: true } },
                businessProfile: { select: { id: true, businessName: true, logoUrl: true } }
            },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });

        const hasMore = bookings.length > limit;
        const slice = hasMore ? bookings.slice(0, limit) : bookings;
        const nextCursor = hasMore ? slice[slice.length - 1].id : null;

        return res.status(200).json({ success: true, bookings: slice, hasMore, nextCursor });
    } catch (err) {
        console.error('[transit.listBookings] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/transit/bookings/:id
exports.getBooking = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const booking = await prisma.transitBooking.findUnique({
            where: { id },
            include: {
                vehicle: true,
                businessProfile: { select: { id: true, userId: true, businessName: true, logoUrl: true, phoneNumber: true } }
            }
        });

        if (!booking) {
            return res.status(404).json({ success: false, message: 'Booking not found.' });
        }

        const isCustomer = booking.customerId === userId;
        const isOwner = booking.businessProfile.userId === userId;
        if (!isCustomer && !isOwner) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        return res.status(200).json({ success: true, booking });
    } catch (err) {
        console.error('[transit.getBooking] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// PATCH /api/transit/bookings/:id/status
exports.updateBookingStatus = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { status, driverNote } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, message: 'status is required.' });
        }

        const nextStatus = String(status).toUpperCase();
        const booking = await prisma.transitBooking.findUnique({
            where: { id },
            include: { businessProfile: { select: { id: true, userId: true } } }
        });

        if (!booking) {
            return res.status(404).json({ success: false, message: 'Booking not found.' });
        }

        const isCustomer = booking.customerId === userId;
        const isOwner = booking.businessProfile.userId === userId;
        if (!isCustomer && !isOwner) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        // Only business owner can confirm/in-progress/complete; customer can cancel
        if (!isOwner && !['CANCELLED', 'NO_SHOW'].includes(nextStatus)) {
            return res.status(403).json({ success: false, message: 'Only the business can update to this status.' });
        }
        if (!_isValidTransition(booking.status, nextStatus)) {
            return res.status(409).json({
                success: false,
                message: `Cannot transition from ${booking.status} to ${nextStatus}.`
            });
        }

        const updateData = { status: nextStatus };
        if (nextStatus === 'CONFIRMED' && !booking.pickupTime) {
            updateData.pickupTime = new Date();
        }
        if (nextStatus === 'COMPLETED') {
            updateData.dropoffTime = new Date();
        }
        if (nextStatus === 'CANCELLED' || nextStatus === 'NO_SHOW') {
            updateData.driverNote = driverNote || null;
        }

        const updated = await prisma.transitBooking.update({
            where: { id },
            data: updateData,
            include: {
                vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true } },
                businessProfile: { select: { id: true, businessName: true } }
            }
        });

        // Real-time notification to both parties
        if (io) {
            io.to(`user_${booking.customerId}`).emit('transit_booking_update', updated);
            if (booking.businessProfile.userId !== booking.customerId) {
                io.to(`user_${booking.businessProfile.userId}`).emit('transit_booking_update', updated);
            }
        }

        return res.status(200).json({ success: true, booking: updated });
    } catch (err) {
        console.error('[transit.updateBookingStatus] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/transit/bookings/:id/checkin-qr
exports.generateTransitCheckInQR = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { qrCheckInService } = require('../services/qrCheckInService') || { qrCheckInService: require('../services/qrCheckInService') };
    try {
        const userId = req.user.id;
        const bookingId = req.params.id;

        const booking = await prisma.transitBooking.findUnique({
            where: { id: bookingId }
        });

        if (!booking) {
            return res.status(404).json({ success: false, message: 'Booking not found.' });
        }
        if (booking.customerId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }
        if (booking.status !== 'CONFIRMED' && booking.status !== 'IN_PROGRESS') {
            return res.status(409).json({ success: false, message: 'Booking must be CONFIRMED or IN_PROGRESS to generate QR.' });
        }

        const svc = qrCheckInService || require('../services/qrCheckInService');
        const tokenData = await svc.generateTransitCheckInToken(bookingId, userId);
        return res.status(200).json({ success: true, qrData: tokenData });
    } catch (err) {
        console.error('[transit.generateTransitCheckInQR] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// POST /api/transit/boarding
exports.transitBoarding = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { qrCheckInService } = require('../services/qrCheckInService') || { qrCheckInService: require('../services/qrCheckInService') };
    try {
        const userId = req.user.id;
        const { code } = req.body;
        
        if (!code) {
            return res.status(400).json({ success: false, message: 'QR code is required.' });
        }

        const svc = qrCheckInService || require('../services/qrCheckInService');
        const result = await svc.transitCheckIn(code, userId, prisma);
        
        if (!result.success) {
            return res.status(400).json(result);
        }

        return res.status(200).json(result);
    } catch (err) {
        console.error('[transit.transitBoarding] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};
