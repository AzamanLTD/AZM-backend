// 📁 services/businessOS/shiftService.js
// services/businessOS/shiftService.js
// =============================================================================
// Shift Management Service — scheduling, clock in/out, rotations, swaps,
// and team view ("who's on now / who's next").
// =============================================================================

const { getBusinessRequestContext } = require('../../src/lib/businessRequestContext');

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;

const isSerializableConflict = (error) => error?.code === 'P2034';

const waitForSerializableRetry = (attempt) => new Promise((resolve) => {
    setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt));
});

class ShiftService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    _getBusinessContext() {
        const context = getBusinessRequestContext();
        if (!context?.businessProfileId) {
            throw new Error('Business scope is required for this mutation.');
        }
        return context;
    }

    _assertActorCanOperateEmployee(employeeUserId, context) {
        if (context.isAdmin || context.isBusinessOwner) return;
        if (String(employeeUserId) !== String(context.userId)) {
            throw new Error('You can only perform this action for your own employee record.');
        }
    }

    // ── Scheduling mutation boundary ────────────────────────────────────────
    // createShift/updateShift serialize on a transaction-scoped PostgreSQL
    // advisory lock scoped to ONE employee's schedule, so concurrent create /
    // update / create-vs-update calls cannot both observe a conflict-free
    // schedule. Same pattern as businessTaxPresetService / orderTracking
    // mutation-safe services. Acquired through `tx` only — held until commit.
    async _lockEmployeeSchedule(tx, employeeId) {
        // pg_advisory_xact_lock() returns void, which Prisma's query engine
        // cannot deserialize in either $queryRaw form (CI-proven failure).
        // Selecting a constant FROM the lock function yields a real int column
        // while still acquiring the lock inside the transaction.
        await tx.$queryRawUnsafe(
            'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))',
            'business_shift_schedule:' + String(employeeId),
        );
    }

    // ── Create Shift ───────────────────────────────────────────────────────
    async createShift({ businessProfileId, employeeId, shiftDate, startTime, endTime, locationId, breakMinutes = 30, shiftLabel, rotationId, notes }) {
        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });
        if (!employee || employee.businessProfileId !== businessProfileId) {
            throw new Error('Employee not found in this business.');
        }
        if (employee.status !== 'ACTIVE') {
            throw new Error('Cannot schedule an inactive employee.');
        }

        // Conflict check + insert in ONE serialized transaction. The
        // read-then-write shape below could race two concurrent createShift
        // calls into both observing a conflict-free schedule; the advisory
        // lock plus in-transaction check closes that window.
        return this.prisma.$transaction(async (tx) => {
            await this._lockEmployeeSchedule(tx, employeeId);

            const existing = await tx.shift.findFirst({
                where: {
                    businessProfileId,
                    employeeId,
                    shiftDate: new Date(shiftDate),
                    status: { in: ['SCHEDULED', 'CLOCKED_IN', 'LATE'] },
                    startTime: { lt: new Date(endTime) },
                    endTime: { gt: new Date(startTime) },
                },
            });
            if (existing) {
                throw new Error('Employee already has a conflicting shift at this time.');
            }

            return tx.shift.create({
                data: {
                    businessProfileId,
                    employeeId,
                    userId: employee.userId,
                    locationId,
                    shiftDate: new Date(shiftDate),
                    startTime: new Date(startTime),
                    endTime: new Date(endTime),
                    breakMinutes,
                    shiftLabel,
                    rotationId,
                    notes,
                },
                include: {
                    employee: {
                        include: { user: { select: { username: true } } },
                    },
                },
            });
        });
    }

    async createShiftRotation({ businessProfileId, employeeIds, startDate, endDate, rotationPattern, locationId, shiftLabel, breakMinutes = 30 }) {
        const shifts = [];
        for (const pattern of rotationPattern) {
            const shift = await this.createShift({
                businessProfileId,
                employeeId: pattern.employeeId,
                shiftDate: pattern.date,
                startTime: pattern.startTime,
                endTime: pattern.endTime,
                locationId,
                breakMinutes,
                shiftLabel: pattern.label || shiftLabel,
                rotationId: pattern.rotationId,
            });
            shifts.push(shift);
        }
        return shifts;
    }

    // ── Clock In ───────────────────────────────────────────────────────────
    async clockIn(shiftId) {
        const context = this._getBusinessContext();
        const shift = await this.prisma.shift.findFirst({
            where: { id: shiftId, businessProfileId: context.businessProfileId },
            include: { employee: true },
        });
        if (!shift) throw new Error('Shift not found.');
        this._assertActorCanOperateEmployee(shift.employee.userId, context);
        if (shift.status === 'CLOCKED_IN' || shift.status === 'LATE') throw new Error('Already clocked in.');
        if (shift.status === 'CLOCKED_OUT') throw new Error('Shift already completed.');
        if (shift.status === 'NO_SHOW') throw new Error('Shift marked as no-show.');

        const now = new Date();
        const isLate = now > new Date(shift.startTime);
        const lateMinutes = isLate
            ? Math.round((now - new Date(shift.startTime)) / 60000)
            : 0;

        return this.prisma.$transaction(async (tx) => {
            const transitioned = await tx.shift.updateMany({
                where: {
                    id: shiftId,
                    businessProfileId: context.businessProfileId,
                    status: 'SCHEDULED',
                },
                data: {
                    status: isLate ? 'LATE' : 'CLOCKED_IN',
                    clockInTime: now,
                    isLate,
                    lateMinutes,
                },
            });
            if (transitioned.count !== 1) throw new Error('Shift was already resolved or clocked in.');

            if (isLate) {
                await tx.businessEmployee.update({
                    where: { id: shift.employeeId },
                    data: { lateCount: { increment: 1 } },
                });
            }

            return tx.shift.findUnique({ where: { id: shiftId } });
        });
    }

    // ── Clock Out ──────────────────────────────────────────────────────────
    async clockOut(shiftId) {
        const context = this._getBusinessContext();
        return this.prisma.$transaction(async (tx) => {
            const shift = await tx.shift.findFirst({
                where: { id: shiftId, businessProfileId: context.businessProfileId },
                include: { employee: true },
            });
            if (!shift) throw new Error('Shift not found.');
            this._assertActorCanOperateEmployee(shift.employee.userId, context);
            if (shift.status !== 'CLOCKED_IN' && shift.status !== 'LATE') {
                throw new Error('Must be clocked in to clock out.');
            }

            const now = new Date();
            const actualMinutes = Math.round((now - new Date(shift.clockInTime)) / 60000);
            const workedHours = Math.max(0, (actualMinutes - shift.breakMinutes) / 60);

            const closed = await tx.shift.updateMany({
                where: {
                    id: shiftId,
                    businessProfileId: context.businessProfileId,
                    status: { in: ['CLOCKED_IN', 'LATE'] },
                },
                data: {
                    status: 'CLOCKED_OUT',
                    clockOutTime: now,
                    actualMinutes,
                },
            });
            if (closed.count !== 1) throw new Error('Shift was already clocked out.');

            const employee = shift.employee;
            let accrued = 0;
            if (employee.payrollType === 'HOURLY' && employee.hourlyRate) {
                accrued = workedHours * parseFloat(employee.hourlyRate);
            } else if (employee.payrollType === 'SALARY' && employee.salaryAmount) {
                accrued = workedHours * (parseFloat(employee.salaryAmount) / 160);
            }

            await tx.businessEmployee.update({
                where: { id: shift.employeeId },
                data: {
                    totalShifts: { increment: 1 },
                    totalHours: { increment: workedHours },
                    ...(accrued > 0 ? { accruedWages: { increment: accrued } } : {}),
                },
            });

            const updated = await tx.shift.findUnique({ where: { id: shiftId } });
            return { shift: updated, workedHours, accruedThisShift: accrued };
        });
    }

    // ── Mark No-Show ───────────────────────────────────────────────────────
    async markNoShow(shiftId) {
        const context = this._getBusinessContext();
        if (!context.isAdmin && !context.isBusinessOwner) {
            throw new Error('Only a business owner or administrator can mark a no-show.');
        }

        return this.prisma.$transaction(async (tx) => {
            const shift = await tx.shift.findFirst({
                where: { id: shiftId, businessProfileId: context.businessProfileId },
                include: { employee: true },
            });
            if (!shift) throw new Error('Shift not found.');
            if (shift.status !== 'SCHEDULED') throw new Error('Can only mark SCHEDULED shifts as no-show.');
            if (new Date() < new Date(shift.endTime)) throw new Error('Cannot mark no-show before shift ends.');

            const updated = await tx.shift.updateMany({
                where: { id: shiftId, businessProfileId: context.businessProfileId, status: 'SCHEDULED' },
                data: { status: 'NO_SHOW' },
            });
            if (updated.count !== 1) throw new Error('Shift was already resolved.');

            await tx.businessEmployee.update({
                where: { id: shift.employeeId },
                data: { noShowCount: { increment: 1 } },
            });

            return tx.shift.findUnique({ where: { id: shiftId } });
        });
    }

    async getShifts(businessProfileId, { startDate, endDate, employeeId, status, locationId } = {}) {
        const where = { businessProfileId };
        if (startDate && endDate) {
            where.shiftDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }
        if (employeeId) where.employeeId = employeeId;
        if (status) where.status = status;
        if (locationId) where.locationId = locationId;

        return this.prisma.shift.findMany({
            where,
            include: {
                employee: {
                    include: { user: { select: { username: true, email: true } } },
                },
            },
            orderBy: { startTime: 'asc' },
        });
    }

    async getEmployeeSchedule(employeeId, { startDate, endDate } = {}) {
        const where = { employeeId };
        if (startDate && endDate) {
            where.shiftDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }
        return this.prisma.shift.findMany({ where, orderBy: { startTime: 'asc' } });
    }

    async getUserSchedule(userId, { startDate, endDate } = {}) {
        const where = { userId };
        if (startDate && endDate) {
            where.shiftDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }
        return this.prisma.shift.findMany({
            where,
            include: {
                employee: {
                    include: {
                        businessProfile: { select: { businessName: true, logoUrl: true } },
                    },
                },
            },
            orderBy: { startTime: 'asc' },
        });
    }

    async getTeamOnDuty(businessProfileId) {
        return this.prisma.shift.findMany({
            where: {
                businessProfileId,
                status: { in: ['CLOCKED_IN', 'LATE'] },
            },
            include: {
                employee: {
                    include: { user: { select: { username: true, email: true } } },
                },
            },
            orderBy: { clockInTime: 'asc' },
        });
    }

    async getUpcomingTeam(businessProfileId) {
        const now = new Date();
        return this.prisma.shift.findMany({
            where: {
                businessProfileId,
                status: 'SCHEDULED',
                shiftDate: { gte: now },
            },
            include: {
                employee: {
                    include: { user: { select: { username: true, email: true } } },
                },
            },
            orderBy: { startTime: 'asc' },
            take: 20,
        });
    }

    async updateShift(shiftId, updates) {
        const context = this._getBusinessContext();
        if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
            throw new Error('Shift status must be changed through the clock-in, clock-out, or no-show actions.');
        }
        const allowed = ['startTime', 'endTime', 'breakMinutes', 'shiftLabel', 'locationId', 'notes', 'rotationId'];
        const data = {};
        for (const key of allowed) {
            if (key in updates) {
                data[key] = updates[key] instanceof Date || typeof updates[key] === 'string'
                    ? (key === 'startTime' || key === 'endTime' ? new Date(updates[key]) : updates[key])
                    : updates[key];
            }
        }
        return this.prisma.$transaction(async (tx) => {
            const existing = await tx.shift.findFirst({
                where: { id: shiftId, businessProfileId: context.businessProfileId },
                select: { id: true, employeeId: true, startTime: true, endTime: true },
            });
            if (!existing) throw new Error('Shift not found.');

            const changesTime = 'startTime' in data || 'endTime' in data;
            if (changesTime) {
                // Serialize against createShift and other time-changing
                // updateShift calls for this employee, then check the overlap
                // INSIDE the transaction — never from a pre-read snapshot.
                await this._lockEmployeeSchedule(tx, existing.employeeId);

                const candidateStart = data.startTime instanceof Date ? data.startTime : existing.startTime;
                const candidateEnd   = data.endTime   instanceof Date ? data.endTime   : existing.endTime;

                const conflict = await tx.shift.findFirst({
                    where: {
                        id:    { not: shiftId },
                        businessProfileId: context.businessProfileId,
                        employeeId: existing.employeeId,
                        status: { in: ['SCHEDULED', 'CLOCKED_IN', 'LATE'] },
                        startTime: { lt: candidateEnd },
                        endTime:   { gt: candidateStart },
                    },
                    select: { id: true },
                });
                if (conflict) {
                    throw new Error('Employee already has a conflicting shift at this time.');
                }
            }

            return tx.shift.update({ where: { id: shiftId }, data });
        });
    }

    async deleteShift(shiftId) {
        const context = this._getBusinessContext();
        // Guarded delete: the NOT-active status predicate is part of the
        // DELETE itself, so a stale SCHEDULED read can never authorize
        // deleting a shift that a concurrent clockIn() activated between the
        // check and the delete. (No scheduling lock is taken here — clockIn()
        // does not participate in that lock namespace, so the conditional
        // delete is the actual authority against it.)
        return this.prisma.$transaction(async (tx) => {
            const deleted = await tx.shift.deleteMany({
                where: {
                    id: shiftId,
                    businessProfileId: context.businessProfileId,
                    status: { notIn: ['CLOCKED_IN', 'LATE'] },
                },
            });
            if (deleted.count !== 1) {
                const current = await tx.shift.findFirst({
                    where: { id: shiftId, businessProfileId: context.businessProfileId },
                    select: { status: true },
                });
                if (!current) throw new Error('Shift not found.');
                throw new Error('Cannot delete an active shift.');
            }
            // deleteMany does not return the row; keep the historical response
            // shape (the deleted shift's data) without re-reading a gone row.
            return null;
        });
    }

    // ── Shift Swaps ────────────────────────────────────────────────────────
    async requestShiftSwap({ businessProfileId, shiftId, requestingEmployeeId, reason }) {
        const context = this._getBusinessContext();
        if (businessProfileId !== context.businessProfileId) {
            throw new Error('Shift swap business scope mismatch.');
        }

        const shift = await this.prisma.shift.findFirst({
            where: { id: shiftId, businessProfileId: context.businessProfileId },
        });
        if (!shift) throw new Error('Shift not found.');
        if (shift.status !== 'SCHEDULED') throw new Error('Can only swap scheduled shifts.');

        const employee = await this.prisma.businessEmployee.findFirst({
            where: { id: requestingEmployeeId, businessProfileId: context.businessProfileId },
        });
        if (!employee) throw new Error('Employee not found in this business.');
        this._assertActorCanOperateEmployee(employee.userId, context);
        if (employee.id !== shift.employeeId) throw new Error('Only the employee assigned to the shift can request its swap.');

        return this.prisma.shiftSwap.create({
            data: {
                businessProfileId: context.businessProfileId,
                requestingShiftId: shiftId,
                requestingEmployeeId,
                requestingUserId: employee.userId,
                reason,
            },
        });
    }

    async claimShiftSwap({ swapId, claimingEmployeeId, claimingShiftId }) {
        const context = this._getBusinessContext();
        return this.prisma.$transaction(async (tx) => {
            const swap = await tx.shiftSwap.findFirst({
                where: { id: swapId, businessProfileId: context.businessProfileId },
            });
            if (!swap) throw new Error('Swap request not found.');
            if (swap.status !== 'PENDING' && swap.status !== 'OPEN') throw new Error('Swap is no longer pending.');

            const employee = await tx.businessEmployee.findFirst({
                where: { id: claimingEmployeeId, businessProfileId: context.businessProfileId },
            });
            if (!employee) throw new Error('Employee not found in this business.');
            this._assertActorCanOperateEmployee(employee.userId, context);

            if (claimingShiftId) {
                const claimingShift = await tx.shift.findFirst({
                    where: {
                        id: claimingShiftId,
                        businessProfileId: context.businessProfileId,
                        employeeId: employee.id,
                        status: 'SCHEDULED',
                    },
                });
                if (!claimingShift) throw new Error('Claiming shift not found in this business.');
            }

            const claimed = await tx.shiftSwap.updateMany({
                where: {
                    id: swapId,
                    businessProfileId: context.businessProfileId,
                    status: { in: ['PENDING', 'OPEN'] },
                },
                data: { claimingEmployeeId, claimingUserId: employee.userId, claimingShiftId },
            });
            if (claimed.count !== 1) throw new Error('Swap is no longer pending.');
            return tx.shiftSwap.findUnique({ where: { id: swapId } });
        });
    }

    async approveShiftSwap(swapId, managerNote) {
        const context = this._getBusinessContext();

        for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
            try {
                return await this.prisma.$transaction(async (tx) => {
                    const swap = await tx.shiftSwap.findFirst({
                        where: { id: swapId, businessProfileId: context.businessProfileId },
                        include: { requestingShift: true, claimingShift: true },
                    });
                    if (!swap) throw new Error('Swap not found.');
                    if (swap.status !== 'PENDING' && swap.status !== 'OPEN') throw new Error('Swap is no longer pending.');
                    if (!swap.claimingEmployeeId) throw new Error('No employee has claimed this swap yet.');

                    const origShift = swap.requestingShift;
                    const claimShift = swap.claimingShift;
                    if (!origShift || origShift.businessProfileId !== context.businessProfileId) {
                        throw new Error('Original shift not found in this business.');
                    }
                    if (claimShift && claimShift.businessProfileId !== context.businessProfileId) {
                        throw new Error('Claiming shift not found in this business.');
                    }

                    const claimedEmployee = await tx.businessEmployee.findFirst({
                        where: { id: swap.claimingEmployeeId, businessProfileId: context.businessProfileId },
                        select: { id: true, userId: true, status: true },
                    });
                    const requestingEmployee = await tx.businessEmployee.findFirst({
                        where: { id: swap.requestingEmployeeId, businessProfileId: context.businessProfileId },
                        select: { id: true, userId: true, status: true },
                    });
                    if (!claimedEmployee || !requestingEmployee) throw new Error('Swap employee is not part of this business.');
                    if (claimedEmployee.status !== 'ACTIVE' || requestingEmployee.status !== 'ACTIVE') {
                        throw new Error('Both employees must be active to approve a swap.');
                    }
                    if (origShift.employeeId !== requestingEmployee.id) {
                        throw new Error('The requested shift assignment changed before approval.');
                    }
                    if (claimShift && claimShift.employeeId !== claimedEmployee.id) {
                        throw new Error('The claiming shift assignment changed before approval.');
                    }
                    if (claimShift && claimShift.status !== 'SCHEDULED') {
                        throw new Error('The claiming shift must still be scheduled.');
                    }

                    await tx.shift.update({
                        where: { id: origShift.id },
                        data: { employeeId: claimedEmployee.id, userId: claimedEmployee.userId },
                    });

                    if (claimShift) {
                        await tx.shift.update({
                            where: { id: claimShift.id },
                            data: { employeeId: requestingEmployee.id, userId: requestingEmployee.userId },
                        });
                    }

                    const finalized = await tx.shiftSwap.updateMany({
                        where: {
                            id: swapId,
                            businessProfileId: context.businessProfileId,
                            status: { in: ['PENDING', 'OPEN'] },
                        },
                        data: { status: 'APPROVED', managerNote, respondedAt: new Date() },
                    });
                    if (finalized.count !== 1) throw new Error('Swap was already resolved.');
                    return tx.shiftSwap.findUnique({ where: { id: swapId } });
                }, { isolationLevel: 'Serializable' });
            } catch (error) {
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) {
                    throw error;
                }
                await waitForSerializableRetry(attempt);
            }
        }

        throw new Error('Shift swap approval failed after retries.');
    }

    async rejectShiftSwap(swapId, managerNote) {
        const context = this._getBusinessContext();
        const result = await this.prisma.shiftSwap.updateMany({
            where: {
                id: swapId,
                businessProfileId: context.businessProfileId,
                status: { in: ['PENDING', 'OPEN'] },
            },
            data: { status: 'REJECTED', managerNote, respondedAt: new Date() },
        });
        if (result.count !== 1) throw new Error('Swap not found or already resolved.');
        return this.prisma.shiftSwap.findUnique({ where: { id: swapId } });
    }

    async getShiftSwaps(businessProfileId, { status } = {}) {
        const where = { businessProfileId };
        if (status) where.status = status;
        return this.prisma.shiftSwap.findMany({
            where,
            include: {
                requestingShift: true,
                claimingShift: true,
                requestingEmployee: { include: { user: { select: { username: true } } } },
                claimingEmployee: { include: { user: { select: { username: true } } } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }
}

module.exports = { ShiftService };