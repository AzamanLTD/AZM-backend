'use strict';

const { getReadPrisma } = require('../src/config/readReplica');

function numeric(value) {
    return Number(value || 0);
}

// Known dine-in tab lifecycle states: OPEN -> FINALIZED -> CLOSED (CANCELLED
// is terminal). Included with zero defaults so the admin projection always
// exposes the full lifecycle shape, not only states that currently exist.
const KNOWN_STATUSES = ['OPEN', 'FINALIZED', 'CLOSED', 'CANCELLED'];

/**
 * Admin dine-in lifecycle projection. The backend is the sole authority for
 * dine-in state (CONTRACTS.md), so every figure here is computed server-side
 * from the canonical DineInTab/Invoice models — the admin portal never
 * aggregates or truncates client-side.
 */
exports.getDineInOverview = async (req, res) => {
    const prisma = getReadPrisma(req.app);
    try {
        const now = new Date();
        const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const sinceToday = new Date(now);
        sinceToday.setHours(0, 0, 0, 0);

        const [statusGroups, closedVolume24h, closedToday, recentTabs] = await Promise.all([
            prisma.dineInTab.groupBy({ by: ['status'], _count: { _all: true } }),
            prisma.dineInTab.aggregate({
                where: { status: 'CLOSED', closedAt: { gte: since24h } },
                _sum: { grandTotalUsdc: true, tipUsdc: true },
            }),
            prisma.dineInTab.count({ where: { status: 'CLOSED', closedAt: { gte: sinceToday } } }),
            prisma.dineInTab.findMany({
                orderBy: { openedAt: 'desc' },
                take: 15,
                select: {
                    id: true,
                    status: true,
                    openedAt: true,
                    closedAt: true,
                    subtotalUsdc: true,
                    tipUsdc: true,
                    grandTotalUsdc: true,
                    paymentMethod: true,
                    invoice: { select: { id: true, status: true } },
                    businessProfile: { select: { id: true, businessName: true } },
                },
            }),
        ]);

        const tabsByStatus = {};
        for (const group of statusGroups || []) {
            const count = group._count && typeof group._count === 'object' ? group._count._all : group._count;
            tabsByStatus[group.status] = numeric(count);
        }
        for (const status of KNOWN_STATUSES) {
            if (!(status in tabsByStatus)) tabsByStatus[status] = 0;
        }

        return res.status(200).json({
            success: true,
            overview: {
                tabsByStatus,
                openTabs: tabsByStatus.OPEN || 0,
                finalizedTabs: tabsByStatus.FINALIZED || 0,
                closedToday,
                volume24h: {
                    totalUsdc: numeric(closedVolume24h._sum.grandTotalUsdc),
                    tipsUsdc: numeric(closedVolume24h._sum.tipUsdc),
                },
                recentTabs,
                currencies: { crypto: 'USDC' },
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};
