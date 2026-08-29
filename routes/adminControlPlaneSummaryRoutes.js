const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { hasPermission, getStaffProfile, recordActivity } = require('../services/controlPlaneService');
const escrowService = require('../services/escrowService');

const router = express.Router();
router.use(protect);

function prisma(req) {
  const value = req.app.get('prisma');
  if (!value) throw new Error('Prisma is not configured');
  return value;
}

async function authorize(req, permission) {
  return hasPermission(prisma(req), req.user, permission);
}

function deny(res, permission) {
  return res.status(403).json({ success: false, message: `Control-plane permission required: ${permission}` });
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function serializeDispute(dispute, escrowById) {
  const escrow = escrowById.get(dispute.escrowId);
  return {
    id: dispute.id,
    escrowId: dispute.escrowId,
    raisedById: dispute.raisedById,
    reason: dispute.reason,
    evidenceUrls: Array.isArray(dispute.evidenceUrls) ? dispute.evidenceUrls : [],
    status: dispute.status,
    assignedToId: dispute.assignedToId ?? null,
    ruling: dispute.ruling ?? null,
    rulingNotes: dispute.rulingNotes ?? null,
    payerPct: dispute.payerPct ?? null,
    payeePct: dispute.payeePct ?? null,
    createdAt: dispute.createdAt,
    updatedAt: dispute.updatedAt,
    resolvedAt: dispute.resolvedAt ?? null,
    source: escrow ? {
      type: 'TICKET_ESCROW',
      ticketId: escrow.ticketId,
    } : null,
    escrow: escrow ? {
      id: escrow.id,
      ticketId: escrow.ticketId,
      payerId: escrow.payerId,
      payeeId: escrow.payeeId,
      amountUsdc: escrow.amountUsdc,
      status: escrow.status,
    } : null,
  };
}

router.get('/summary', async (req, res) => {
  if (!(await authorize(req, 'staff.view'))) return deny(res, 'staff.view');

  try {
    const p = prisma(req);
    const [totals, departments, activity, duties] = await Promise.all([
      p.$queryRawUnsafe(`
        SELECT
          COUNT(*)::int AS "totalStaff",
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS "activeStaff",
          COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int AS "suspendedStaff",
          COUNT(*) FILTER (WHERE status = 'INACTIVE')::int AS "inactiveStaff",
          COUNT(*) FILTER (WHERE presence = 'ONLINE' AND status = 'ACTIVE')::int AS "onlineStaff",
          COUNT(*) FILTER (WHERE presence = 'AWAY' AND status = 'ACTIVE')::int AS "awayStaff",
          COUNT(*) FILTER (WHERE presence = 'OFFLINE' AND status = 'ACTIVE')::int AS "offlineStaff",
          COUNT(*) FILTER (WHERE "authorityClass" = 'ADMIN' AND status = 'ACTIVE')::int AS "activeAdmins",
          COUNT(*) FILTER (WHERE "authorityClass" = 'EMPLOYEE' AND status = 'ACTIVE')::int AS "activeEmployees"
        FROM "StaffProfile"
      `),
      p.$queryRawUnsafe(`
        SELECT d.id, d.name, d."isActive",
               COUNT(sp.id)::int AS "staffCount",
               COUNT(sp.id) FILTER (WHERE sp.status = 'ACTIVE')::int AS "activeStaff",
               COUNT(sp.id) FILTER (WHERE sp.presence = 'ONLINE' AND sp.status = 'ACTIVE')::int AS "onlineStaff"
        FROM "ControlDepartment" d
        LEFT JOIN "StaffProfile" sp ON sp."departmentId" = d.id
        GROUP BY d.id
        ORDER BY d.name ASC
      `),
      p.$queryRawUnsafe(`
        SELECT
          COUNT(*)::int AS "totalEvents",
          COUNT(*) FILTER (WHERE "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '24 hours')::int AS "eventsLast24h",
          COUNT(*) FILTER (WHERE "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '7 days')::int AS "eventsLast7d"
        FROM "StaffActivityEvent"
      `),
      p.$queryRawUnsafe(`
        SELECT
          COUNT(*)::int AS "totalDuties",
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS "activeDuties",
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS "completedDuties",
          COUNT(*) FILTER (WHERE status = 'PENDING')::int AS "pendingDuties"
        FROM "StaffDutyAssignment"
      `),
    ]);

    return res.json({
      success: true,
      summary: {
        staff: totals[0] || {},
        departments,
        activity: activity[0] || {},
        duties: duties[0] || {},
      },
    });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane workforce summary failed');
    return res.status(500).json({ success: false, message: 'Failed to load workforce summary.' });
  }
});

// Unified escrow-dispute operational queue. This references the canonical
// SmartEscrow/EscrowDispute records and never creates a parallel dispute state.
router.get('/disputes', async (req, res) => {
  if (!(await authorize(req, 'staff.dispute.view'))) return deny(res, 'staff.dispute.view');

  try {
    const p = prisma(req);
    const page = boundedInt(req.query.page, 1, 1, 1000000);
    const limit = boundedInt(req.query.limit, 25, 1, 100);
    const skip = (page - 1) * limit;
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : null;

    const where = status ? { status } : {};
    const [disputes, total] = await Promise.all([
      p.escrowDispute.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      p.escrowDispute.count({ where }),
    ]);

    const escrowIds = [...new Set(disputes.map((item) => item.escrowId).filter(Boolean))];
    const escrows = escrowIds.length
      ? await p.smartEscrow.findMany({
          where: { id: { in: escrowIds } },
          select: { id: true, ticketId: true, payerId: true, payeeId: true, amountUsdc: true, status: true },
        })
      : [];
    const escrowById = new Map(escrows.map((item) => [item.id, item]));

    return res.json({
      success: true,
      disputes: disputes.map((item) => serializeDispute(item, escrowById)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane dispute queue failed');
    return res.status(500).json({ success: false, message: 'Failed to load dispute queue.' });
  }
});

router.post('/disputes/:escrowId/assign', async (req, res) => {
  if (!(await authorize(req, 'staff.dispute.assign'))) return deny(res, 'staff.dispute.assign');

  const assignedToId = Number(req.body?.assignedToId);
  if (!Number.isInteger(assignedToId) || assignedToId <= 0) {
    return res.status(400).json({ success: false, message: 'assignedToId must be a positive integer.' });
  }

  try {
    const p = prisma(req);
    const result = await escrowService.assignDisputeToAdmin(p, {
      escrowId: req.params.escrowId,
      assignedToId,
      requestingAdminId: req.user.id,
    });
    const staff = await getStaffProfile(p, req.user.id);
    await recordActivity(p, {
      staffProfileId: staff?.id ?? null,
      actorUserId: req.user.id,
      eventType: 'DISPUTE_ASSIGNED',
      targetType: 'ESCROW_DISPUTE',
      targetId: req.params.escrowId,
      metadata: { assignedToId },
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane dispute assignment failed');
    const statusCode = /not found/i.test(err.message) ? 404 : /permission|authorized|admin/i.test(err.message) ? 403 : 400;
    return res.status(statusCode).json({ success: false, message: err.message });
  }
});

router.post('/disputes/:escrowId/resolve', async (req, res) => {
  if (!(await authorize(req, 'staff.dispute.resolve'))) return deny(res, 'staff.dispute.resolve');

  const { ruling, rulingNotes, payerPct, payeePct } = req.body || {};
  const allowedRulings = new Set(['FULL_RELEASE', 'FULL_REFUND', 'SPLIT']);
  if (!allowedRulings.has(ruling)) {
    return res.status(400).json({ success: false, message: 'ruling must be FULL_RELEASE, FULL_REFUND, or SPLIT.' });
  }
  if (rulingNotes != null && (typeof rulingNotes !== 'string' || rulingNotes.trim().length > 2000)) {
    return res.status(400).json({ success: false, message: 'rulingNotes must be at most 2000 characters.' });
  }
  if (ruling === 'SPLIT') {
    const payer = Number(payerPct);
    const payee = Number(payeePct);
    if (!Number.isFinite(payer) || !Number.isFinite(payee) || payer < 0 || payee < 0 || payer + payee !== 100) {
      return res.status(400).json({ success: false, message: 'SPLIT requires payerPct + payeePct to equal 100.' });
    }
  }

  try {
    const p = prisma(req);
    const result = await escrowService.resolveDispute(p, {
      escrowId: req.params.escrowId,
      adminId: req.user.id,
      ruling,
      rulingNotes: typeof rulingNotes === 'string' ? rulingNotes.trim() : rulingNotes,
      payerPct: ruling === 'SPLIT' ? Number(payerPct) : undefined,
      payeePct: ruling === 'SPLIT' ? Number(payeePct) : undefined,
    });
    const staff = await getStaffProfile(p, req.user.id);
    await recordActivity(p, {
      staffProfileId: staff?.id ?? null,
      actorUserId: req.user.id,
      eventType: 'DISPUTE_RESOLVED',
      targetType: 'ESCROW_DISPUTE',
      targetId: req.params.escrowId,
      metadata: {
        ruling,
        payerPct: ruling === 'SPLIT' ? Number(payerPct) : null,
        payeePct: ruling === 'SPLIT' ? Number(payeePct) : null,
        hasRulingNotes: Boolean(rulingNotes),
      },
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane dispute resolution failed');
    const statusCode = /not found/i.test(err.message) ? 404 : /permission|authorized|admin/i.test(err.message) ? 403 : 400;
    return res.status(statusCode).json({ success: false, message: err.message });
  }
});

module.exports = router;
