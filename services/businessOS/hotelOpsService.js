// 📁 services/businessOS/hotelOpsService.js
// services/businessOS/hotelOpsService.js
// =============================================================================
// Hotel Operations Service — room management, housekeeping Kanban,
// and front desk (arrivals, departures, in-house guests).
// =============================================================================

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
        const room = await this.prisma.hotelRoom.findUnique({ where: { id: roomId } });
        if (!room) throw new Error('Room not found.');

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

        // Get all active reservations for this date
        const reservations = await this.prisma.reservation.findMany({
            where: {
                businessProfileId,
                status: { in: ['CONFIRMED', 'CHECKED_IN', 'PENDING'] },
                startDatetime: { lte: nextDay },
                endDatetime: { gt: targetDate },
            },
        });

        // Map rooms to their reservation status
        return rooms.map(room => {
            const reservation = reservations.find(r => r.serviceItemId === room.id);
            return {
                ...room,
                reservation: reservation || null,
                isOccupied: !!reservation,
                guestName: reservation?.customerName || null,
            };
        });
    }

    // ═══ HOUSEKEEPING ═══════════════════════════════════════════════════════

    // Auto-generate housekeeping task on checkout
    async generateHousekeepingTask(reservationId) {
        const reservation = await this.prisma.reservation.findUnique({
            where: { id: reservationId },
            include: { businessProfile: true },
        });
        if (!reservation) throw new Error('Reservation not found.');
        if (!reservation.serviceItemId) throw new Error('Reservation has no room assigned.');

        // Check if there's already a pending task for this room
        const existing = await this.prisma.hotelHousekeepingTask.findFirst({
            where: {
                roomId: reservation.serviceItemId,
                status: { in: ['PENDING', 'IN_PROGRESS'] },
            },
        });
        if (existing) return existing;

        // Generate task items based on room type
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

        // Set room to CLEANING
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

        // Set room back to AVAILABLE
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

        // If failed, reopen the task
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
            // Arrivals: reservations starting today (status CONFIRMED or PENDING)
            this.prisma.reservation.findMany({
                where: {
                    businessProfileId,
                    status: { in: ['CONFIRMED', 'PENDING'] },
                    startDatetime: { gte: targetDate, lt: nextDay },
                },
                include: {
                    serviceItem: { select: { name: true } },
                    customer: { select: { username: true, email: true } },
                },
                orderBy: { startDatetime: 'asc' },
            }),
            // Departures: reservations ending today (status CHECKED_IN)
            this.prisma.reservation.findMany({
                where: {
                    businessProfileId,
                    status: 'CHECKED_IN',
                    endDatetime: { gte: targetDate, lt: nextDay },
                },
                include: {
                    serviceItem: { select: { name: true } },
                    customer: { select: { username: true, email: true } },
                },
                orderBy: { endDatetime: 'asc' },
            }),
            // In-house: currently checked-in guests
            this.prisma.reservation.findMany({
                where: {
                    businessProfileId,
                    status: 'CHECKED_IN',
                },
                include: {
                    serviceItem: { select: { name: true } },
                    customer: { select: { username: true, email: true } },
                },
                orderBy: { startDatetime: 'asc' },
            }),
            // Available rooms
            this.prisma.hotelRoom.count({
                where: { businessProfileId, status: 'AVAILABLE' },
            }),
        ]);

        return {
            date: targetDate,
            arrivals: arrivals.length,
            departures: departures.length,
            inHouse: inHouse.length,
            availableRooms: available,
            arrivalList: arrivals,
            departureList: departures,
            inHouseList: inHouse,
        };
    }
}

module.exports = { HotelOpsService };

