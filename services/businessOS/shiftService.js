// 📁 services/businessOS/shiftService.js
// services/businessOS/shiftService.js
// =============================================================================
// Shift Management Service — scheduling, clock in/out, rotations, swaps,
// and team view ("who's on now / who's next").
// =============================================================================

class ShiftService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ── Create Shift ───────────────────────────────────────────────────────
    async createShift({ businessProfileId, employeeId, shiftDate, startTime, endTime, locationId, breakMinutes = 30, shiftLabel, rotationId, notes }) {
        // Verify employee belongs to this business
        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });
        if (!employee || employee.businessProfileId !== businessProfileId) {
            throw new Error('Employee not found in this business.');
        }
        if (employee.status !== 'ACTIVE') {
            throw new Error('Cannot schedule an inactive employee.');
        }

        // Check for conflicting shifts (same date, overlapping time)
        const existing = await this.prisma.shift.findFirst({
            where: {
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

        return this.prisma.shift.create({
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
    }

    // ── Bulk Create Shifts (for rotation scheduling) ───────────────────────
    async createShiftRotation({ businessProfileId, employeeIds, startDate, endDate, rotationPattern, locationId, shiftLabel, breakMinutes = 30 }) {
        // rotationPattern: array of { employeeId, date, startTime, endTime }
        // This allows creating a full week/month of shifts for multiple employees
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
        const shift = await this.prisma.shift.findUnique({
            where: { id: shiftId },
            include: { employee: true },
        });
        if (!shift) throw new Error('Shift not found.');
        if (shift.status === 'CLOCKED_IN') throw new Error('Already clocked in.');
        if (shift.status === 'CLOCKED_OUT') throw new Error('Shift already completed.');
        if (shift.status === 'NO_SHOW') throw new Error('Shift marked as no-show.');

        const now = new Date();
        const isLate = now > new Date(shift.startTime);
        const lateMinutes = isLate
            ? Math.round((now - new Date(shift.startTime)) / (1000 * 60))
            : 0;

        const updated = await this.prisma.shift.update({
            where: { id: shiftId },
            data: {
                status: isLate ? 'LATE' : 'CLOCKED_IN',
                clockInTime: now,
                isLate,
                lateMinutes,
            },
        });

        // Update employee late count
        if (isLate) {
            await this.prisma.businessEmployee.update({
                where: { id: shift.employeeId },
                data: { lateCount: { increment: 1 } },
            });
        }

        return updated;
    }

    // ── Clock Out ──────────────────────────────────────────────────────────
    async clockOut(shiftId) {
        const shift = await this.prisma.shift.findUnique({
            where: { id: shiftId },
            include: { employee: true },
        });
        if (!shift) throw new Error('Shift not found.');
        if (shift.status !== 'CLOCKED_IN' && shift.status !== 'LATE') {
            throw new Error('Must be clocked in to clock out.');
        }

        const now = new Date();
        const clockInTime = new Date(shift.clockInTime);
        const actualMinutes = Math.round((now - clockInTime) / (1000 * 60));
        const workedHours = Math.max(0, (actualMinutes - shift.breakMinutes) / 60);

        const updated = await this.prisma.shift.update({
            where: { id: shiftId },
            data: {
                status: 'CLOCKED_OUT',
                clockOutTime: now,
                actualMinutes,
            },
        });

        // Update employee stats
        await this.prisma.businessEmployee.update({
            where: { id: shift.employeeId },
            data: {
                totalShifts: { increment: 1 },
                totalHours: { increment: workedHours },
            },
        });

        // Update accrued wages
        const employee = shift.employee;
        let accrued = 0;
        if (employee.payrollType === 'HOURLY' && employee.hourlyRate) {
            accrued = workedHours * parseFloat(employee.hourlyRate);
        } else if (employee.payrollType === 'SALARY' && employee.salaryAmount) {
            const hourlyEquivalent = parseFloat(employee.salaryAmount) / 160;
            accrued = workedHours * hourlyEquivalent;
        }

        if (accrued > 0) {
            await this.prisma.businessEmployee.update({
                where: { id: shift.employeeId },
                data: {
                    accruedWages: { increment: accrued },
                },
            });
        }

        return { shift: updated, workedHours, accruedThisShift: accrued };
    }

    // ── Mark No-Show ───────────────────────────────────────────────────────
    async markNoShow(shiftId) {
        const shift = await this.prisma.shift.findUnique({
            where: { id: shiftId },
            include: { employee: true },
        });
        if (!shift) throw new Error('Shift not found.');
        if (shift.status !== 'SCHEDULED') {
            throw new Error('Can only mark SCHEDULED shifts as no-show.');
        }

        // Check if shift end time has passed
        if (new Date() < new Date(shift.endTime)) {
            throw new Error('Cannot mark no-show before shift ends.');
        }

        const updated = await this.prisma.shift.update({
            where: { id: shiftId },
            data: { status: 'NO_SHOW' },
        });

        await this.prisma.businessEmployee.update({
            where: { id: shift.employeeId },
            data: { noShowCount: { increment: 1 } },
        });

        return updated;
    }

    // ── Get Shifts for a Business (date range) ─────────────────────────────
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

    // ── Get Employee Schedule ──────────────────────────────────────────────
    async getEmployeeSchedule(employeeId, { startDate, endDate } = {}) {
        const where = { employeeId };
        if (startDate && endDate) {
            where.shiftDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        return this.prisma.shift.findMany({
            where,
            orderBy: { startTime: 'asc' },
        });
    }

    // ── Get User Schedule (for worker sub-portal) ──────────────────────────
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

    // ── Get Team On Duty ───────────────────────────────────────────────────
    async getTeamOnDuty(businessProfileId) {
        return this.prisma.shift.findMany({
            where: {
                businessProfileId,
                status: 'CLOCKED_IN',
            },
            include: {
                employee: {
                    include: { user: { select: { username: true, email: true } } },
                },
            },
            orderBy: { clockInTime: 'asc' },
        });
    }

    // ── Get Upcoming Team (who's next) ─────────────────────────────────────
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

    // ── Update Shift ───────────────────────────────────────────────────────
    async updateShift(shiftId, updates) {
        const allowed = ['startTime', 'endTime', 'breakMinutes', 'shiftLabel', 'locationId', 'notes', 'status', 'rotationId'];
        const data = {};
        for (const key of allowed) {
            if (key in updates) {
                data[key] = updates[key] instanceof Date || typeof updates[key] === 'string'
                    ? (key === 'startTime' || key === 'endTime' ? new Date(updates[key]) : updates[key])
                    : updates[key];
            }
        }
        return this.prisma.shift.update({ where: { id: shiftId }, data });
    }

    // ── Delete Shift ───────────────────────────────────────────────────────
    async deleteShift(shiftId) {
        // Check if shift is active
        const shift = await this.prisma.shift.findUnique({ where: { id: shiftId } });
        if (!shift) throw new Error('Shift not found.');
        if (shift.status === 'CLOCKED_IN') throw new Error('Cannot delete an active shift.');

        return this.prisma.shift.delete({ where: { id: shiftId } });
    }

    // ── Shift Swaps ────────────────────────────────────────────────────────
    async requestShiftSwap({ businessProfileId, shiftId, requestingEmployeeId, reason }) {
        const shift = await this.prisma.shift.findUnique({
            where: { id: shiftId },
        });
        if (!shift) throw new Error('Shift not found.');
        if (shift.status !== 'SCHEDULED') throw new Error('Can only swap scheduled shifts.');

        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: requestingEmployeeId },
        });
        if (!employee) throw new Error('Employee not found.');

        return this.prisma.shiftSwap.create({
            data: {
                businessProfileId,
                requestingShiftId: shiftId,
                requestingEmployeeId,
                requestingUserId: employee.userId,
                reason,
            },
        });
    }

    async claimShiftSwap({ swapId, claimingEmployeeId, claimingShiftId }) {
        const swap = await this.prisma.shiftSwap.findUnique({
            where: { id: swapId },
        });
        if (!swap) throw new Error('Swap request not found.');
        if (swap.status !== 'PENDING') throw new Error('Swap is no longer pending.');

        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: claimingEmployeeId },
        });
        if (!employee) throw new Error('Employee not found.');

        return this.prisma.shiftSwap.update({
            where: { id: swapId },
            data: {
                claimingEmployeeId,
                claimingUserId: employee.userId,
                claimingShiftId,
            },
        });
    }

    async approveShiftSwap(swapId, managerNote) {
        const swap = await this.prisma.shiftSwap.findUnique({
            where: { id: swapId },
            include: { requestingShift: true, claimingShift: true },
        });
        if (!swap) throw new Error('Swap not found.');
        if (swap.status !== 'PENDING') throw new Error('Swap is no longer pending.');
        if (!swap.claimingEmployeeId) throw new Error('No employee has claimed this swap yet.');

        // Swap the employees on the shifts
        const origShift = swap.requestingShift;
        const claimShift = swap.claimingShift;

        // Update the original shift to the claiming employee
        await this.prisma.shift.update({
            where: { id: origShift.id },
            data: { employeeId: swap.claimingEmployeeId, userId: swap.claimingUserId },
        });

        // If there's a claiming shift, update it to the requesting employee
        if (claimShift) {
            await this.prisma.shift.update({
                where: { id: claimShift.id },
                data: { employeeId: swap.requestingEmployeeId, userId: swap.requestingUserId },
            });
        }

        return this.prisma.shiftSwap.update({
            where: { id: swapId },
            data: {
                status: 'APPROVED',
                managerNote,
                respondedAt: new Date(),
            },
        });
    }

    async rejectShiftSwap(swapId, managerNote) {
        return this.prisma.shiftSwap.update({
            where: { id: swapId },
            data: {
                status: 'REJECTED',
                managerNote,
                respondedAt: new Date(),
            },
        });
    }

    async getShiftSwaps(businessProfileId, { status } = {}) {
        const where = { businessProfileId };
        if (status) where.status = status;

        return this.prisma.shiftSwap.findMany({
            where,
            include: {
                requestingShift: true,
                claimingShift: true,
                requestingEmployee: {
                    include: { user: { select: { username: true } } },
                },
                claimingEmployee: {
                    include: { user: { select: { username: true } } },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }
}

module.exports = { ShiftService };
