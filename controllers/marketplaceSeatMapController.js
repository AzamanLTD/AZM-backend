// GET/PUT /api/marketplace-seat-map/:tripId
// Anyone signed in may read a trip's seat map (to pick a seat), but only the
// trip's business (owner, or staff with a transit permission) sees passenger
// names, and only it may save a layout: owner or staff with
// transit.fleet.manage. A save is validated (transitSeatLayout) and refused
// when it would remove or block a seat that has an active booking.
const { SEAT_TIERS, saveVehicleSeatMap } = require('../services/transitSeatLayout');

// The caller's permissions on the trip's business, or null when the caller is
// not the owner or an active employee of it.
const _tripPermissions = async (prisma, user, businessProfileId) => {
    const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { userId: true } });
    if (!business) return null;
    if (business.userId === user.id) return ['*'];
    // Staff: ACTIVE employment only, as the business routes require (an
    // employee on leave keeps their stored permissions but cannot act).
    const employee = await prisma.businessEmployee.findUnique({
        where: { businessProfileId_userId: { businessProfileId, userId: user.id } },
        select: { status: true },
    });
    if (!employee || employee.status !== 'ACTIVE') return null;
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

        const { layout, rows, cols, tierFares } = req.body || {};
        // Checked and written in one transaction, trip counters included;
        // per-tier fares merge into this trip's metadata.
        const out = await saveVehicleSeatMap(prisma, { vehicleId: trip.vehicleId, layout, rows, cols, tierFares, tripId });
        res.json({ success: true, seatMap: out.seatMap, tierFares: out.tierFares || {} });
    } catch (err) {
        if (err && (err.code === 'SEAT_MAP_INVALID' || err.code === 'SEAT_MAP_BOOKED_SEATS')) {
            return res.status(err.httpStatus).json({ success: false, code: err.code, message: err.message, ...(err.detail || {}) });
        }
        res.status(500).json({ success: false, message: 'Could not save the seat map.' });
    }
};

exports._tripPermissions = _tripPermissions;
