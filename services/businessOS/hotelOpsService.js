// 📁 services/businessOS/hotelOpsService.js
// services/businessOS/hotelOpsService.js
// =============================================================================
// Hotel Operations Service — room management, housekeeping Kanban,
// and front desk (arrivals, departures, in-house guests).
// =============================================================================

const { Prisma } = require('@prisma/client');
const { randomBytes } = require('crypto');

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

    async updateRoomStatus(roomId, status, notes, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const room = await this.prisma.hotelRoom.findFirst({ where: { id: roomId, businessProfileId }, select: { id: true } });
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
    async generateHousekeepingTask(reservationId, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const reservation = await this.prisma.reservation.findFirst({
            where: { id: reservationId, businessProfileId },
            include: { businessProfile: true },
        });
        if (!reservation) throw new Error('Reservation not found.');
        if (!reservation.serviceItemId) throw new Error('Reservation has no room assigned.');

        const room = await this.prisma.hotelRoom.findFirst({
            where: { id: reservation.serviceItemId, businessProfileId },
            select: { id: true },
        });
        if (!room) throw new Error('Reservation room not found for this business.');

        // Check if there's already a pending task for this room
        const existing = await this.prisma.hotelHousekeepingTask.findFirst({
            where: {
                roomId: reservation.serviceItemId,
                businessProfileId,
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
                businessProfileId,
                roomId: reservation.serviceItemId,
                reservationId,
                taskType: 'CHECKOUT_CLEAN',
                priority: 5,
                checklistItems: defaultItems,
            },
        });

        // Set room to CLEANING
        await this.prisma.hotelRoom.update({
            where: { id: room.id },
            data: { status: 'CLEANING' },
        });

        return task;
    }

    async assignHousekeepingTask(taskId, employeeId, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const employee = await this.prisma.businessEmployee.findFirst({
            where: { id: employeeId, businessProfileId },
        });
        if (!employee) throw new Error('Employee not found.');
        if (employee.role !== 'HOUSEKEEPER' && employee.role !== 'MANAGER' && employee.role !== 'SUPERVISOR') {
            throw new Error('Only housekeepers, supervisors, or managers can be assigned.');
        }

        const task = await this.prisma.hotelHousekeepingTask.findFirst({
            where: { id: taskId, businessProfileId },
            select: { id: true },
        });
        if (!task) throw new Error('Task not found.');

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

    async updateChecklist(taskId, itemIndex, done, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const task = await this.prisma.hotelHousekeepingTask.findFirst({
            where: { id: taskId, businessProfileId },
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

    async completeHousekeeping(taskId, { photoProofUrl, notes }, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const task = await this.prisma.hotelHousekeepingTask.findFirst({
            where: { id: taskId, businessProfileId },
        });
        if (!task) throw new Error('Task not found.');

        const room = await this.prisma.hotelRoom.findFirst({ where: { id: task.roomId, businessProfileId }, select: { id: true } });
        if (!room) throw new Error('Task room not found for this business.');

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
            where: { id: room.id },
            data: { status: 'AVAILABLE' },
        });

        return updated;
    }

    async inspectHousekeeping(taskId, { passed, inspectorId, notes }, businessProfileId) {
        if (!businessProfileId) throw new Error('Business profile context is required.');
        const task = await this.prisma.hotelHousekeepingTask.findFirst({
            where: { id: taskId, businessProfileId },
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
                    customer: { select: { username: true, email: true } },
                },
                orderBy: { startDatetime: 'asc' },
            }),
            // Available rooms
            this.prisma.hotelRoom.count({
                where: { businessProfileId, status: 'AVAILABLE' },
            }),
        ]);

        // Enrich from the authoritative HotelRoom inventory, not legacy BusinessProduct rows.
        const allReservations = [...arrivals, ...departures, ...inHouse];
        const roomIds = [...new Set(allReservations.map(r => r.serviceItemId).filter(Boolean))];
        const rooms = roomIds.length > 0
            ? await this.prisma.hotelRoom.findMany({
                where: { id: { in: roomIds }, businessProfileId },
                select: { id: true, roomNumber: true, roomType: true, floor: true, status: true },
            })
            : [];
        const roomMap = Object.fromEntries(rooms.map(r => [r.id, r]));
        const enrich = (list) => list.map(r => ({
            ...r,
            room: r.serviceItemId ? (roomMap[r.serviceItemId] || null) : null,
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


// ═══ RATE OVERRIDES (injected at module level) ═════════════════════════════

// Temporarily patching the class — will be clean in next refactor

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

HotelOpsService.prototype.deleteRateOverride = async function(overrideId, businessProfileId) {
    if (!businessProfileId) throw new Error('Business profile context is required.');
    const existing = await this.prisma.hotelRateOverride.findFirst({ where: { id: overrideId, businessProfileId }, select: { id: true } });
    if (!existing) throw new Error('Rate override not found.');
    return this.prisma.hotelRateOverride.delete({ where: { id: overrideId } });
};

HotelOpsService.prototype.blockRoom = async function(roomId, { startDate, endDate, reason }, businessProfileId) {
    if (!businessProfileId) throw new Error('Business profile context is required.');
    const room = await this.prisma.hotelRoom.findFirst({ where: { id: roomId, businessProfileId }, select: { id: true } });
    if (!room) throw new Error('Room not found.');
    return this.prisma.hotelRoomBlock.create({
        data: { roomId, startDate: new Date(startDate), endDate: new Date(endDate), reason },
    });
};

HotelOpsService.prototype.deleteRoomBlock = async function(blockId, businessProfileId) {
    if (!businessProfileId) throw new Error('Business profile context is required.');
    const block = await this.prisma.hotelRoomBlock.findFirst({ where: { id: blockId, room: { businessProfileId } }, select: { id: true } });
    if (!block) throw new Error('Room block not found.');
    return this.prisma.hotelRoomBlock.delete({ where: { id: blockId } });
};

HotelOpsService.prototype.createWalkIn = async function(businessProfileId, { customerId, phone, roomId, nights, depositUsdc, notes }) {
    if (!businessProfileId) throw new Error('Business profile context is required.');
    if (!customerId) throw new Error('A registered Azaman customer is required for a walk-in booking.');
    const [room, customer] = await Promise.all([
        this.prisma.hotelRoom.findFirst({ where: { id: roomId, businessProfileId } }),
        this.prisma.user.findUnique({ where: { id: customerId }, select: { id: true } }),
    ]);
    if (!room) throw new Error('Room not found');
    if (!customer) throw new Error('Customer not found.');
    if (room.status !== 'AVAILABLE') throw new Error('Room is not available');

    const startDatetime = new Date();
    const endDatetime = new Date(startDatetime);
    endDatetime.setDate(endDatetime.getDate() + (parseInt(nights) || 1));

    return this.prisma.$transaction(async (tx) => {
        const reservation = await tx.reservation.create({
            data: {
                reservationRef: `RES-${randomBytes(8).toString('hex').toUpperCase()}`,
                businessProfileId,
                serviceItemId: roomId,
                customerId,
                customerNotes: `Phone: ${phone || 'N/A'}. ${notes || ''}`.trim(),
                status: 'CHECKED_IN',
                startDatetime,
                endDatetime,
                depositUsdc: depositUsdc ? new Prisma.Decimal(depositUsdc) : new Prisma.Decimal(0),
                amountUsdc: new Prisma.Decimal(room.basePriceUsdc).mul(Math.max(1, parseInt(nights, 10) || 1)),
                metadata: { channel: 'FRONT_DESK', phone },
            },
        });

        await tx.hotelRoom.update({
            where: { id: roomId },
            data: {
                status: 'OCCUPIED',
                currentReservationId: reservation.id,
                checkedInAt: new Date(),
                checkoutDueAt: endDatetime,
            },
        });

        return reservation;
    });
};

const MOVE_ROOM_RETRY_LIMIT = 3;
const isPgConflict = (error) => error?.code === 'P2034' || error?.code === 'P2028';

HotelOpsService.prototype.moveRoom = async function(reservationId, { newRoomId, reason }, businessProfileId) {
    // r33/Wave1.2 — room-move concurrency authority.
    //
    // The previous implementation read the reservation, its current room, and
    // the target-room availability OUTSIDE the transaction, then wrote inside
    // it. Two concurrent moves of the same reservation (A→B and A→C) could
    // both capture the same stale oldRoomId and both "succeed": the
    // reservation ended pointing at C while B stayed OCCUPIED with
    // currentReservationId pointing at a reservation that no longer owned it.
    //
    // The database is now the authority, inside one transaction at the
    // default (READ COMMITTED) isolation — deliberately NOT Serializable:
    // the r31 capacity trigger evaluates availability against COMMITTED data
    // behind a transaction-scoped business advisory lock, and a Serializable
    // snapshot would make that evaluation read stale pre-race state (SSI does
    // not reliably abort such trigger/ advisory-lock patterns). Under READ
    // COMMITTED every statement below re-reads committed truth:
    //   1. The reservation is read inside the transaction (authoritative
    //      current room + business scope).
    //   2. The reservation move is a CAS FIRST: updateMany on
    //      { id, businessProfileId, serviceItemId: oldRoomId } — if a
    //      concurrent mover already changed the room, this returns 0 and the
    //      whole move rolls back. The r31 capacity trigger evaluates the move
    //      at this instant: the target room must still be AVAILABLE and the
    //      interval unclaimed, or the trigger refuses the move itself.
    //   3. The target room is then CLAIMED with a conditional updateMany on
    //      { id, businessProfileId, status: 'AVAILABLE' } — only one racer can
    //      turn the claim; the loser gets count 0 and rolls back completely
    //      (including its reservation CAS).
    //   4. The old-room cleanup is conditional on the room actually being
    //      held by THIS reservation ({ currentReservationId: reservationId }),
    //      so it can never release a room some other reservation has claimed.
    // Every losing or failing path rolls back to the exact prior state.
    if (!businessProfileId) throw new Error('Business profile context is required.');
    if (!newRoomId || typeof newRoomId !== 'string') throw new Error('A target room id is required.');

    // Fail-fast scope guard before opening the transaction: a reservation in
    // another business is indistinguishable from a nonexistent one and is
    // rejected here without holding a connection. The authoritative read
    // below (inside the transaction) re-verifies this against committed truth,
    // so this pre-read can never widen authority — it only short-circuits.
    const reservationExists = await this.prisma.reservation.findFirst({
        where: { id: reservationId, businessProfileId },
        select: { id: true },
    });
    if (!reservationExists) throw new Error('Reservation not found');

    // The origin room observed on the FIRST attempt is pinned across
    // serialization retries. A retry may only proceed while the reservation
    // still holds that same room; if a concurrent mover already relocated it,
    // the retry's CAS matches nothing and the move fails with an explicit
    // conflict instead of silently re-targeting the guest (A→C must never
    // degrade into B→C after losing a race to A→B).
    let pinnedOriginRoomId;

    for (let attempt = 0; attempt < MOVE_ROOM_RETRY_LIMIT; attempt += 1) {
        try {
            return await this.prisma.$transaction(async (tx) => {
                // 1. Authoritative reservation read — inside the transaction.
                const reservation = await tx.reservation.findFirst({
                    where: { id: reservationId, businessProfileId },
                });
                if (!reservation) throw new Error('Reservation not found');
                const originRoomId = pinnedOriginRoomId ?? reservation.serviceItemId;
                if (originRoomId === newRoomId) {
                    throw new Error('Reservation is already assigned to this room.');
                }
                if (pinnedOriginRoomId !== undefined && reservation.serviceItemId !== pinnedOriginRoomId) {
                    // A concurrent mover relocated the reservation between
                    // attempts; this request's origin assumption is stale.
                    throw new Error('Reservation was moved concurrently; retry the move.');
                }
                pinnedOriginRoomId = originRoomId;

                // Friendly pre-validation of the target room inside the
                // transaction. The r31 capacity trigger on the CAS below
                // remains the authoritative availability check — this read
                // only produces an accurate error message.
                const targetRoom = await tx.hotelRoom.findFirst({
                    where: { id: newRoomId, businessProfileId },
                    select: { status: true },
                });
                if (!targetRoom) throw new Error('New room not found');
                if (targetRoom.status !== 'AVAILABLE') throw new Error('New room is not available');

                // 2. CAS the reservation move FIRST: it must still own
                //    originRoomId. This statement is what the r31 capacity
                //    trigger evaluates — the target room must still be
                //    AVAILABLE and interval-unclaimed at this instant, which
                //    is exactly the availability contract the trigger owns.
                const moved = await tx.reservation.updateMany({
                    where: { id: reservationId, businessProfileId, serviceItemId: originRoomId },
                    data: {
                        serviceItemId: newRoomId,
                        metadata: { ...(reservation.metadata || {}), movedFrom: originRoomId, moveReason: reason },
                    },
                });
                if (moved.count === 0) {
                    throw new Error('Reservation was moved concurrently; retry the move.');
                }

                // 3. Race-safe target-room claim: this business's room, and
                //    still AVAILABLE, or the claim fails and rolls back (the
                //    reservation CAS above rolls back with it).
                const claim = await tx.hotelRoom.updateMany({
                    where: { id: newRoomId, businessProfileId, status: 'AVAILABLE' },
                    data: {
                        status: 'OCCUPIED',
                        currentReservationId: reservationId,
                        checkedInAt: reservation.checkedInAt || new Date(),
                        checkoutDueAt: reservation.endDatetime,
                    },
                });
                if (claim.count === 0) throw new Error('New room is not available');

                // 4. Old-room cleanup — only if this reservation actually
                //    holds it (authoritative currentReservationId).
                if (originRoomId) {
                    await tx.hotelRoom.updateMany({
                        where: { id: originRoomId, businessProfileId, currentReservationId: reservationId },
                        data: { status: 'DIRTY', currentReservationId: null },
                    });
                }

                const updatedReservation = await tx.reservation.findUnique({
                    where: { id: reservationId },
                });
                return { ok: true, reservation: updatedReservation };
            });
        } catch (error) {
            if (!isPgConflict(error) || attempt === MOVE_ROOM_RETRY_LIMIT - 1) {
                throw error;
            }
            // Serialization conflict — the database asked us to look again.
        }
    }
    throw new Error('Room move failed after retries.');
};

HotelOpsService.prototype.bulkCreateRooms = async function(businessProfileId, { startNumber, endNumber, roomType, floor, basePrice, weekendPrice, capacity, locationId }) {
    if (!businessProfileId) throw new Error('Business profile context is required.');
    const start = Number.parseInt(startNumber, 10);
    const end = Number.parseInt(endNumber, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error('A valid room number range is required.');
    }
    if (end - start + 1 > 500) {
        throw new Error('Bulk room creation is limited to 500 rooms at a time.');
    }
    if (locationId) {
        const location = await this.prisma.businessLocation.findFirst({
            where: { id: locationId, businessProfileId },
            select: { id: true },
        });
        if (!location) throw new Error('Location not found for this business.');
    }
    const rooms = [];
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

HotelOpsService.prototype.updateRoom = async function(roomId, data, businessProfileId) {
    // r32 audit item B + r33/Wave1.1 — tenant-scoped room metadata authority.
    // Lifecycle state (status) is deliberately NOT patchable here: room state
    // transitions belong exclusively to the dedicated updateRoomStatus
    // authority.
    //
    // r33/Wave1.1: the AUTHORITY is the mutation itself. The update is
    // tenant-constrained via updateMany on { id, businessProfileId } — a
    // concurrent business-context swap between the pre-check read and the
    // write, or any caller-supplied business id, cannot make this statement
    // touch another business's room. The pre-check read remains only to
    // produce an accurate "not found" error.
    if (!businessProfileId) throw new Error('Business profile context is required.');
    if (data.status !== undefined) {
        throw new Error('Room status cannot be set through generic room updates; use the room status authority.');
    }
    const room = await this.prisma.hotelRoom.findFirst({
        where: { id: roomId, businessProfileId },
        select: { id: true },
    });
    if (!room) throw new Error('Room not found.');

    const allowed = ['roomNumber', 'roomType', 'floor', 'capacity', 'bedConfig', 'basePriceUsdc', 'weekendPriceUsdc', 'amenities', 'notes'];
    const update = {};
    allowed.forEach(k => { if (data[k] !== undefined) update[k] = data[k]; });
    if (data.basePrice) update.basePriceUsdc = parseFloat(data.basePrice);
    if (data.weekendPrice) update.weekendPriceUsdc = parseFloat(data.weekendPrice);

    // Tenant-constrained mutation: exactly this business's room or nothing.
    const result = await this.prisma.hotelRoom.updateMany({
        where: { id: roomId, businessProfileId },
        data: update,
    });
    if (result.count === 0) throw new Error('Room not found.');

    return this.prisma.hotelRoom.findFirst({
        where: { id: roomId, businessProfileId },
    });
};

