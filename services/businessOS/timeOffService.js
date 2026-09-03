// 📁 services/businessOS/timeOffService.js
// services/businessOS/timeOffService.js
// =============================================================================
// Time-Off Request Service — sick, vacation, personal, emergency, unpaid.
// =============================================================================

const { getBusinessRequestContext } = require('../../src/lib/businessRequestContext');

class TimeOffService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    _getContext() {
        const context = getBusinessRequestContext();
        if (!context?.businessProfileId) {
            throw new Error('Business scope is required for this mutation.');
        }
        return context;
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

    async approveTimeOff(requestId, approverId, managerNote) {
        const context = this._getContext();
        const request = await this.prisma.timeOffRequest.findFirst({
            where: { id: requestId, businessProfileId: context.businessProfileId },
            select: { id: true, status: true, employeeId: true },
        });
        if (!request) throw new Error('Time-off request not found.');
        if (request.status !== 'PENDING') throw new Error('Request is no longer pending.');

        const actorEmployee = await this.prisma.businessEmployee.findFirst({
            where: { userId: approverId, businessProfileId: context.businessProfileId, status: 'ACTIVE' },
            select: { id: true },
        });
        if (!context.isAdmin && !context.isBusinessOwner && !actorEmployee) {
            throw new Error('You are not authorized to approve time-off requests for this business.');
        }
        if (!context.isAdmin && !context.isBusinessOwner && actorEmployee.id === request.employeeId) {
            throw new Error('Employees cannot approve their own time-off request.');
        }

        const transitioned = await this.prisma.timeOffRequest.updateMany({
            where: {
                id: requestId,
                businessProfileId: context.businessProfileId,
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
        const context = this._getContext();
        const request = await this.prisma.timeOffRequest.findFirst({
            where: { id: requestId, businessProfileId: context.businessProfileId },
            select: { id: true, status: true, employeeId: true },
        });
        if (!request) throw new Error('Time-off request not found.');
        if (request.status !== 'PENDING') throw new Error('Request is no longer pending.');

        const actorEmployee = await this.prisma.businessEmployee.findFirst({
            where: { userId: approverId, businessProfileId: context.businessProfileId, status: 'ACTIVE' },
            select: { id: true },
        });
        if (!context.isAdmin && !context.isBusinessOwner && !actorEmployee) {
            throw new Error('You are not authorized to reject time-off requests for this business.');
        }
        if (!context.isAdmin && !context.isBusinessOwner && actorEmployee.id === request.employeeId) {
            throw new Error('Employees cannot reject their own time-off request.');
        }

        const transitioned = await this.prisma.timeOffRequest.updateMany({
            where: {
                id: requestId,
                businessProfileId: context.businessProfileId,
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