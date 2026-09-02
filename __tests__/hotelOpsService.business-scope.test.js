const { HotelOpsService } = require('../services/businessOS/hotelOpsService');

describe('HotelOpsService business scoping', () => {
    const bpA = 'business-a';

    test('rejects room status updates outside the business', async () => {
        const prisma = {
            hotelRoom: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
        };
        const svc = new HotelOpsService(prisma);

        await expect(svc.updateRoomStatus('room-b', 'MAINTENANCE', null, bpA))
            .rejects.toThrow('Room not found.');
        expect(prisma.hotelRoom.findFirst).toHaveBeenCalledWith({
            where: { id: 'room-b', businessProfileId: bpA },
            select: { id: true },
        });
        expect(prisma.hotelRoom.update).not.toHaveBeenCalled();
    });

    test('rejects housekeeping assignment when employee belongs to another business', async () => {
        const prisma = {
            businessEmployee: { findFirst: jest.fn().mockResolvedValue(null) },
            hotelHousekeepingTask: { findFirst: jest.fn(), update: jest.fn() },
        };
        const svc = new HotelOpsService(prisma);

        await expect(svc.assignHousekeepingTask('task-b', 'employee-b', bpA))
            .rejects.toThrow('Employee not found.');
        expect(prisma.hotelHousekeepingTask.findFirst).not.toHaveBeenCalled();
    });

    test('rejects housekeeping assignment when task belongs to another business', async () => {
        const prisma = {
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'employee-a', businessProfileId: bpA, role: 'HOUSEKEEPER', userId: 1 }),
            },
            hotelHousekeepingTask: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
        };
        const svc = new HotelOpsService(prisma);

        await expect(svc.assignHousekeepingTask('task-b', 'employee-a', bpA))
            .rejects.toThrow('Task not found.');
        expect(prisma.hotelHousekeepingTask.findFirst).toHaveBeenCalledWith({
            where: { id: 'task-b', businessProfileId: bpA },
            select: { id: true },
        });
        expect(prisma.hotelHousekeepingTask.update).not.toHaveBeenCalled();
    });

    test('rejects checklist changes outside the business', async () => {
        const prisma = {
            hotelHousekeepingTask: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
        };
        const svc = new HotelOpsService(prisma);

        await expect(svc.updateChecklist('task-b', 0, true, bpA)).rejects.toThrow('Task not found.');
        expect(prisma.hotelHousekeepingTask.findFirst).toHaveBeenCalledWith({
            where: { id: 'task-b', businessProfileId: bpA },
        });
        expect(prisma.hotelHousekeepingTask.update).not.toHaveBeenCalled();
    });

    test('rejects room blocks for foreign rooms', async () => {
        const prisma = {
            hotelRoom: { findFirst: jest.fn().mockResolvedValue(null) },
            hotelRoomBlock: { create: jest.fn() },
        };
        const svc = new HotelOpsService(prisma);

        await expect(svc.blockRoom('room-b', {
            startDate: '2026-09-04', endDate: '2026-09-05', reason: 'maintenance',
        }, bpA)).rejects.toThrow('Room not found.');
        expect(prisma.hotelRoomBlock.create).not.toHaveBeenCalled();
    });

    test('rejects deletion of a foreign room block', async () => {
        const prisma = {
            hotelRoomBlock: { findFirst: jest.fn().mockResolvedValue(null), delete: jest.fn() },
        };
        const svc = new HotelOpsService(prisma);

        await expect(svc.deleteRoomBlock('block-b', bpA)).rejects.toThrow('Room block not found.');
        expect(prisma.hotelRoomBlock.findFirst).toHaveBeenCalledWith({
            where: { id: 'block-b', room: { businessProfileId: bpA } },
            select: { id: true },
        });
        expect(prisma.hotelRoomBlock.delete).not.toHaveBeenCalled();
    });

    test('requires a registered Azaman customer for walk-in bookings', async () => {
        const prisma = { hotelRoom: { findFirst: jest.fn() }, user: { findUnique: jest.fn() } };
        const svc = new HotelOpsService(prisma);

        await expect(svc.createWalkIn(bpA, { roomId: 'room-a', nights: 1 }))
            .rejects.toThrow('A registered Azaman customer is required for a walk-in booking.');
        expect(prisma.hotelRoom.findFirst).not.toHaveBeenCalled();
    });


    test('rejects bulk room ranges larger than 500 rooms', async () => {
        const prisma = { businessLocation: { findFirst: jest.fn() }, hotelRoom: { createMany: jest.fn() } };
        const svc = new HotelOpsService(prisma);
        await expect(svc.bulkCreateRooms(bpA, { startNumber: 1, endNumber: 501 })).rejects.toThrow('limited to 500');
        expect(prisma.hotelRoom.createMany).not.toHaveBeenCalled();
    });

    test('rejects bulk room creation with a foreign location', async () => {
        const prisma = { businessLocation: { findFirst: jest.fn().mockResolvedValue(null) }, hotelRoom: { createMany: jest.fn() } };
        const svc = new HotelOpsService(prisma);
        await expect(svc.bulkCreateRooms(bpA, { startNumber: 1, endNumber: 2, locationId: 'location-b' })).rejects.toThrow('Location not found for this business.');
        expect(prisma.hotelRoom.createMany).not.toHaveBeenCalled();
    });

    test('rolls back a walk-in reservation when room occupancy update fails', async () => {
        const tx = {
            reservation: { create: jest.fn().mockResolvedValue({ id: 'reservation-a' }) },
            hotelRoom: { update: jest.fn().mockRejectedValue(new Error('room update failed')) },
        };
        const prisma = {
            hotelRoom: { findFirst: jest.fn().mockResolvedValue({ id: 'room-a', status: 'AVAILABLE', basePriceUsdc: 100 }) },
            user: { findUnique: jest.fn().mockResolvedValue({ id: 42 }) },
            $transaction: jest.fn(async callback => callback(tx)),
        };
        const svc = new HotelOpsService(prisma);
        await expect(svc.createWalkIn(bpA, { customerId: 42, roomId: 'room-a', nights: 1 })).rejects.toThrow('room update failed');
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.reservation.create).toHaveBeenCalledTimes(1);
    });

    test('rejects room moves across business boundaries', async () => {
        const prisma = {
            reservation: { findFirst: jest.fn().mockResolvedValue(null) },
            hotelRoom: { findFirst: jest.fn(), update: jest.fn() },
            $transaction: jest.fn(),
        };
        const svc = new HotelOpsService(prisma);

        await expect(svc.moveRoom('reservation-b', { newRoomId: 'room-b' }, bpA))
            .rejects.toThrow('Reservation not found');
        expect(prisma.hotelRoom.update).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test('moves a same-business reservation atomically', async () => {
        const reservation = {
            id: 'reservation-a',
            businessProfileId: bpA,
            serviceItemId: 'room-old',
            checkedInAt: new Date('2026-09-02T10:00:00Z'),
            endDatetime: new Date('2026-09-03T10:00:00Z'),
            metadata: { channel: 'FRONT_DESK' },
        };
        const prisma = {
            reservation: { findFirst: jest.fn().mockResolvedValue(reservation) },
            hotelRoom: {
                findFirst: jest.fn()
                    .mockResolvedValueOnce({ id: 'room-new', status: 'AVAILABLE', businessProfileId: bpA })
                    .mockResolvedValueOnce({ id: 'room-old' }),
            },
            $transaction: jest.fn(async (callback) => callback({
                reservation: { update: jest.fn().mockResolvedValue({ ...reservation, serviceItemId: 'room-new' }) },
                hotelRoom: { update: jest.fn().mockResolvedValue({}) },
            })),
        };
        const svc = new HotelOpsService(prisma);

        await expect(svc.moveRoom('reservation-a', { newRoomId: 'room-new', reason: 'guest request' }, bpA))
            .resolves.toEqual(expect.objectContaining({ ok: true }));
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
});
