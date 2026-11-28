// GET/PUT /api/marketplace-seat-map/:tripId
// Anyone signed in may read a trip's seat map (to pick a seat), but only the
// trip's business (owner, or staff with a transit permission) sees passenger
// names, and only it may save a layout: owner or staff with
// transit.fleet.manage. A save is validated (transitSeatLayout) and refused
// when it would remove or block a seat that has an active booking.
const { SEAT_TIERS, validateLayout, bookedSeatsLost } = require('../services/transitSeatLayout');

// The caller's permissions on the trip's business, or null when the caller is
// not the owner or an active employee of it.
const _tripPermissions = async (prisma, user, businessProfileId) => {
    const { resolvePermissions } = require('../middleware/requirePermission');
    const permissions = await resolvePermissions(prisma, user.id, businessProfileId);
    return permissions.length ? permissions : null;
};
const _has = (permissions, ...keys) => Boolean(permissions
    && (permissions.includes('*') || keys.some((k) => permissions.includes(k))));

exports.getSeatMap = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const { tripId } = req.params;

        const trip = await prisma.transitTrip.findUnique({
            where: { id: tripId },
            include: { vehicle: { include: { seatMap: true } } },
        });
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

        const permissions = await _tripPermissions(prisma, req.user, trip.businessProfileId);
        const showNames = _has(permissions, 'transit.manifests.view', 'transit.trips.view', 'transit.fleet.manage');

        const bookedSeats = await prisma.transitBookingSeat.findMany({
            where: { tripId, booking: { status: { notIn: ['CANCELLED', 'NO_SHOW'] } } },
            select: { seatId: true, passengerName: true },
        });

        const tierFares = (trip.metadata && trip.metadata.tierFares) || {};

        res.json({
            success: true,
            seatMap: trip.vehicle?.seatMap || null,
            bookedSeats: showNames ? bookedSeats : bookedSeats.map((s) => ({ seatId: s.seatId })),
            rows: trip.vehicle?.seatMap?.rows || 0,
            cols: trip.vehicle?.seatMap?.cols || 0,
            vehicleCapacity: trip.vehicle?.capacity || 0,
            fareUsdc: trip.fareUsdc,
            tierFares,
            seatTiers: SEAT_TIERS,
            tripId: trip.id,
            routeName: trip.routeName,
        });
    } catch (err) { res.status(500).json({ success: false, message: 'Could not load the seat map.' }); }
};

exports.saveSeatMap = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const { tripId } = req.params;

        const trip = await prisma.transitTrip.findUnique({ where: { id: tripId } });
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

        const permissions = await _tripPermissions(prisma, req.user, trip.businessProfileId);
        if (!_has(permissions, 'transit.fleet.manage')) {
            return res.status(403).json({ success: false, code: 'SEAT_MAP_FORBIDDEN', message: 'Only this business can change its seat map.' });
        }

        let clean;
        try { clean = validateLayout(req.body || {}); } catch (e) {
            return res.status(e.httpStatus || 400).json({ success: false, code: e.code, message: e.message });
        }

        const lost = await bookedSeatsLost(prisma, { vehicleId: trip.vehicleId, layout: clean.layout });
        if (lost.length) {
            return res.status(409).json({
                success: false, code: 'SEAT_MAP_BOOKED_SEATS',
                message: `Seats ${lost.join(', ')} have active bookings. Move or cancel those bookings before removing or blocking them.`,
                seats: lost,
            });
        }

        const seatMap = await prisma.transitSeatMap.upsert({
            where: { vehicleId: trip.vehicleId },
            create: { vehicleId: trip.vehicleId, layout: clean.layout, rows: clean.rows, cols: clean.cols },
            update: { layout: clean.layout, rows: clean.rows, cols: clean.cols },
        });

        // Per-tier fares live on the trip's metadata; merge so other keys survive.
        let updatedTrip = trip;
        if (clean.tierFares) {
            updatedTrip = await prisma.transitTrip.update({
                where: { id: tripId },
                data: { metadata: { ...(trip.metadata || {}), tierFares: clean.tierFares } },
            });
        }

        res.json({
            success: true,
            seatMap,
            tierFares: (updatedTrip.metadata && updatedTrip.metadata.tierFares) || {},
        });
    } catch (err) { res.status(500).json({ success: false, message: 'Could not save the seat map.' }); }
};

exports._tripPermissions = _tripPermissions;
