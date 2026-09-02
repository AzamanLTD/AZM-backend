'use strict';

const requestContext = require('../src/context/requestContext');
const { HotelOpsService } = require('../services/businessOS/hotelOpsService');

function runAsBusiness(businessProfileId, callback) {
    return requestContext.run({ businessProfileId, user: { id: 99 } }, callback);
}

describe('HotelOpsService business scoping', () => {
    test('room status mutations are constrained to the authenticated business', async () => {
        const prisma = {
            hotelRoom: {
                findFirst: jest.fn().mockResolvedValue({ id: 'room-a', businessProfileId: 'biz-a', status: 'AVAILABLE' }),
                update: jest.fn().mockResolvedValue({ id: 'room-a', status: 'OCCUPIED' }),
            },
        };

        await runAsBusiness('biz-a', () => new HotelOpsService(prisma).updateRoomStatus('room-a', 'OCCUPIED'));

        expect(prisma.hotelRoom.findFirst).toHaveBeenCalledWith({ where: { id: 'room-a', businessProfileId: 'biz-a' } });
        expect(prisma.hotelRoom.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'room-a' } }));
    });

    test('foreign rooms cannot be mutated because the scoped lookup returns no room', async () => {
        const prisma = {
            hotelRoom: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };

        await expect(runAsBusiness('biz-a', () => new HotelOpsService(prisma).updateRoom('foreign-room', { status: 'MAINTENANCE' })))
            .rejects.toThrow('Room not found.');
        expect(prisma.hotelRoom.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign-room', businessProfileId: 'biz-a' } });
        expect(prisma.hotelRoom.update).not.toHaveBeenCalled();
    });

    test('room blocks verify room ownership before creation', async () => {
        const prisma = {
            hotelRoom: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
            hotelRoomBlock: { create: jest.fn() },
        };

        await expect(runAsBusiness('biz-a', () => new HotelOpsService(prisma).blockRoom('foreign-room', {
            startDate: '2026-09-03', endDate: '2026-09-05', reason: 'Repair',
        }))).rejects.toThrow('Room not found.');
        expect(prisma.hotelRoomBlock.create).not.toHaveBeenCalled();
    });

    test('foreign room blocks cannot be deleted', async () => {
        const prisma = {
            hotelRoomBlock: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'block-b',
                    room: { businessProfileId: 'biz-b' },
                }),
                delete: jest.fn(),
            },
        };

        await expect(runAsBusiness('biz-a', () => new HotelOpsService(prisma).deleteRoomBlock('block-b')))
            .rejects.toThrow('Room block not found.');
        expect(prisma.hotelRoomBlock.delete).not.toHaveBeenCalled();
    });

    test('housekeeping task mutations enforce both task and employee business ownership', async () => {
        const prisma = {
            hotelHousekeepingTask: {
                findFirst: jest.fn().mockResolvedValue({ id: 'task-a', businessProfileId: 'biz-a', status: 'PENDING' }),
                update: jest.fn().mockResolvedValue({ id: 'task-a', status: 'IN_PROGRESS' }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
        };

        await expect(runAsBusiness('biz-a', () => new HotelOpsService(prisma).assignHousekeepingTask('task-a', 'employee-b')))
            .rejects.toThrow('Employee not found.');
        expect(prisma.businessEmployee.findFirst).toHaveBeenCalledWith({ where: { id: 'employee-b', businessProfileId: 'biz-a' } });
        expect(prisma.hotelHousekeepingTask.update).not.toHaveBeenCalled();
    });

    test('room moves use one transaction after scoping reservation and destination room', async () => {
        const tx = {
            reservation: { update: jest.fn() },
            hotelRoom: { update: jest.fn() },
        };
        const prisma = {
            reservation: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'res-a', businessProfileId: 'biz-a', serviceItemId: 'old-room', checkedInAt: new Date('2026-09-01'), endDatetime: new Date('2026-09-04'),
                }),
            },
            hotelRoom: {
                findFirst: jest.fn().mockResolvedValue({ id: 'new-room', businessProfileId: 'biz-a', status: 'AVAILABLE' }),
            },
            $transaction: jest.fn(async callback => callback(tx)),
        };

        const result = await runAsBusiness('biz-a', () => new HotelOpsService(prisma).moveRoom('res-a', {
            newRoomId: 'new-room', reason: 'Guest requested quieter floor',
        }));

        expect(result).toEqual({ ok: true });
        expect(prisma.reservation.findFirst).toHaveBeenCalledWith({ where: { id: 'res-a', businessProfileId: 'biz-a' } });
        expect(prisma.hotelRoom.findFirst).toHaveBeenCalledWith({ where: { id: 'new-room', businessProfileId: 'biz-a' } });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.reservation.update).toHaveBeenCalledTimes(1);
        expect(tx.hotelRoom.update).toHaveBeenCalledTimes(2);
    });
});
