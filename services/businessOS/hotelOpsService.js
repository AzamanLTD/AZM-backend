'use strict';

// 📁 services/businessOS/hotelOpsService.js
// =============================================================================
// Hotel Operations Service — room management, housekeeping Kanban,
// and front desk (arrivals, departures, in-house guests).
// =============================================================================

const requestContext = require('../../src/context/requestContext');

async function businessScope(prisma, explicitBusinessProfileId) {
    const req = requestContext.get();
    const contextualBusinessId = req?.businessProfileId || null;
    const userId = req?.user?.id ? parseInt(req.user.id, 10) : null;

    if (contextualBusinessId && explicitBusinessProfileId && contextualBusinessId !== explicitBusinessProfileId) {
        throw new Error('Business context mismatch.');
    }

    if (contextualBusinessId) return contextualBusinessId;
    if (explicitBusinessProfileId) return explicitBusinessProfileId;

    if (userId) {
        const profile = await prisma.businessProfile.findFirst({
            where: { userId },
            select: { id: true },
        });
        if (profile) return profile.id;
    }

    return null;
}

async function scopedRoom(prisma, roomId, explicitBusinessProfileId) {
    const businessProfileId = await businessScope(prisma, explicitBusinessProfileId);
    const where = { id: roomId };
    if (businessProfileId) where.businessProfileId = businessProfileId;

    const room = await prisma.hotelRoom.findFirst({ where });
    if (!room) throw new Error('Room not found.');
    return { room, businessProfileId };
}

async function scopedRoomBlock(prisma, blockId, explicitBusinessProfileId) {
    const businessProfileId = await businessScope(prisma, explicitBusinessProfileId);
    const block = await prisma.hotelRoomBlock.findFirst({
        where: { id: blockId },
        include: { room: { select: { businessProfileId: true } } },
    });
    if (!block) throw new Error('Room block not found.');
    if (businessProfileId && block.room?.businessProfileId !== businessProfileId) {
        throw new Error('Room block not found.');
    }
    return { block, businessProfileId };
}

