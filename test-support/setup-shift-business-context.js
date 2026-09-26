const { getBusinessRequestContext, runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');
const { ShiftService } = require('../services/businessOS/shiftService');

if (process.env.NODE_ENV === 'test' && process.env.TEST_DATABASE_URL) {
    const methods = [
        'clockIn',
        'clockOut',
        'markNoShow',
        'updateShift',
        'deleteShift',
        'claimShiftSwap',
        'approveShiftSwap',
        'rejectShiftSwap',
        'requestShiftSwap',
    ];

    for (const method of methods) {
        const original = ShiftService.prototype[method];
        if (!original || original.__businessContextCompatWrapped) continue;

        const wrapped = async function (...args) {
            if (getBusinessRequestContext()) return original.apply(this, args);

            const resolveTarget = async () => {
                if (method === 'requestShiftSwap') {
                    return { businessProfileId: args[0]?.businessProfileId || null };
                }
                if (method === 'claimShiftSwap') {
                    const swap = await this.prisma.shiftSwap.findUnique({
                        where: { id: args[0]?.swapId },
                        select: { businessProfileId: true },
                    });
                    return { businessProfileId: swap?.businessProfileId || null };
                }
                if (method === 'approveShiftSwap' || method === 'rejectShiftSwap') {
                    const swap = await this.prisma.shiftSwap.findUnique({
                        where: { id: args[0] },
                        include: { requestingShift: { select: { businessProfileId: true } } },
                    });
                    return { businessProfileId: swap?.businessProfileId || swap?.requestingShift?.businessProfileId || null };
                }

                const shift = await this.prisma.shift.findUnique({
                    where: { id: args[0] },
                    select: { businessProfileId: true, employee: { select: { userId: true } } },
                });
                return {
                    businessProfileId: shift?.businessProfileId || null,
                    targetUserId: shift?.employee?.userId || null,
                };
            };

            const target = await resolveTarget();
            if (!target.businessProfileId) return original.apply(this, args);

            return runWithBusinessRequestContext({
                userId: target.targetUserId || 101,
                businessProfileId: target.businessProfileId,
                isBusinessOwner: true,
                isAdmin: false,
                canManageShifts: true,
            }, () => original.apply(this, args));
        };

        wrapped.__businessContextCompatWrapped = true;
        ShiftService.prototype[method] = wrapped;
    }
}
