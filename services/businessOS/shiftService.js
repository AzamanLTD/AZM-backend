// 📁 services/businessOS/shiftService.js
// services/businessOS/shiftService.js
// =============================================================================
// Shift Management Service — scheduling, clock in/out, rotations, swaps,
// and team view ("who's on now / who's next").
// =============================================================================

const { getRequestContext } = require('../../utils/requestContext');

class ShiftService {
    constructor(prisma) { this.prisma = prisma; }

    async _resolveCallerBusinessProfileId(explicitBusinessProfileId) {
        if (explicitBusinessProfileId) return explicitBusinessProfileId;
        const req = getRequestContext();
        if (req?.businessProfileId) return req.businessProfileId;
        if (!req?.user?.id) return null;

        const ownedBusiness = await this.prisma.businessProfile.findFirst({ where: { userId: req.user.id }, select: { id: true } });
        if (ownedBusiness?.id) return ownedBusiness.id;

        const employee = await this.prisma.businessEmployee.findFirst({
            where: { userId: req.user.id, status: 'ACTIVE' },
            select: { businessProfileId: true },
        });
        return employee?.businessProfileId || null;
    }

    async _assertShiftAccess(shift, explicitBusinessProfileId) {
        if (!shift) throw new Error('Shift not found.');
        const callerBusinessProfileId = await this._resolveCallerBusinessProfileId(explicitBusinessProfileId);
        if (callerBusinessProfileId) {
            if (shift.businessProfileId !== callerBusinessProfileId) throw new Error('Shift not found.');
            return;
        }
        const req = getRequestContext();
        if (!req?.user?.id || shift.userId !== req.user.id) throw new Error('Shift not found.');
    }

    async createShift({ businessProfileId, employeeId, shiftDate, startTime, endTime, locationId, breakMinutes = 30, shiftLabel, rotationId, notes }) {
        const employee = await this.prisma.businessEmployee.findUnique({ where: { id: employeeId } });
        if (!employee || employee.businessProfileId !== businessProfileId) throw new Error('Employee not found in this business.');
        if (employee.status !== 'ACTIVE') throw new Error('Cannot schedule an inactive employee.');
        const existing = await this.prisma.shift.findFirst({ where: { employeeId, shiftDate: new Date(shiftDate), status: { in: ['SCHEDULED', 'CLOCKED_IN', 'LATE'] }, startTime: { lt: new Date(endTime) }, endTime: { gt: new Date(startTime) } } });
        if (existing) throw new Error('Employee already has a conflicting shift at this time.');
        return this.prisma.shift.create({ data: { businessProfileId, employeeId, userId: employee.userId, locationId, shiftDate: new Date(shiftDate), startTime: new Date(startTime), endTime: new Date(endTime), breakMinutes, shiftLabel, rotationId, notes }, include: { employee: { include: { user: { select: { username: true } } } } } });
    }

    async createShiftRotation({ businessProfileId, employeeIds, startDate, endDate, rotationPattern, locationId, shiftLabel, breakMinutes = 30 }) {
        const shifts = [];
        for (const pattern of rotationPattern) shifts.push(await this.createShift({ businessProfileId, employeeId: pattern.employeeId, shiftDate: pattern.date, startTime: pattern.startTime, endTime: pattern.endTime, locationId, breakMinutes, shiftLabel: pattern.label || shiftLabel, rotationId: pattern.rotationId }));
        return shifts;
    }

    async clockIn(shiftId, businessProfileId) {
        const shift = await this.prisma.shift.findUnique({ where: { id: shiftId }, include: { employee: true } });
        await this._assertShiftAccess(shift, businessProfileId);
        if (shift.status === 'CLOCKED_IN') throw new Error('Already clocked in.');
        if (shift.status === 'CLOCKED_OUT') throw new Error('Shift already completed.');
        if (shift.status === 'NO_SHOW') throw new Error('Shift marked as no-show.');
        const now = new Date();
        const isLate = now > new Date(shift.startTime);
        const lateMinutes = isLate ? Math.round((now - new Date(shift.startTime)) / (1000 * 60)) : 0;
        const updated = await this.prisma.shift.update({ where: { id: shiftId }, data: { status: isLate ? 'LATE' : 'CLOCKED_IN', clockInTime: now, isLate, lateMinutes } });
        if (isLate) await this.prisma.businessEmployee.update({ where: { id: shift.employeeId }, data: { lateCount: { increment: 1 } } });
        return updated;
    }