class HotelOpsService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ═══ ROOM MANAGEMENT ═══════════════════════════════════════════════════

    async createRoom({ businessProfileId, locationId, roomNumber, floor, roomType, basePrice, capacity, amenities = [], description }) {
        return this.prisma.hotelRoom.create({
            data: {
                businessProfileId,
                locationId,
                roomNumber,
                floor,
                roomType,
                basePriceUsdc: parseFloat(basePrice),
                capacity,
                amenities,
                description,
                status: 'AVAILABLE',
            },
        });
    }

    async getRooms(businessProfileId, { status, roomType, floor, locationId } = {}) {
        const where = { businessProfileId };
        if (status) where.status = status;
        if (roomType) where.roomType = roomType;
        if (floor !== undefined) where.floor = floor;
        if (locationId) where.locationId = locationId;

        return this.prisma.hotelRoom.findMany({
            where,
            orderBy: [{ floor: 'asc' }, { roomNumber: 'asc' }],
        });
    }

    async updateRoomStatus(roomId, status, notes) {
        await scopedRoom(this.prisma, roomId);
        return this.prisma.hotelRoom.update({
            where: { id: roomId },
            data: { status, notes },
        });
    }

    async getRoomRack(businessProfileId, date) {
        // Room rack = all rooms with their reservation status for a given date
        const rooms = await this.prisma.hotelRoom.findMany({
            where: { businessProfileId },
            orderBy: [{ floor: 'asc' }, { roomNumber: 'asc' }],
        });

        const targetDate = new Date(date);
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        const reservations = await this.prisma.reservation.findMany({
            where: {
                businessProfileId,
                status: { in: ['CONFIRMED', 'CHECKED_IN', 'PENDING'] },
                startDatetime: { lte: nextDay },
                endDatetime: { gt: targetDate },
            },
            include: { customer: { select: { username: true } } },
        });

        return rooms.map(room => {
            const reservation = reservations.find(r => r.serviceItemId === room.id);
            return {
                ...room,
                reservation: reservation || null,
                isOccupied: !!reservation,
                guestName: reservation?.customer?.username || reservation?.customerName || null,
            };
        });
    }

    // ═══ HOUSEKEEPING ═══════════════════════════════════════════════════════

    async generateHousekeepingTask(reservationId) {
        const reservation = await this.prisma.reservation.findUnique({
            where: { id: reservationId },
            include: { businessProfile: true },
        });
        if (!reservation) throw new Error('Reservation not found.');
        if (!reservation.serviceItemId) throw new Error('Reservation has no room assigned.');

        const existing = await this.prisma.hotelHousekeepingTask.findFirst({
            where: {
                roomId: reservation.serviceItemId,
                status: { in: ['PENDING', 'IN_PROGRESS'] },
            },
        });
        if (existing) return existing;

        const defaultItems = [
            { task: 'Strip & remake beds', done: false },
            { task: 'Clean bathroom & restock amenities', done: false },
            { task: 'Vacuum/sweep floor', done: false },
            { task: 'Dust surfaces & furniture', done: false },
            { task: 'Empty trash & replace liners', done: false },
            { task: 'Check mini-bar & restock', done: false },
            { task: 'Replace towels', done: false },
        ];

        const task = await this.prisma.hotelHousekeepingTask.create({
            data: {
                businessProfileId: reservation.businessProfileId,
                roomId: reservation.serviceItemId,
                reservationId,
                taskType: 'CHECKOUT_CLEAN',
                priority: 5,
                checklistItems: defaultItems,
            },
        });

        await this.prisma.hotelRoom.update({
            where: { id: reservation.serviceItemId },
            data: { status: 'CLEANING' },
        });

        return task;
    }

    async assignHousekeepingTask(taskId, employeeId) {
        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });
        if (!employee) throw new Error('Employee not found.');
        if (employee.role !== 'HOUSEKEEPER' && employee.role !== 'MANAGER' && employee.role !== 'SUPERVISOR') {
            throw new Error('Only housekeepers, supervisors, or managers can be assigned.');
        }

        return this.prisma.hotelHousekeepingTask.update({
            where: { id: taskId },
            data: {
                employeeId: employeeId,
                userId: employee.userId,
                status: 'IN_PROGRESS',
                startedAt: new Date(),
            },
        });
    }

    async updateChecklist(taskId, itemIndex, done) {
        const task = await this.prisma.hotelHousekeepingTask.findUnique({
            where: { id: taskId },
        });
        if (!task) throw new Error('Task not found.');

        const checklist = [...task.checklistItems];
        if (itemIndex >= 0 && itemIndex < checklist.length) {
            checklist[itemIndex] = { ...checklist[itemIndex], done };
        }

        const allDone = checklist.every(item => item.done);

        return this.prisma.hotelHousekeepingTask.update({
            where: { id: taskId },
            data: {
                checklistItems: checklist,
                ...(allDone && { status: 'COMPLETED', completedAt: new Date() }),
            },
        });
    }

    async completeHousekeeping(taskId, { photoProofUrl, notes }) {
        const task = await this.prisma.hotelHousekeepingTask.findUnique({
            where: { id: taskId },
        });
        if (!task) throw new Error('Task not found.');

        const updated = await this.prisma.hotelHousekeepingTask.update({
            where: { id: taskId },
            data: {
                status: 'COMPLETED',
                completedAt: new Date(),
                afterPhotoUrl: photoProofUrl,
                description: notes,
            },
        });

        await this.prisma.hotelRoom.update({
            where: { id: task.roomId },
            data: { status: 'AVAILABLE' },
        });

        return updated;
    }

    async inspectHousekeeping(taskId, { passed, inspectorId, notes }) {
        const task = await this.prisma.hotelHousekeepingTask.findUnique({
            where: { id: taskId },
        });
        if (!task) throw new Error('Task not found.');

        const newStatus = passed ? 'INSPECTED' : 'FAILED';

        const updated = await this.prisma.hotelHousekeepingTask.update({
            where: { id: taskId },
            data: {
                status: newStatus,
                userId: inspectorId,
                inspectedAt: new Date(),
                inspectionNote: notes,
                inspectionPassed: passed,
            },
        });

        if (!passed) {
            await this.prisma.hotelHousekeepingTask.update({
                where: { id: taskId },
                data: { status: 'IN_PROGRESS' },
            });
        }

        return updated;
    }

    async getHousekeepingBoard(businessProfileId) {
        const [pending, inProgress, completed, inspected, failed] = await Promise.all([
            this.prisma.hotelHousekeepingTask.findMany({
                where: { businessProfileId, status: 'PENDING' },
                include: { room: true },
                orderBy: { createdAt: 'asc' },
            }),
            this.prisma.hotelHousekeepingTask.findMany({
                where: { businessProfileId, status: 'IN_PROGRESS' },
                include: { room: true, employee: { include: { user: { select: { username: true } } } } },
                orderBy: { startedAt: 'asc' },
            }),
            this.prisma.hotelHousekeepingTask.findMany({
                where: { businessProfileId, status: 'COMPLETED' },
                include: { room: true, employee: { include: { user: { select: { username: true } } } } },
                orderBy: { completedAt: 'desc' },
                take: 20,
            }),
            this.prisma.hotelHousekeepingTask.findMany({
                where: { businessProfileId, status: 'INSPECTED' },
                include: { room: true },
                orderBy: { inspectedAt: 'desc' },
                take: 20,
            }),
            this.prisma.hotelHousekeepingTask.findMany({
                where: { businessProfileId, status: 'FAILED' },
                include: { room: true },
                orderBy: { inspectedAt: 'desc' },
            }),
        ]);

        return { pending, inProgress, completed, inspected, failed };
    }

    // ═══ FRONT DESK ═════════════════════════════════════════════════════════

    async getFrontDeskOverview(businessProfileId, date) {
        const targetDate = new Date(date);
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        const [arrivals, departures, inHouse, available] = await Promise.all([
            this.prisma.reservation.findMany({
                where: {
                    businessProfileId,
                    status: { in: ['CONFIRMED', 'PENDING'] },
                    startDatetime: { gte: targetDate, lt: nextDay },
                },
                include: {
                    customer: { select: { username: true, email: true } },
                },
                orderBy: { startDatetime: 'asc' },
            }),
            this.prisma.reservation.findMany({
                where: {
                    businessProfileId,
                    status: 'CHECKED_IN',
                    endDatetime: { gte: targetDate, lt: nextDay },
                },
                include: {
                    customer: { select: { username: true, email: true } },
                },
                orderBy: { endDatetime: 'asc' },
            }),
            this.prisma.reservation.findMany({
                where: {
                    businessProfileId,
                    status: 'CHECKED_IN',
                },
                include: {
                    customer: { select: { username: true, email: true } },
                },
                orderBy: { startDatetime: 'asc' },
            }),
            this.prisma.hotelRoom.count({
                where: { businessProfileId, status: 'AVAILABLE' },
            }),
        ]);

        const allReservations = [...arrivals, ...departures, ...inHouse];
        const productIds = [...new Set(allReservations.map(r => r.serviceItemId).filter(Boolean))];
        const products = productIds.length > 0
            ? await this.prisma.businessProduct.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } })
            : [];
        const productMap = Object.fromEntries(products.map(p => [p.id, p.name]));
        const enrich = (list) => list.map(r => ({
            ...r,
            room: r.serviceItemId
                ? { roomNumber: productMap[r.serviceItemId] || '—', roomType: '—' }
                : null,
        }));

        return {
            date: targetDate,
            arrivals: arrivals.length,
            departures: departures.length,
            inHouse: inHouse.length,
            availableRooms: available,
            arrivalList: enrich(arrivals),
            departureList: enrich(departures),
            inHouseList: enrich(inHouse),
        };
    }
}

