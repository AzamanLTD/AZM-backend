const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { hasPermission } = require('../services/controlPlaneService');

const router = express.Router();
router.use(protect);

function prisma(req) {
  const value = req.app.get('prisma');
  if (!value) throw new Error('Prisma is not configured');
  return value;
}

router.get('/executive-summary', async (req, res) => {
  const p = prisma(req);
  if (!(await hasPermission(p, req.user, 'staff.view'))) {
    return res.status(403).json({ success: false, message: 'Control-plane permission required: staff.view' });
  }

  try {
    const [staff, disputes, treasury, transactions, profit] = await Promise.all([
      p.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS "totalStaff",
               COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS "activeStaff",
               COUNT(*) FILTER (WHERE presence = 'ONLINE' AND status = 'ACTIVE')::int AS "onlineStaff",
               COUNT(*) FILTER (WHERE "authorityClass" = 'ADMIN' AND status = 'ACTIVE')::int AS "activeAdmins"
        FROM "StaffProfile"
      `),
      p.escrowDispute.groupBy({ by: ['status'], _count: { _all: true } }),
      p.systemProfitFees.findUnique({ where: { id: 1 }, select: { balance: true, updatedAt: true } }),
      p.$queryRawUnsafe(`
        SELECT COUNT(*) FILTER (WHERE status IN ('PENDING', 'FAILED', 'FROZEN_DISPUTE'))::int AS "exceptionCount",
               COUNT(*) FILTER (WHERE status = 'PENDING')::int AS "pendingCount",
               COUNT(*) FILTER (WHERE status = 'FAILED')::int AS "failedCount",
               COUNT(*) FILTER (WHERE status = 'FROZEN_DISPUTE')::int AS "frozenDisputeCount"
        FROM "TransactionHistory"
      `),
      p.$queryRawUnsafe(`
        SELECT COALESCE(SUM("amountUsdc") FILTER (WHERE "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '24 hours'), 0)::numeric AS "last24h",
               COALESCE(SUM("amountUsdc") FILTER (WHERE "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '7 days'), 0)::numeric AS "last7d"
        FROM "AdminProfitLog"
      `),
    ]);

    const disputeCounts = disputes.reduce((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});

    return res.json({
      success: true,
      executiveSummary: {
        generatedAt: new Date().toISOString(),
        workforce: staff[0] || {},
        disputes: {
          byStatus: disputeCounts,
          open: Object.entries(disputeCounts)
            .filter(([status]) => !['RESOLVED', 'CLOSED', 'CANCELLED'].includes(status))
            .reduce((sum, [, count]) => sum + count, 0),
        },
        treasury: treasury || { balance: 0, updatedAt: null },
        financialExceptions: transactions[0] || {},
        profit: profit[0] || { last24h: 0, last7d: 0 },
        policy: {
          readOnly: true,
          canonicalSources: ['StaffProfile', 'EscrowDispute', 'SystemProfitFees', 'TransactionHistory', 'AdminProfitLog'],
          financialMutationsAllowed: false,
        },
      },
    });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane executive summary failed');
    return res.status(500).json({ success: false, message: 'Failed to load executive control-plane summary.' });
  }
});

module.exports = router;
