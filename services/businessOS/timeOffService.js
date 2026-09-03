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

        return this.prisma.timeOffRequest.create({
            data: {
                businessProfileId,
                employeeId,
                userId: employee.userId,
                type,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                reason,
            },
        });
    }

    async _resolveApprovalScope(approverId, request) {
        const approver = await this.prisma.user.findUnique({
            where: { id: Number(approverId) },
            select: { role: true },
        });
        if (approver?.role === 'ADMIN') return { isAdmin: true, employee: null };

        const employee = await this.prisma.businessEmployee.findFirst({
            where: {
                userId: Number(approverId),
                businessProfileId: request.businessProfileId,
                status: 'ACTIVE',
            },
            select: { id: true, businessProfileId: true },
        });
        if (!employee) {
            throw new Error('You are not authorized to resolve this business time-off request.');
        }
        return { isAdmin: false, employee };
    }

    async approveTimeOff(requestId, approverId, managerNote) {
        const request = await this.prisma.timeOffRequest.findUnique({
            where: { id: requestId },
            select: { id: true, businessProfileId: true, status: true, employeeId: true },
        });
        if (!request) throw new Error('Time-off request not found.');
        if (request.status !== 'PENDING') throw new Error('Request is no longer pending.');

        const scope = await this._resolveApprovalScope(approverId, request);
        if (!scope.isAdmin && scope.employee.id === request.employeeId) {
            throw new Error('Employees cannot approve their own time-off request.');
        }

        const transitioned = await this.prisma.timeOffRequest.updateMany({
            where: {
                id: requestId,
                businessProfileId: request.businessProfileId,
                status: 'PENDING',
            },
            data: {
                status: 'APPROVED',
                managerNote,
            },
        });
        if (transitioned.count !== 1) throw new Error('Request is no longer pending.');

        return this.prisma.timeOffRequest.findUnique({ where: { id: requestId } });
    }

    async rejectTimeOff(requestId, approverId, managerNote) {
        const request = await this.prisma.timeOffRequest.findUnique({
            where: { id: requestId },
            select: { id: true, businessProfileId: true, status: true, employeeId: true },
        });
        if (!request) throw new Error('Time-off request not found.');
        if (request.status !== 'PENDING') throw new Error('Request is no longer pending.');

        const scope = await this._resolveApprovalScope(approverId, request);
        if (!scope.isAdmin && scope.employee.id === request.employeeId) {
            throw new Error('Employees cannot reject their own time-off request.');
        }

        const transitioned = await this.prisma.timeOffRequest.updateMany({
            where: {
                id: requestId,
                businessProfileId: request.businessProfileId,
                status: 'PENDING',
            },
            data: {
                status: 'REJECTED',
                managerNote,
            },
        });
        if (transitioned.count !== 1) throw new Error('Request is no longer pending.');

        return this.prisma.timeOffRequest.findUnique({ where: { id: requestId } });
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