module.exports = { HotelOpsService };

// ═══ RATE OVERRIDES ═════════════════════════════════════════════════════════

HotelOpsService.prototype.getRateCalendar = async function(businessProfileId, days = 14) {
    const today = new Date(); today.setHours(0,0,0,0);
    const end = new Date(today); end.setDate(end.getDate() + days);

    const [rooms, overrides] = await Promise.all([
        this.prisma.hotelRoom.findMany({
            where: { businessProfileId },
            select: { roomType: true, basePriceUsdc: true, weekendPriceUsdc: true },
            distinct: ['roomType'],
        }),
        this.prisma.hotelRateOverride.findMany({
            where: { businessProfileId, date: { gte: today, lt: end } },
        }),
    ]);

    const dates = [];
    for (let d = new Date(today); d < end; d.setDate(d.getDate() + 1)) {
        dates.push(new Date(d).toISOString().split('T')[0]);
    }

    const roomTypes = [...new Set(rooms.map(r => r.roomType).filter(Boolean))];
    const baseMap = Object.fromEntries(rooms.map(r => [r.roomType, { base: r.basePriceUsdc, weekend: r.weekendPriceUsdc }]));

    const calendar = dates.map(date => {
        const dow = new Date(date).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const cells = {};
        roomTypes.forEach(rt => {
            const override = overrides.find(o => o.date.toISOString().split('T')[0] === date && (o.roomType === rt || o.roomType === null));
            const base = baseMap[rt];
            cells[rt] = {
                price: override ? override.priceUsdc : (isWeekend && base?.weekend ? base.weekend : base?.base),
                hasOverride: !!override,
                overrideNote: override?.note || null,
                overrideId: override?.id || null,
            };
        });
        return { date, isWeekend, cells };
    });

    return { roomTypes, calendar };
};

