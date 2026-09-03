const { ShiftService } = require('./shiftService');

/**
 * Production-safe shift mutations.
 *
 * ShiftService retains the established query/read contract. These overrides
 * make attendance and swap state transitions conditional and transactional so
 * concurrent requests cannot apply the same mutation twice.
 */
class AtomicShiftService extends ShiftService {
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
        const lateMinutes = isLate ? Math.round((now - new Date(shift.startTime)) / 60000) : 0;

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
                data: { status: 'CLOCKED_OUT', clockOutTime: now, actualMinutes },
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
}

module.exports = { AtomicShiftService };
