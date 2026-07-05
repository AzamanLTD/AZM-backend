// 📁 services/businessOS/employeeFeedbackService.js
// services/businessOS/employeeFeedbackService.js
// =============================================================================
// Employee Feedback & Rating Service — peer feedback, manager ratings,
// and 360-degree review system.
// =============================================================================

class EmployeeFeedbackService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    async createFeedback({ businessProfileId, fromEmployeeId, toEmployeeId, rating, tags = [], comment, isAnonymous = false, shiftId }) {
        if (fromEmployeeId === toEmployeeId) {
            throw new Error('Cannot give feedback to yourself.');
        }

        const [fromEmployee, toEmployee] = await Promise.all([
            this.prisma.businessEmployee.findUnique({ where: { id: fromEmployeeId } }),
            this.prisma.businessEmployee.findUnique({ where: { id: toEmployeeId } }),
        ]);

        if (!fromEmployee || !toEmployee) throw new Error('Employee not found.');
        if (fromEmployee.businessProfileId !== businessProfileId || toEmployee.businessProfileId !== businessProfileId) {
            throw new Error('Both employees must belong to the same business.');
        }

        const feedback = await this.prisma.employeeFeedback.create({
            data: {
                businessProfileId,
                fromEmployeeId,
                toEmployeeId,
                fromUserId: fromEmployee.userId,
                rating,
                tags,
                comment,
                isAnonymous,
                shiftId,
            },
        });

        // Recalculate employee's average rating
        const allFeedback = await this.prisma.employeeFeedback.findMany({
            where: { toEmployeeId, isAnonymous: false },
            select: { rating: true },
        });
        const avgRating = allFeedback.length > 0
            ? allFeedback.reduce((s, f) => s + f.rating, 0) / allFeedback.length
            : 0;

        await this.prisma.businessEmployee.update({
            where: { id: toEmployeeId },
            data: {
                performanceRating: Math.round(avgRating * 100) / 100,
                feedbackCount: allFeedback.length,
            },
        });

        return feedback;
    }

    async getFeedbackForEmployee(employeeId) {
        return this.prisma.employeeFeedback.findMany({
            where: { toEmployeeId: employeeId },
            include: {
                fromEmployee: {
                    include: { user: { select: { username: true } } },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getFeedbackByEmployee(employeeId) {
        return this.prisma.employeeFeedback.findMany({
            where: { fromEmployeeId: employeeId },
            include: {
                toEmployee: {
                    include: { user: { select: { username: true } } },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getBusinessFeedbackSummary(businessProfileId) {
        const employees = await this.prisma.businessEmployee.findMany({
            where: { businessProfileId },
            select: {
                id: true,
                role: true,
                performanceRating: true,
                feedbackCount: true,
                user: { select: { username: true } },
            },
        });

        const totalFeedback = await this.prisma.employeeFeedback.count({
            where: { businessProfileId },
        });

        const avgRating = employees.length > 0
            ? employees.filter(e => e.performanceRating > 0).reduce((s, e) => s + e.performanceRating, 0) /
              (employees.filter(e => e.performanceRating > 0).length || 1)
            : 0;

        return {
            totalEmployees: employees.length,
            totalFeedback,
            avgRating: Math.round(avgRating * 100) / 100,
            employees: employees
                .filter(e => e.feedbackCount > 0)
                .sort((a, b) => b.performanceRating - a.performanceRating),
        };
    }
}

module.exports = { EmployeeFeedbackService };
