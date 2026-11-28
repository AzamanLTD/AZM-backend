// 📁 services/businessOS/transitOpsService.js
// services/businessOS/transitOpsService.js
// =============================================================================
// Transit Operations Service — driver rostering, fleet management,
// route/trip management, and live manifests.
// =============================================================================

const _status = (err, statusCode, code) => Object.assign(err, { statusCode, ...(code ? { code } : {}) });
const _withStatus = async (fn) => {
    try { return await fn(); } catch (err) {
        if (err && Number.isInteger(err.httpStatus) && !err.statusCode) err.statusCode = err.httpStatus;
        throw err;
    }
};

class TransitOpsService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ═══ FLEET MANAGEMENT ═════════════════════════════════════════════════════

    async createVehicle({ businessProfileId, type, make, model, year, color, licensePlate, capacity, imageUrl, driverName, driverPhone, driverPhotoUrl }) {
        return this.prisma.transitVehicle.create({
            data: {
                businessProfileId,
                type: type || 'CAR',
                make, model, year, color, licensePlate,
                capacity: capacity || 4,
                imageUrl, driverName, driverPhone, driverPhotoUrl,
                isActive: true,
            },
        });
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

        let trip = null;
        if (tripId) {
            trip = await this.prisma.transitTrip.findFirst({
                where: { id: tripId, businessProfileId },
            });
            if (!trip) throw new Error('Trip not found for this business.');
        }

        if (vehicleId) {
            const vehicle = await this.prisma.transitVehicle.findFirst({
                where: { id: vehicleId, businessProfileId },
            });
            if (!vehicle) throw new Error('Vehicle not found for this business.');
        }

        // Check for conflicts — same date, overlapping trips
        if (tripId && trip) {
            const existing = await this.prisma.driverAssignment.findFirst({
                where: {
                    businessProfileId,
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

    async updateAssignmentStatus(assignmentId, status, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const assignment = await this.prisma.driverAssignment.findFirst({
            where: { id: assignmentId, businessProfileId },
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
        const vehicle = await this.prisma.transitVehicle.findFirst({
            where: { id: vehicleId, businessProfileId },
            select: { id: true },
        });
        if (!vehicle) throw new Error('Vehicle not found for this business.');

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

    async updateMaintenanceStatus(maintenanceId, { status, completedDate, actualCost, notes, performedBy }, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const maintenance = await this.prisma.vehicleMaintenance.findFirst({
            where: { id: maintenanceId, businessProfileId },
            select: { id: true },
        });
        if (!maintenance) throw new Error('Maintenance record not found.');

        const updates = { status };
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
                seatMap: { select: { layout: true, rows: true, cols: true, updatedAt: true } },
            },
        });

        return vehicles.map(v => ({
            id: v.id,
            type: v.type,
            make: v.make,
            model: v.model,
            year: v.year,
            color: v.color,
            licensePlate: v.licensePlate,
            capacity: v.capacity,
            isActive: v.isActive,
            driverName: v.driverName,
            driverPhone: v.driverPhone,
            imageUrl: v.imageUrl,
            currentStatus: v.isActive ? 'ACTIVE' : 'INACTIVE',
            activeAssignment: v.driverAssignments?.[0] || null,
            pendingMaintenance: v.maintenances || [],
            needsMaintenance: (v.maintenances || []).length > 0,
            seatMap: v.seatMap || null,
        }));
    }

    // A vehicle's seat map, saved from the fleet page. Same checks as the
    // trip seat-map save (transitSeatLayout): a valid grid, and never
    // removing, blanking or blocking a seat that has an active booking.
    async saveSeatMap(vehicleId, { layout, rows, cols } = {}, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const vehicle = await this.prisma.transitVehicle.findFirst({
            where: { id: vehicleId, businessProfileId },
            select: { id: true },
        });
        if (!vehicle) throw _status(new Error('Vehicle not found.'), 404);
        const { saveVehicleSeatMap } = require('../transitSeatLayout');
        const { seatMap } = await _withStatus(() => saveVehicleSeatMap(this.prisma, { vehicleId, layout, rows, cols }));
        return seatMap;
    }

    // ═══ LIVE MANIFESTS ═══════════════════════════════════════════════════════

    // The business's passenger list for one of its trips: the same manifest
    // the owner's app shows (transitBoardingService.buildTripManifest), built
    // from the trip's transit bookings, by seat. Staff reach it through the
    // business routes' permission check (transit.manifests.view); the trip
    // must belong to the business in context. (It used to read
    // trip.reservations, a relation transit trips do not have, so every
    // manifest request failed.)
    async getTripManifest(tripId, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const trip = await this.prisma.transitTrip.findFirst({
            where: { id: tripId, businessProfileId },
            select: { id: true },
        });
        if (!trip) throw _status(new Error('Trip not found.'), 404);
        const ownerId = await this._ownerUserId(businessProfileId);
        const { buildTripManifest } = require('../transitBoardingService');
        return _withStatus(() => buildTripManifest(this.prisma, { tripId, businessUserId: ownerId }));
    }

    // Boarding from the manifest by ID check: staff compared the passenger's
    // photo and ID with the booking. Same rule as the owner's app
    // (transitBoardingService.boardByIdCheck): the business must allow ID
    // check boarding, the AZM-ID must be the passenger's, and the booking must
    // be CONFIRMED. The booking must belong to the business in context.
    async boardPassenger({ bookingId, azamanId } = {}, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        if (!bookingId) throw _status(new Error('bookingId is required.'), 400);
        const booking = await this.prisma.transitBooking.findFirst({
            where: { id: bookingId, businessProfileId },
            select: { id: true },
        });
        if (!booking) throw _status(new Error('Booking not found.'), 404);
        const ownerId = await this._ownerUserId(businessProfileId);
        const { boardByIdCheck } = require('../transitBoardingService');
        return _withStatus(() => boardByIdCheck(this.prisma, { bookingId, businessUserId: ownerId, azamanId }));
    }

    async _ownerUserId(businessProfileId) {
        const profile = await this.prisma.businessProfile.findUnique({
            where: { id: businessProfileId },
            select: { userId: true },
        });
        if (!profile || !profile.userId) throw _status(new Error('Business not found.'), 404);
        return profile.userId;
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
            const manifest = await this.getTripManifest(trip.id, businessProfileId);
            manifests.push(manifest);
        }

        return manifests;
    }
    // ═══ MODULE 05: ROUTE TEMPLATES ═════════════════════════════════════════

    async createRouteTemplate({ businessProfileId, name, origin, destination, typicalFareUsdc, typicalDurationMins, vehicleId, defaultDepartureTimes, notes }) {
        if (vehicleId) {
            const vehicle = await this.prisma.transitVehicle.findFirst({
                where: { id: vehicleId, businessProfileId },
                select: { id: true },
            });
            if (!vehicle) throw new Error('Vehicle not found for this business.');
        }

        return this.prisma.transitRouteTemplate.create({
            data: {
                businessProfileId,
                name,
                origin,
                destination,
                typicalFareUsdc: typicalFareUsdc || 0,
                typicalDurationMins,
                vehicleId: vehicleId || null,
                defaultDepartureTimes: defaultDepartureTimes || null,
                notes,
                isActive: true,
            },
        });
    }

    async getRouteTemplates(businessProfileId) {
        return this.prisma.transitRouteTemplate.findMany({
            where: { businessProfileId },
            include: { vehicle: true },
            orderBy: { createdAt: 'desc' },
        });
    }

    async deleteRouteTemplate(businessProfileId, templateId) {
        const tpl = await this.prisma.transitRouteTemplate.findFirst({
            where: { id: templateId, businessProfileId },
        });
        if (!tpl) throw new Error('Route template not found.');
        return this.prisma.transitRouteTemplate.delete({ where: { id: templateId } });
    }

    async generateTripsFromTemplate({ businessProfileId, templateId, startDate, daysAhead = 30 }) {
        const tpl = await this.prisma.transitRouteTemplate.findFirst({
            where: { id: templateId, businessProfileId },
        });
        if (!tpl) throw new Error('Route template not found.');

        let vehicleCapacity = 0;
        if (tpl.vehicleId) {
            const vehicle = await this.prisma.transitVehicle.findFirst({
                where: { id: tpl.vehicleId, businessProfileId },
                select: { capacity: true },
            });
            if (!vehicle) throw new Error('Route template vehicle no longer belongs to this business.');
            vehicleCapacity = vehicle.capacity || 0;
        }

        const start = new Date(startDate);
        const created = [];
        const departureTimes = tpl.defaultDepartureTimes || ['07:00'];

        for (let d = 0; d < daysAhead; d++) {
            const day = new Date(start);
            day.setDate(day.getDate() + d);

            for (const timeStr of departureTimes) {
                const [hh, mm] = timeStr.split(':').map(Number);
                const departureAt = new Date(day);
                departureAt.setHours(hh, mm || 0, 0, 0);

                const arrivalAt = tpl.typicalDurationMins
                    ? new Date(departureAt.getTime() + tpl.typicalDurationMins * 60000)
                    : null;

                const trip = await this.prisma.transitTrip.create({
                    data: {
                        businessProfileId,
                        vehicleId: tpl.vehicleId,
                        routeName: tpl.name,
                        origin: tpl.origin,
                        destination: tpl.destination,
                        departureAt,
                        arrivalAt,
                        fareUsdc: tpl.typicalFareUsdc,
                        availableSeats: vehicleCapacity,
                        status: 'SCHEDULED',
                    },
                });
                created.push(trip);
            }
        }
        return { count: created.length, trips: created };
    }

    // ═══ MODULE 05: TRIP CANCEL WITH REFUND ═════════════════════════════════

    async cancelTripWithRefund({ businessProfileId, tripId }) {
        const trip = await this.prisma.transitTrip.findFirst({
            where: { id: tripId, businessProfileId },
            include: {
                bookings: { where: { status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } } },
            },
        });
        if (!trip) throw new Error('Trip not found.');
        if (trip.status === 'CANCELLED') throw new Error('Trip already cancelled.');

        const affectedBookings = trip.bookings;

        // Cancel the trip
        await this.prisma.transitTrip.update({
            where: { id: tripId },
            data: { status: 'CANCELLED' },
        });

        // Cancel all active bookings
        if (affectedBookings.length > 0) {
            await this.prisma.transitBooking.updateMany({
                where: { transitTripId: tripId, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } },
                data: { status: 'CANCELLED' },
            });
        }

        return {
            tripId,
            cancelledBookings: affectedBookings.length,
            bookings: affectedBookings.map(b => ({
                id: b.id,
                userId: b.userId,
                amountUsdc: b.amountUsdc,
                status: 'CANCELLED',
            })),
            note: 'Trip cancelled. Bookings marked CANCELLED — escrow refund should be triggered via existing dispute/refund path.',
        };
    }

    // ═══ MODULE 05: VEHICLE MAINTENANCE OVERDUE CHECK ════════════════════════

    async getMaintenanceOverdueVehicles(businessProfileId) {
        const vehicles = await this.prisma.transitVehicle.findMany({
            where: { businessProfileId, isActive: true },
            include: {
                maintenances: {
                    where: { status: 'SCHEDULED' },
                    orderBy: { scheduledDate: 'asc' },
                },
            },
        });

        const now = new Date();
        return vehicles.filter(v => {
            const overdueMaint = v.maintenances.some(m => new Date(m.scheduledDate) < now);
            return overdueMaint;
        }).map(v => ({
            id: v.id,
            make: v.make,
            model: v.model,
            licensePlate: v.licensePlate,
            overdueSince: v.maintenances.find(m => new Date(m.scheduledDate) < now)?.scheduledDate,
        }));
    }

    // ═══ MODULE 05: PROOF OF DELIVERY ═══════════════════════════════════════

    async updateCargoProofOfDelivery({ businessProfileId, cargoId, proofOfDeliveryUrl }) {
        const cargo = await this.prisma.cargoParcel.findFirst({
            where: { id: cargoId, businessProfileId },
        });
        if (!cargo) throw new Error('Cargo parcel not found.');

        return this.prisma.cargoParcel.update({
            where: { id: cargoId },
            data: {
                proofOfDeliveryUrl,
                status: cargo.status === 'IN_TRANSIT' ? 'DELIVERED' : cargo.status,
                deliveredAt: cargo.status === 'IN_TRANSIT' ? new Date() : cargo.deliveredAt,
            },
        });
    }

}

module.exports = { TransitOpsService };