    async clockOut(shiftId, businessProfileId) {
        const shift = await this.prisma.shift.findUnique({ where: { id: shiftId }, include: { employee: true } });
        await this._assertShiftAccess(shift, businessProfileId);
        if (shift.status !== 'CLOCKED_IN' && shift.status !== 'LATE') throw new Error('Must be clocked in to clock out.');
        const now = new Date();
        const clockInTime = new Date(shift.clockInTime);
        const actualMinutes = Math.round((now - clockInTime) / (1000 * 60));
        const workedHours = Math.max(0, (actualMinutes - shift.breakMinutes) / 60);
        const updated = await this.prisma.shift.update({ where: { id: shiftId }, data: { status: 'CLOCKED_OUT', clockOutTime: now, actualMinutes } });
        await this.prisma.businessEmployee.update({ where: { id: shift.employeeId }, data: { totalShifts: { increment: 1 }, totalHours: { increment: workedHours } } });
        let accrued = 0;
        if (shift.employee.payrollType === 'HOURLY' && shift.employee.hourlyRate) accrued = workedHours * parseFloat(shift.employee.hourlyRate);
        else if (shift.employee.payrollType === 'SALARY' && shift.employee.salaryAmount) accrued = workedHours * (parseFloat(shift.employee.salaryAmount) / 160);
        if (accrued > 0) await this.prisma.businessEmployee.update({ where: { id: shift.employeeId }, data: { accruedWages: { increment: accrued } } });
        return { shift: updated, workedHours, accruedThisShift: accrued };
    }

    async markNoShow(shiftId, businessProfileId) {
        const shift = await this.prisma.shift.findUnique({ where: { id: shiftId }, include: { employee: true } });
        await this._assertShiftAccess(shift, businessProfileId);
        if (shift.status !== 'SCHEDULED') throw new Error('Can only mark SCHEDULED shifts as no-show.');
        if (new Date() < new Date(shift.endTime)) throw new Error('Cannot mark no-show before shift ends.');
        const updated = await this.prisma.shift.update({ where: { id: shiftId }, data: { status: 'NO_SHOW' } });
        await this.prisma.businessEmployee.update({ where: { id: shift.employeeId }, data: { noShowCount: { increment: 1 } } });
        return updated;
    }

    async getShifts(businessProfileId, { startDate, endDate, employeeId, status, locationId } = {}) {
        const where = { businessProfileId };
        if (startDate && endDate) where.shiftDate = { gte: new Date(startDate), lte: new Date(endDate) };
        if (employeeId) where.employeeId = employeeId;
        if (status) where.status = status;
        if (locationId) where.locationId = locationId;
        return this.prisma.shift.findMany({ where, include: { employee: { include: { user: { select: { username: true, email: true } } } } }, orderBy: { startTime: 'asc' } });
    }

    async getEmployeeSchedule(employeeId, { startDate, endDate, businessProfileId } = {}) {
        const where = { employeeId, ...(businessProfileId ? { businessProfileId } : {}) };
        if (startDate && endDate) where.shiftDate = { gte: new Date(startDate), lte: new Date(endDate) };
        return this.prisma.shift.findMany({ where, orderBy: { startTime: 'asc' } });
    }

    async getUserSchedule(userId, { startDate, endDate } = {}) {
        const where = { userId };
        if (startDate && endDate) where.shiftDate = { gte: new Date(startDate), lte: new Date(endDate) };
        return this.prisma.shift.findMany({ where, include: { employee: { include: { businessProfile: { select: { businessName: true, logoUrl: true } } } } }, orderBy: { startTime: 'asc' } });
    }

