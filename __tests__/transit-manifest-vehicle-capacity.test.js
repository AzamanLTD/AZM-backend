const { TransitOpsService } = require('../services/businessOS/transitOpsService');

describe('TransitOpsService manifest vehicle capacity', () => {
    test('uses the trip vehicle capacity when building a manifest', async () => {
        const prisma = {
            transitTrip: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'trip-a',
                    vehicleId: 'vehicle-a',
                    businessProfileId: 'business-a',
                    availableSeats: 2,
                    vehicle: { capacity: 14 },
                    reservations: [],
                    driverAssignments: [],
                }),
            },
        };
        const svc = new TransitOpsService(prisma);
        const manifest = await svc.getTripManifest('trip-a', 'business-a');

        expect(manifest.availableSeats).toBe(14);
        expect(prisma.transitTrip.findFirst.mock.calls[0][0].include.vehicle).toBeTruthy();
    });
});
