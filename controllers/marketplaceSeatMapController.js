const SEAT_TIERS = ['VIP', 'STANDARD', 'ECONOMY'];

exports.getSeatMap = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const { tripId } = req.params;

        const trip = await prisma.transitTrip.findUnique({
            where: { id: tripId },
            include: { vehicle: { include: { seatMap: true } } },
        });
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

        // Also get booked seats
        const bookedSeats = await prisma.transitBookingSeat.findMany({
            where: { tripId },
            select: { seatId: true, passengerName: true },
        });

        const tierFares = (trip.metadata && trip.metadata.tierFares) || {};

        res.json({
            success: true,
            seatMap: trip.vehicle?.seatMap || null,
            bookedSeats,
            rows: trip.vehicle?.seatMap?.rows || 0,
            cols: trip.vehicle?.seatMap?.cols || 0,
            vehicleCapacity: trip.vehicle?.capacity || 0,
            fareUsdc: trip.fareUsdc,
            tierFares,
            seatTiers: SEAT_TIERS,
            tripId: trip.id,
            routeName: trip.routeName,
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.saveSeatMap = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const { tripId } = req.params;
        const { layout, rows, cols, tierFares } = req.body;

        const trip = await prisma.transitTrip.findUnique({
            where: { id: tripId },
            include: { vehicle: true },
        });
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

        // Validate any seat tier tags against the allowed set (additive field on each seat entry)
        if (Array.isArray(layout)) {
            const badTier = layout.find(s => s.tier && !SEAT_TIERS.includes(s.tier));
            if (badTier) {
                return res.status(400).json({ success: false, message: `Invalid seat tier "${badTier.tier}". Must be one of ${SEAT_TIERS.join(', ')}.` });
            }
        }
        if (tierFares && typeof tierFares === 'object') {
            const badKey = Object.keys(tierFares).find(k => !SEAT_TIERS.includes(k));
            if (badKey) {
                return res.status(400).json({ success: false, message: `Invalid tier fare key "${badKey}". Must be one of ${SEAT_TIERS.join(', ')}.` });
            }
        }

        // Upsert seat map (unchanged shape — layout/rows/cols on TransitSeatMap)
        const seatMap = await prisma.transitSeatMap.upsert({
            where: { vehicleId: trip.vehicleId },
            create: { vehicleId: trip.vehicleId, layout, rows, cols },
            update: { layout, rows, cols },
        });

        // Store per-tier fare overrides on the trip's existing JSON metadata field —
        // fully additive, no schema migration needed. Merge so other metadata keys survive.
        let updatedTrip = trip;
        if (tierFares && typeof tierFares === 'object') {
            const mergedMetadata = { ...(trip.metadata || {}), tierFares };
            updatedTrip = await prisma.transitTrip.update({
                where: { id: tripId },
                data: { metadata: mergedMetadata },
            });
        }

        res.json({
            success: true,
            seatMap,
            tierFares: (updatedTrip.metadata && updatedTrip.metadata.tierFares) || {},
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
