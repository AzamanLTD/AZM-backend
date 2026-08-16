// services/businessOS/businessGroupService.js
// =============================================================================
// Business Group Service — multi-brand / multi-location ownership stats
// =============================================================================

class BusinessGroupService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    /**
     * Get or create a group for an owner user.
     * If the user owns multiple businesses but has no group, returns a
     * synthetic "ungrouped" result so the portal can still show side-by-side.
     */
    async getOwnerGroup(userId) {
        const prisma = this.prisma;
        const group = await prisma.businessGroup.findFirst({
            where: { ownerUserId: userId },
            include: {
                businessProfiles: {
                    select: {
                        id: true, businessName: true, category: true,
                        totalVolume: true, totalEscrows: true,
                        completedEscrows: true, averageRating: true,
                        reviewCount: true, isSuspended: true,
                        address: true, createdAt: true,
                    },
                },
            },
        });
        return group;
    }

    /**
     * Get aggregate stats across all businesses owned by a user,
     * optionally filtered by group.
     */
    async getGroupStats(userId, groupId = null) {
        const prisma = this.prisma;

        // Find all businesses for this user
        let businesses;
        if (groupId) {
            businesses = await prisma.businessProfile.findMany({
                where: { groupId },
                select: { id: true, businessName: true, category: true, address: true,
                          totalVolume: true, totalEscrows: true, completedEscrows: true,
                          averageRating: true, reviewCount: true },
            });
        } else {
            // All businesses owned by this user
            businesses = await prisma.businessProfile.findMany({
                where: { userId },
                select: { id: true, businessName: true, category: true, address: true,
                          totalVolume: true, totalEscrows: true, completedEscrows: true,
                          averageRating: true, reviewCount: true },
            });
        }

        if (!businesses.length) {
            return {
                totalRevenue: 0,
                totalOrders: 0,
                totalEmployees: 0,
                avgRating: 0,
                businesses: [],
            };
        }

        const bizIds = businesses.map(b => b.id);

        // Get employee counts per business
        const employeeCounts = await prisma.businessEmployee.groupBy({
            by: ['businessProfileId'],
            where: { businessProfileId: { in: bizIds }, status: 'ACTIVE' },
            _count: true,
        });

        const empMap = {};
        for (const e of employeeCounts) {
            empMap[e.businessProfileId] = e._count;
        }

        // Get recent 30-day order count per business
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const orderCounts = await prisma.businessOrder.groupBy({
            by: ['businessProfileId'],
            where: { businessProfileId: { in: bizIds }, createdAt: { gte: thirtyDaysAgo } },
            _count: true,
        });

        const orderMap = {};
        for (const o of orderCounts) {
            orderMap[o.businessProfileId] = o._count;
        }

        // Get previous 30-day orders for delta calculation
        const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const prevOrderCounts = await prisma.businessOrder.groupBy({
            by: ['businessProfileId'],
            where: {
                businessProfileId: { in: bizIds },
                createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
            },
            _count: true,
        });

        const prevOrderMap = {};
        for (const o of prevOrderCounts) {
            prevOrderMap[o.businessProfileId] = o._count;
        }

        // Build per-business stats
        const bizStats = businesses.map(b => {
            const currentOrders = orderMap[b.id] || 0;
            const prevOrders = prevOrderMap[b.id] || 0;
            const delta = prevOrders > 0
                ? Math.round(((currentOrders - prevOrders) / prevOrders) * 100)
                : currentOrders > 0 ? 100 : 0;

            return {
                id: b.id,
                name: b.businessName,
                type: b.category,
                revenue: parseFloat(b.totalVolume) || 0,
                orders: currentOrders,
                employees: empMap[b.id] || 0,
                rating: parseFloat(b.averageRating) || 0,
                delta,
                location: b.address || '—',
            };
        });

        // Aggregate totals
        const totalRevenue = bizStats.reduce((s, b) => s + b.revenue, 0);
        const totalOrders = bizStats.reduce((s, b) => s + b.orders, 0);
        const totalEmployees = bizStats.reduce((s, b) => s + b.employees, 0);
        const ratedBiz = bizStats.filter(b => b.rating > 0);
        const avgRating = ratedBiz.length > 0
            ? ratedBiz.reduce((s, b) => s + b.rating, 0) / ratedBiz.length
            : 0;

        return {
            totalRevenue,
            totalOrders,
            totalEmployees,
            avgRating: Math.round(avgRating * 10) / 10,
            businesses: bizStats,
        };
    }
}

module.exports = { BusinessGroupService };
