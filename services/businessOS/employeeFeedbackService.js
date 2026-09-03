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

        return this.prisma.$transaction(async (tx) => {
            const feedback = await tx.employeeFeedback.create({
                data: {
                    businessProfileId,
                    giverEmployeeId: fromEmployeeId,
                    receiverEmployeeId: toEmployeeId,
                    givenByUserId: fromEmployee.userId,
                    receivedByUserId: toEmployee.userId,
                    rating,
                    tags,
                    comment,
                    periodStart: new Date(Date.now() - 30 * 86400000), // Default 30 days
                    periodEnd: new Date(),
                },
            });

            // Recalculate only this business's feedback so another business can
            // never influence the employee's rating or ratingCount.
            // Serializable isolation prevents concurrent submissions from both
            // observing an incomplete history and writing a stale aggregate.
            const allFeedback = await tx.employeeFeedback.findMany({
                where: {
                    businessProfileId,
                    receiverEmployeeId: toEmployeeId,
                },
                select: { rating: true },
            });
            const avgRating = allFeedback.length > 0
                ? allFeedback.reduce((s, f) => s + f.rating, 0) / allFeedback.length
                : 0;

            const updated = await tx.businessEmployee.updateMany({
                where: { id: toEmployeeId, businessProfileId },
                data: {
                    rating: Math.round(avgRating * 100) / 100,
                    ratingCount: allFeedback.length,
                },
            });
            if (!updated.count) throw new Error('Employee no longer belongs to this business.');

            return feedback;
        }, { isolationLevel: 'Serializable' });
    }

    async getFeedbackForEmployee(employeeId) {
        return this.prisma.employeeFeedback.findMany({
            where: { receiverEmployeeId: employeeId },
            include: {
                giverEmployee: {
                    include: { user: { select: { username: true } } },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getFeedbackByEmployee(employeeId) {
        return this.prisma.employeeFeedback.findMany({
            where: { giverEmployeeId: employeeId },
            include: {
                receiverEmployee: {
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
                rating: true,
                ratingCount: true,
                user: { select: { username: true } },
            },
        });

        const totalFeedback = await this.prisma.employeeFeedback.count({
            where: { businessProfileId },
        });

        const avgRating = employees.length > 0
            ? employees.filter(e => e.rating > 0).reduce((s, e) => s + Number(e.rating), 0) /
              (employees.filter(e => e.rating > 0).length || 1)
            : 0;

        return {
            totalEmployees: employees.length,
            totalFeedback,
            avgRating: Math.round(avgRating * 100) / 100,
            employees: employees
                .filter(e => e.ratingCount > 0)
                .sort((a, b) => Number(b.rating) - Number(a.rating)),
        };
    }
}

module.exports = { EmployeeFeedbackService };
