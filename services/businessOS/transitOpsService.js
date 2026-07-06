// 📁 services/businessOS/transitOpsService.js
// services/businessOS/transitOpsService.js
// =============================================================================
// Transit Operations Service — driver rostering, fleet management,
// route/trip management, and live manifests.
// =============================================================================

class TransitOpsService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ═══ DRIVER ROSTERING ═════════════════════════════════════════════════════

    async assignDriver({ businessProfileId, employeeId, tripId, vehicleId, assignmentDate, role = 'DRIVER', notes }) {
        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });
        if (!employee) throw new Error('Employee not found.');
        if (employee.businessProfileId !== businessProfileId) {
            throw new Error('Employee does not belong to this business.');
        }
        if (employee.role !== 'DRIVER' && employee.role !== 'MANAGER') {
            throw new Error('Only drivers or managers can be assigned to trips.');
        }

        // Check for conflicts — same date, overlapping trips
        if (tripId) {
            const trip = await this.prisma.transitTrip.findUnique({
                where: { id: tripId },
            });
            if (trip) {
                const existing = await this.prisma.driverAssignment.findFirst({
                    where: {
                        employeeId,
                        assignmentDate: new Date(assignmentDate),
                        status: { in: ['ASSIGNED', 'CHECKED_IN', 'ON_DUTY'] },
                    },
                    include: { trip: true },
                });
                if (existing && existing.trip) {
                    // Check time overlap
                    if (existing.trip.departureAt < trip.arrivalTime && existing.trip.arrivalTime > trip.departureAt) {
                        throw new Error('Driver has a conflicting trip at this time.');
                    }
                }
            }
        }

        return this.prisma.driverAssignment.create({
            data: {
                businessProfileId,
                employeeId,
                userId: employee.userId,
                tripId,
                vehicleId,
                assignmentDate: new Date(assignmentDate),
                role,
            },
            include: {
                employee: { include: { user: { select: { username: true } } } },
                trip: true,
                vehicle: true,
            },
        });
    }

    async getDriverRoster(businessProfileId, { startDate, endDate, employeeId, vehicleId } = {}) {
        const where = { businessProfileId };
        if (startDate && endDate) {
            where.assignmentDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }
        if (employeeId) where.employeeId = employeeId;
        if (vehicleId) where.vehicleId = vehicleId;

        return this.prisma.driverAssignment.findMany({
            where,
            include: {
                employee: { include: { user: { select: { username: true, email: true } } } },
                trip: true,
                vehicle: true,
            },
            orderBy: { assignmentDate: 'asc' },
        });
    }

    async updateAssignmentStatus(assignmentId, status) {
        const assignment = await this.prisma.driverAssignment.findUnique({
            where: { id: assignmentId },
        });
        if (!assignment) throw new Error('Assignment not found.');

        const updates = { status };
        if (status === 'CHECKED_IN') updates.checkedInAt = new Date();
        if (status === 'COMPLETED') updates.completedAt = new Date();

        return this.prisma.driverAssignment.update({
            where: { id: assignmentId },
            data: updates,
        });
    }

    // Get driver's schedule (for worker sub-portal)
    async getDriverSchedule(userId, { startDate, endDate } = {}) {
        const where = { userId };
        if (startDate && endDate) {
            where.assignmentDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        return this.prisma.driverAssignment.findMany({
            where,
            include: {
                trip: true,
                vehicle: true,
                employee: {
                    include: {
                        businessProfile: { select: { businessName: true, logoUrl: true } },
                    },
                },
            },
            orderBy: { assignmentDate: 'asc' },
        });
    }

    // ═══ FLEET MANAGEMENT ═════════════════════════════════════════════════════

    async createMaintenanceRecord({ businessProfileId, vehicleId, type, scheduledDate, description, cost, odometer, serviceProvider, notes }) {
        // VehicleMaintenance uses `description` not `notes`; merge if both provided
        const finalDescription = description || notes;
        return this.prisma.vehicleMaintenance.create({
            data: {
                businessProfileId,
                vehicleId,
                type,
                scheduledDate: new Date(scheduledDate),
                description: finalDescription,
                cost: parseFloat(cost) || 0,
                odometerAtService: odometer ? parseInt(odometer) : null,
                serviceProvider,
                status: 'SCHEDULED',
            },
        });
    }

    async getMaintenanceRecords(businessProfileId, { vehicleId, status, type } = {}) {
        const where = { businessProfileId };
        if (vehicleId) where.vehicleId = vehicleId;
        if (status) where.status = status;
        if (type) where.type = type;

        return this.prisma.vehicleMaintenance.findMany({
            where,
            include: { vehicle: true },
            orderBy: { scheduledDate: 'desc' },
        });
    }

    async updateMaintenanceStatus(maintenanceId, { status, completedDate, actualCost, notes, performedBy }) {
        const updates = { status };
        // if (status === 'IN_PROGRESS') — no startedAt field in schema, skip
        if (status === 'COMPLETED') {
            updates.completedDate = completedDate ? new Date(completedDate) : new Date();
            if (actualCost) updates.cost = parseFloat(actualCost);
        }
        if (notes) updates.description = notes;
        // if (performedBy) — no performedBy field in schema, skip

        return this.prisma.vehicleMaintenance.update({
            where: { id: maintenanceId },
            data: updates,
        });
    }

    async getFleetOverview(businessProfileId) {
        const vehicles = await this.prisma.transitVehicle.findMany({
            where: { businessProfileId },
            include: {
                maintenances: {
                    where: { status: { in: ['SCHEDULED', 'IN_PROGRESS', 'OVERDUE'] } },
                    orderBy: { scheduledDate: 'asc' },
                },
                driverAssignments: {
                    where: { status: { in: ['ASSIGNED', 'CHECKED_IN', 'ON_DUTY'] } },
                    take: 1,
                },
            },
        });

        return vehicles.map(v => ({
            id: v.id,
            plateNumber: v.plateNumber,
            model: v.model,
            capacity: v.capacity,
            currentStatus: v.status,
            activeAssignment: v.driverAssignments[0] || null,
            pendingMaintenance: v.maintenances,
            needsMaintenance: v.maintenances.length > 0,
        }));
    }

    // ═══ LIVE MANIFESTS ═══════════════════════════════════════════════════════

    async getTripManifest(tripId) {
        const trip = await this.prisma.transitTrip.findUnique({
            where: { id: tripId },
            include: {
                reservations: {
                    where: { status: { in: ['CONFIRMED', 'CHECKED_IN', 'BOARDED'] } },
                    include: {
                        customer: { select: { username: true, email: true, phone: true } },
                    },
                    orderBy: { seatNumber: 'asc' },
                },
                driverAssignments: {
                    where: { status: { in: ['ASSIGNED', 'CHECKED_IN', 'ON_DUTY'] } },
                    include: {
                        employee: { include: { user: { select: { username: true, phone: true } } } },
                        vehicle: true,
                    },
                },
            },
        });
        if (!trip) throw new Error('Trip not found.');

        const totalSeats = trip.totalSeats || (trip.vehicle?.capacity || 0);
        const bookedSeats = trip.reservations.length;
        const availableSeats = totalSeats - bookedSeats;

        return {
            trip,
            driver: trip.driverAssignments[0]?.employee || null,
            vehicle: trip.driverAssignments[0]?.vehicle || null,
            passengers: trip.reservations.map(r => ({
                id: r.id,
                name: r.customer?.username || 'Unknown',
                phone: r.customer?.phone || null,
                seatNumber: r.seatNumber,
                status: r.status,
                checkedIn: r.status === 'CHECKED_IN' || r.status === 'BOARDED',
                azamanId: r.customer?.azamanId || null,
            })),
            stats: {
                totalSeats,
                bookedSeats,
                availableSeats,
                checkedIn: trip.reservations.filter(r => r.status === 'CHECKED_IN' || r.status === 'BOARDED').length,
                occupancyRate: totalSeats > 0 ? (bookedSeats / totalSeats) * 100 : 0,
            },
        };
    }

    // Boarding — mark passenger as boarded (called by driver scanner)
    async boardPassenger(reservationId) {
        const reservation = await this.prisma.reservation.findUnique({
            where: { id: reservationId },
        });
        if (!reservation) throw new Error('Reservation not found.');
        if (reservation.status === 'BOARDED') throw new Error('Passenger already boarded.');
        if (reservation.status === 'CANCELLED') throw new Error('Reservation was cancelled.');

        return this.prisma.reservation.update({
            where: { id: reservationId },
            data: { status: 'BOARDED' },
        });
    }

    // Get all manifests for a date
    async getDailyManifests(businessProfileId, date) {
        const targetDate = new Date(date);
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        const trips = await this.prisma.transitTrip.findMany({
            where: {
                businessProfileId,
                departureAt: { gte: targetDate, lt: nextDay },
            },
            orderBy: { departureAt: 'asc' },
        });

        const manifests = [];
        for (const trip of trips) {
            const manifest = await this.getTripManifest(trip.id);
            manifests.push(manifest);
        }

        return manifests;
    }
}

module.exports = { TransitOpsService };

