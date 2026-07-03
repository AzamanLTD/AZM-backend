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

        res.json({
            success: true,
            seatMap: trip.vehicle?.seatMap || null,
            bookedSeats,
            rows: trip.vehicle?.seatMap?.rows || 0,
            cols: trip.vehicle?.seatMap?.cols || 0,
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.saveSeatMap = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const { tripId } = req.params;
        const { layout, rows, cols } = req.body;

        const trip = await prisma.transitTrip.findUnique({
            where: { id: tripId },
            include: { vehicle: true },
        });
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

        // Upsert seat map
        const seatMap = await prisma.transitSeatMap.upsert({
            where: { vehicleId: trip.vehicleId },
            create: { vehicleId: trip.vehicleId, layout, rows, cols },
            update: { layout, rows, cols },
        });

        res.json({ success: true, seatMap });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
