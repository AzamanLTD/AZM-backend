// 📁 services/businessOS/timeOffService.js
// services/businessOS/timeOffService.js
// =============================================================================
// Time-Off Request Service — sick, vacation, personal, emergency, unpaid.
// =============================================================================

class TimeOffService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    async requestTimeOff({ businessProfileId, employeeId, type, startDate, endDate, reason, supportingDocUrl }) {
        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });
        if (!employee) throw new Error('Employee not found.');
        if (employee.businessProfileId !== businessProfileId) {
            throw new Error('Employee does not belong to this business.');
        }

        const days = Math.ceil(
            (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)
        ) + 1;

        return this.prisma.timeOffRequest.create({
            data: {
                businessProfileId,
                employeeId,
                type,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                days,
                reason,
                supportingDocUrl,
            },
        });
    }

    async approveTimeOff(requestId, approverId, managerNote) {
        const request = await this.prisma.timeOffRequest.findUnique({
            where: { id: requestId },
        });
        if (!request) throw new Error('Time-off request not found.');
        if (request.status !== 'PENDING') throw new Error('Request is no longer pending.');

        return this.prisma.timeOffRequest.update({
            where: { id: requestId },
            data: {
                status: 'APPROVED',
                approverId,
                managerNote,
                respondedAt: new Date(),
            },
        });
    }

    async rejectTimeOff(requestId, approverId, managerNote) {
        return this.prisma.timeOffRequest.update({
            where: { id: requestId },
            data: {
                status: 'REJECTED',
                approverId,
                managerNote,
                respondedAt: new Date(),
            },
        });
    }

    async getTimeOffRequests(businessProfileId, { employeeId, status, type } = {}) {
        const where = { businessProfileId };
        if (employeeId) where.employeeId = employeeId;
        if (status) where.status = status;
        if (type) where.type = type;

        return this.prisma.timeOffRequest.findMany({
            where,
            include: {
                employee: {
                    include: { user: { select: { username: true } } },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getUserTimeOffRequests(userId) {
        const employees = await this.prisma.businessEmployee.findMany({
            where: { userId },
            select: { id: true },
        });
        const employeeIds = employees.map(e => e.id);

        return this.prisma.timeOffRequest.findMany({
            where: { employeeId: { in: employeeIds } },
            include: {
                employee: {
                    include: {
                        businessProfile: { select: { businessName: true } },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }
}

module.exports = { TimeOffService };