HotelOpsService.prototype.upsertRateOverride = async function(businessProfileId, { roomType, date, priceUsdc, note }) {
    const dateObj = new Date(date);
    const existing = await this.prisma.hotelRateOverride.findFirst({
        where: { businessProfileId, roomType: roomType || null, roomId: null, date: dateObj },
    });
    if (existing) {
        return this.prisma.hotelRateOverride.update({
            where: { id: existing.id },
            data: { priceUsdc: parseFloat(priceUsdc), note },
        });
    }
    return this.prisma.hotelRateOverride.create({
        data: { businessProfileId, roomType: roomType || null, date: dateObj, priceUsdc: parseFloat(priceUsdc), note },
    });
};

HotelOpsService.prototype.deleteRateOverride = async function(overrideId) {
    const businessProfileId = await businessScope(this.prisma);
    const where = { id: overrideId };
    if (businessProfileId) where.businessProfileId = businessProfileId;
    const existing = await this.prisma.hotelRateOverride.findFirst({ where });
    if (!existing) throw new Error('Rate override not found.');
    return this.prisma.hotelRateOverride.delete({ where: { id: existing.id } });
};

HotelOpsService.prototype.blockRoom = async function(roomId, { startDate, endDate, reason }) {
    await scopedRoom(this.prisma, roomId);
    return this.prisma.hotelRoomBlock.create({
        data: { roomId, startDate: new Date(startDate), endDate: new Date(endDate), reason },
    });
};

HotelOpsService.prototype.deleteRoomBlock = async function(blockId) {
    const { block } = await scopedRoomBlock(this.prisma, blockId);
    return this.prisma.hotelRoomBlock.delete({ where: { id: block.id } });
};