    async getTeamOnDuty(businessProfileId) { return this.prisma.shift.findMany({ where: { businessProfileId, status: 'CLOCKED_IN' }, include: { employee: { include: { user: { select: { username: true, email: true } } } } }, orderBy: { clockInTime: 'asc' } }); }
    async getUpcomingTeam(businessProfileId) { const now = new Date(); return this.prisma.shift.findMany({ where: { businessProfileId, status: 'SCHEDULED', shiftDate: { gte: now } }, include: { employee: { include: { user: { select: { username: true, email: true } } } } }, orderBy: { startTime: 'asc' }, take: 20 }); }

    async updateShift(shiftId, updates, businessProfileId) {
        const allowed = ['startTime', 'endTime', 'breakMinutes', 'shiftLabel', 'locationId', 'notes', 'status', 'rotationId'];
        const data = {};
        for (const key of allowed) if (key in updates) data[key] = updates[key] instanceof Date || typeof updates[key] === 'string' ? (key === 'startTime' || key === 'endTime' ? new Date(updates[key]) : updates[key]) : updates[key];
        const existing = await this.prisma.shift.findUnique({ where: { id: shiftId } });
        await this._assertShiftAccess(existing, businessProfileId);
        return this.prisma.shift.update({ where: { id: shiftId }, data });
    }

    async deleteShift(shiftId, businessProfileId) {
        const shift = await this.prisma.shift.findUnique({ where: { id: shiftId } });
        await this._assertShiftAccess(shift, businessProfileId);
        if (shift.status === 'CLOCKED_IN') throw new Error('Cannot delete an active shift.');
        return this.prisma.shift.delete({ where: { id: shiftId } });
    }

    async requestShiftSwap({ businessProfileId, shiftId, requestingEmployeeId, reason }) {
        const shift = await this.prisma.shift.findFirst({ where: { id: shiftId, businessProfileId } });
        if (!shift) throw new Error('Shift not found.');
        if (shift.status !== 'SCHEDULED') throw new Error('Can only swap scheduled shifts.');
        const employee = await this.prisma.businessEmployee.findFirst({ where: { id: requestingEmployeeId, businessProfileId, status: 'ACTIVE' } });
        if (!employee) throw new Error('Employee not found.');
        if (shift.employeeId !== requestingEmployeeId) throw new Error('You can only request a swap for your own shift.');
        return this.prisma.shiftSwap.create({ data: { businessProfileId, requestingShiftId: shiftId, requestingEmployeeId, requestingUserId: employee.userId, reason } });
    }

    async claimShiftSwap({ businessProfileId, swapId, claimingEmployeeId, claimingShiftId }) {
        const callerBusinessProfileId = await this._resolveCallerBusinessProfileId(businessProfileId);
        if (!callerBusinessProfileId) throw new Error('Business context required.');
        const swap = await this.prisma.shiftSwap.findFirst({ where: { id: swapId, businessProfileId: callerBusinessProfileId } });
        if (!swap) throw new Error('Swap request not found.');
        if (swap.status !== 'PENDING') throw new Error('Swap is no longer pending.');
        const employee = await this.prisma.businessEmployee.findFirst({ where: { id: claimingEmployeeId, businessProfileId: callerBusinessProfileId, status: 'ACTIVE' } });
        if (!employee) throw new Error('Employee not found.');
        const req = getRequestContext();
        const callerIsScopedBusinessOperator = Boolean(businessProfileId || req?.businessProfileId);
        if (!callerIsScopedBusinessOperator && employee.userId !== req?.user?.id) throw new Error('Only the claiming employee can claim this swap.');
        if (claimingShiftId) {
            const claimingShift = await this.prisma.shift.findFirst({ where: { id: claimingShiftId, businessProfileId: callerBusinessProfileId } });
            if (!claimingShift) throw new Error('Claiming shift not found in this business.');
            if (claimingShift.employeeId !== claimingEmployeeId) throw new Error('Claiming shift does not belong to claiming employee.');
            if (claimingShift.status !== 'SCHEDULED') throw new Error('Only scheduled shifts can be swapped.');
        }
        return this.prisma.shiftSwap.update({ where: { id: swapId }, data: { claimingEmployeeId, claimingUserId: employee.userId, claimingShiftId } });
    }

