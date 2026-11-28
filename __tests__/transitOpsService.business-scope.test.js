const { TransitOpsService } = require('../services/businessOS/transitOpsService');

describe('TransitOpsService business scoping', () => {
    const bpA = 'business-a';
    const bpB = 'business-b';

    test('rejects assignment status updates outside the business', async () => {
        const prisma = {
            driverAssignment: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        const svc = new TransitOpsService(prisma);

        await expect(svc.updateAssignmentStatus('assignment-b', 'CHECKED_IN', bpA))
            .rejects.toThrow('Assignment not found.');
        expect(prisma.driverAssignment.findFirst).toHaveBeenCalledWith({
            where: { id: 'assignment-b', businessProfileId: bpA },
        });
        expect(prisma.driverAssignment.update).not.toHaveBeenCalled();
    });

    test('rejects maintenance updates outside the business', async () => {
        const prisma = {
            vehicleMaintenance: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        const svc = new TransitOpsService(prisma);

        await expect(svc.updateMaintenanceStatus('maintenance-b', { status: 'COMPLETED' }, bpA))
            .rejects.toThrow('Maintenance record not found.');
        expect(prisma.vehicleMaintenance.findFirst).toHaveBeenCalledWith({
            where: { id: 'maintenance-b', businessProfileId: bpA },
            select: { id: true },
        });
        expect(prisma.vehicleMaintenance.update).not.toHaveBeenCalled();
    });

    test('rejects manifest reads outside the business', async () => {
        const prisma = {
            transitTrip: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
        };
        const svc = new TransitOpsService(prisma);

        await expect(svc.getTripManifest('trip-b', bpA))
            .rejects.toThrow('Trip not found.');
        expect(prisma.transitTrip.findFirst).toHaveBeenCalledWith({
            where: { id: 'trip-b', businessProfileId: bpA },
            select: { id: true },
        });
    });

    // Boarding is by the trip's transit booking (not a Reservation): another
    // business's booking reads as missing and nothing is written. The
    // same-business path is in transit-manifest-vehicle-capacity.test.js.
    test('rejects boarding a booking outside the business', async () => {
        const prisma = {
            transitBooking: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        const svc = new TransitOpsService(prisma);

        await expect(svc.boardPassenger({ bookingId: 'booking-b', azamanId: 'AZM-1' }, bpA))
            .rejects.toThrow('Booking not found.');
        expect(prisma.transitBooking.findFirst).toHaveBeenCalledWith({
            where: { id: 'booking-b', businessProfileId: bpA },
            select: { id: true },
        });
        expect(prisma.transitBooking.update).not.toHaveBeenCalled();
    });

    test('rejects assignment to a foreign trip or vehicle', async () => {
        const prisma = {
            businessEmployee: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'employee-a', businessProfileId: bpA, role: 'DRIVER', userId: 11,
                }),
            },
            transitTrip: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
            transitVehicle: { findFirst: jest.fn() },
            driverAssignment: { findFirst: jest.fn(), create: jest.fn() },
        };
        const svc = new TransitOpsService(prisma);

        await expect(svc.assignDriver({
            businessProfileId: bpA,
            employeeId: 'employee-a',
            tripId: 'trip-b',
            vehicleId: 'vehicle-b',
            assignmentDate: '2026-09-02',
        })).rejects.toThrow('Trip not found for this business.');
        expect(prisma.transitVehicle.findFirst).not.toHaveBeenCalled();
        expect(prisma.driverAssignment.create).not.toHaveBeenCalled();
    });

    test('rejects maintenance creation with a foreign vehicle', async () => {
        const prisma = {
            transitVehicle: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
            vehicleMaintenance: { create: jest.fn() },
        };
        const svc = new TransitOpsService(prisma);

        await expect(svc.createMaintenanceRecord({
            businessProfileId: bpA,
            vehicleId: 'vehicle-b',
            type: 'SERVICE',
            scheduledDate: '2026-09-03',
        })).rejects.toThrow('Vehicle not found for this business.');
        expect(prisma.vehicleMaintenance.create).not.toHaveBeenCalled();
    });

    test('rejects route generation when the template vehicle is foreign', async () => {
        const prisma = {
            transitRouteTemplate: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'template-a',
                    businessProfileId: bpA,
                    vehicleId: 'vehicle-b',
                    name: 'Accra–Kumasi',
                    origin: 'Accra',
                    destination: 'Kumasi',
                    typicalFareUsdc: 10,
                    typicalDurationMins: 300,
                    defaultDepartureTimes: ['07:00'],
                }),
            },
            transitVehicle: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
            transitTrip: { create: jest.fn() },
        };
        const svc = new TransitOpsService(prisma);

        await expect(svc.generateTripsFromTemplate({
            businessProfileId: bpA,
            templateId: 'template-a',
            startDate: '2026-09-03',
            daysAhead: 1,
        })).rejects.toThrow('Route template vehicle no longer belongs to this business.');
        expect(prisma.transitTrip.create).not.toHaveBeenCalled();
    });
});