HotelOpsService.prototype.createWalkIn = async function(businessProfileId, { guestName, phone, roomId, nights, depositUsdc, notes, customerId }) {
    const { room } = await scopedRoom(this.prisma, roomId, businessProfileId);
    if (room.status !== 'AVAILABLE') throw new Error('Room is not available');

    if (!customerId) {
        throw new Error('Walk-in guest must be linked to an Azaman customer account.');
    }

    const startDatetime = new Date();
    const endDatetime = new Date(startDatetime);
    endDatetime.setDate(endDatetime.getDate() + (parseInt(nights) || 1));

    const reservation = await this.prisma.reservation.create({
        data: {
            businessProfileId,
            serviceItemId: roomId,
            customerId: parseInt(customerId, 10),
            customerNotes: `Guest: ${guestName || 'Guest'}. Phone: ${phone || 'N/A'}. ${notes || ''}`.trim(),
            status: 'CHECKED_IN',
            startDatetime,
            endDatetime,
            depositUsdc: depositUsdc ? parseFloat(depositUsdc) : 0,
            amountUsdc: Number(room.basePriceUsdc) * (parseInt(nights) || 1),
        },
    });

    await this.prisma.hotelRoom.update({
        where: { id: roomId },
        data: {
            status: 'OCCUPIED',
            currentReservationId: reservation.id,
            checkedInAt: new Date(),
            checkoutDueAt: endDatetime,
        },
    });

    return reservation;
};

HotelOpsService.prototype.moveRoom = async function(reservationId, { newRoomId, reason }) {
    const businessProfileId = await businessScope(this.prisma);
    const reservationWhere = { id: reservationId };
    if (businessProfileId) reservationWhere.businessProfileId = businessProfileId;

    const reservation = await this.prisma.reservation.findFirst({ where: reservationWhere });
    if (!reservation) throw new Error('Reservation not found');
    const oldRoomId = reservation.serviceItemId;

    const { room: newRoom } = await scopedRoom(this.prisma, newRoomId, businessProfileId);
    if (newRoom.status !== 'AVAILABLE') throw new Error('New room is not available');

    await this.prisma.$transaction(async (tx) => {
        await tx.reservation.update({
            where: { id: reservationId },
            data: {
                serviceItemId: newRoomId,
                businessNotes: reason ? `Room moved from ${oldRoomId || 'unassigned'}: ${reason}` : undefined,
            },
        });
        if (oldRoomId) {
            await tx.hotelRoom.update({
                where: { id: oldRoomId },
                data: { status: 'DIRTY', currentReservationId: null },
            });
        }
        await tx.hotelRoom.update({
            where: { id: newRoomId },
            data: {
                status: 'OCCUPIED',
                currentReservationId: reservationId,
                checkedInAt: reservation.checkedInAt || new Date(),
                checkoutDueAt: reservation.endDatetime,
            },
        });
    });

    return { ok: true };
};

HotelOpsService.prototype.bulkCreateRooms = async function(businessProfileId, { startNumber, endNumber, roomType, floor, basePrice, weekendPrice, capacity, locationId }) {
    const rooms = [];
    const start = parseInt(startNumber);
    const end = parseInt(endNumber);
    for (let n = start; n <= end; n++) {
        rooms.push({
            businessProfileId,
            locationId: locationId || null,
            roomNumber: String(n),
            roomType: roomType || 'STANDARD',
            floor: floor ? parseInt(floor) : null,
            basePriceUsdc: parseFloat(basePrice) || 0,
            weekendPriceUsdc: weekendPrice ? parseFloat(weekendPrice) : null,
            capacity: parseInt(capacity) || 2,
            status: 'AVAILABLE',
        });
    }
    return this.prisma.hotelRoom.createMany({ data: rooms, skipDuplicates: true });
};

HotelOpsService.prototype.updateRoom = async function(roomId, data) {
    await scopedRoom(this.prisma, roomId);
    const allowed = ['roomNumber', 'roomType', 'floor', 'capacity', 'bedConfig', 'basePriceUsdc', 'weekendPriceUsdc', 'amenities', 'notes', 'status'];
    const update = {};
    allowed.forEach(k => { if (data[k] !== undefined) update[k] = data[k]; });
    if (data.basePrice !== undefined) update.basePriceUsdc = parseFloat(data.basePrice);
    if (data.weekendPrice !== undefined) update.weekendPriceUsdc = parseFloat(data.weekendPrice);
    return this.prisma.hotelRoom.update({ where: { id: roomId }, data: update });
};