    async approveShiftSwap(businessProfileId, swapId, managerNote) {
        const callerBusinessProfileId = await this._resolveCallerBusinessProfileId(businessProfileId);
        if (!callerBusinessProfileId) throw new Error('Business context required.');
        return this.prisma.$transaction(async (tx) => {
            const swap = await tx.shiftSwap.findFirst({ where: { id: swapId, businessProfileId: callerBusinessProfileId }, include: { requestingShift: true, claimingShift: true } });
            if (!swap) throw new Error('Swap not found.');
            if (swap.status !== 'PENDING') throw new Error('Swap is no longer pending.');
            if (!swap.claimingEmployeeId) throw new Error('No employee has claimed this swap yet.');
            const origShift = swap.requestingShift;
            const claimShift = swap.claimingShift;
            if (!origShift || origShift.businessProfileId !== callerBusinessProfileId) throw new Error('Original shift is not in this business.');
            if (claimShift && claimShift.businessProfileId !== callerBusinessProfileId) throw new Error('Claiming shift is not in this business.');
            const claimingEmployee = await tx.businessEmployee.findFirst({ where: { id: swap.claimingEmployeeId, businessProfileId: callerBusinessProfileId, status: 'ACTIVE' } });
            if (!claimingEmployee) throw new Error('Claiming employee is not in this business.');
            const requestingEmployee = await tx.businessEmployee.findFirst({ where: { id: swap.requestingEmployeeId, businessProfileId: callerBusinessProfileId } });
            if (!requestingEmployee) throw new Error('Requesting employee is not in this business.');
            if (origShift.status !== 'SCHEDULED') throw new Error('Original shift is no longer available for swap.');
            if (claimShift && claimShift.status !== 'SCHEDULED') throw new Error('Claiming shift is no longer available for swap.');
            await tx.shift.update({ where: { id: origShift.id }, data: { employeeId: swap.claimingEmployeeId, userId: swap.claimingUserId } });
            if (claimShift) await tx.shift.update({ where: { id: claimShift.id }, data: { employeeId: swap.requestingEmployeeId, userId: swap.requestingUserId } });
            return tx.shiftSwap.update({ where: { id: swapId }, data: { status: 'APPROVED', managerNote, respondedAt: new Date() } });
        }, { isolationLevel: 'Serializable' });
    }

    async rejectShiftSwap(businessProfileId, swapId, managerNote) {
        const callerBusinessProfileId = await this._resolveCallerBusinessProfileId(businessProfileId);
        if (!callerBusinessProfileId) throw new Error('Business context required.');
        const result = await this.prisma.shiftSwap.updateMany({ where: { id: swapId, businessProfileId: callerBusinessProfileId, status: 'PENDING' }, data: { status: 'REJECTED', managerNote, respondedAt: new Date() } });
        if (!result.count) throw new Error('Swap not found or is no longer pending.');
        return this.prisma.shiftSwap.findUnique({ where: { id: swapId } });
    }

    async getShiftSwaps(businessProfileId, { status } = {}) {
        const where = { businessProfileId };
        if (status) where.status = status;
        return this.prisma.shiftSwap.findMany({ where, include: { requestingShift: true, claimingShift: true, requestingEmployee: { include: { user: { select: { username: true } } } }, claimingEmployee: { include: { user: { select: { username: true } } } } }, orderBy: { createdAt: 'desc' } });
    }
}

module.exports = { ShiftService };
