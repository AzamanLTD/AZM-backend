// controllers/adminRbacController.js
// =============================================================================
// AZAMAN V3 — Admin RBAC, Multi-Step Approvals, Audit Log Export (Phase 4)
//
// Platform-level admin RBAC with granular permission scopes.
// Multi-step approval workflow for high-value operations (withdrawals > $10k,
// Susu payouts > $50k, vendor tier changes, user bans).
// Audit log export (CSV/JSON) for compliance.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');

// ── Admin Role Definitions ──────────────────────────────────────────────────
const ADMIN_ROLES = {
  SUPER_ADMIN: {
    name: 'Super Admin',
    permissions: ['*'],
    description: 'Full platform access, can manage other admins',
  },
  FINANCE_ADMIN: {
    name: 'Finance Admin',
    permissions: [
      'withdrawals.approve', 'withdrawals.review', 'withdrawals.export',
      'trades.view', 'trades.export', 'fees.manage',
      'susu.oversee', 'susu.health', 'susu.approve_payout',
      'vaults.view', 'vaults.approve',
      'audit.view', 'audit.export',
    ],
    description: 'Financial operations oversight',
  },
  SUPPORT_ADMIN: {
    name: 'Support Admin',
    permissions: [
      'users.view', 'users.ban', 'users.unban', 'users.kyc_approve', 'users.kyc_reject',
      'disputes.view', 'disputes.resolve', 'disputes.escalate',
      'trades.view', 'messages.view',
      'audit.view',
    ],
    description: 'User support and dispute resolution',
  },
  COMPLIANCE_ADMIN: {
    name: 'Compliance Admin',
    permissions: [
      'withdrawals.review', 'withdrawals.export',
      'users.view', 'users.kyc_approve', 'users.kyc_reject',
      'audit.view', 'audit.export', 'audit.delete',
      'reports.view', 'reports.export',
      'susu.health',
    ],
    description: 'Compliance and regulatory oversight',
  },
  READ_ONLY_ADMIN: {
    name: 'Read-Only Admin',
    permissions: [
      'users.view', 'trades.view', 'withdrawals.review',
      'susu.health', 'vaults.view', 'disputes.view',
      'audit.view', 'reports.view',
    ],
    description: 'View-only access for auditors',
  },
};

// ── Check admin permission ──────────────────────────────────────────────────
function checkAdminPermission(user, permission) {
  if (!user || !user.role) return false;
  if (user.role.toUpperCase() === 'ADMIN') return true; // legacy full admin

  const roleDef = ADMIN_ROLES[user.role?.toUpperCase()];
  if (!roleDef) return false;
  return roleDef.permissions.includes('*') || roleDef.permissions.includes(permission);
}

// ── Middleware: requireAdminPermission ─────────────────────────────────────
function requireAdminPermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required.' });
    if (!checkAdminPermission(req.user, permission)) {
      return res.status(403).json({
        success: false,
        message: `Admin permission required: ${permission}`,
        yourRole: req.user.role,
      });
    }
    next();
  };
}

// ── Multi-Step Approval Workflow ────────────────────────────────────────────
// High-value operations require approval from N admins based on amount tiers:
//   < $1k:     auto-approve (single admin can execute)
//   $1k-$10k:  1 admin approval
//   $10k-$50k: 2 admin approvals
//   > $50k:    3 admin approvals (including 1 finance/compliance admin)

const APPROVAL_TIERS = [
  { threshold: 50000, requiredApprovals: 3, requiredRoles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'COMPLIANCE_ADMIN'] },
  { threshold: 10000, requiredApprovals: 2, requiredRoles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'COMPLIANCE_ADMIN'] },
  { threshold: 1000,  requiredApprovals: 1, requiredRoles: [] },
  { threshold: 0,      requiredApprovals: 0, requiredRoles: [] }, // auto-approve
];

function getApprovalTier(amount) {
  for (const tier of APPROVAL_TIERS) {
    if (amount >= tier.threshold) return tier;
  }
  return APPROVAL_TIERS[APPROVAL_TIERS.length - 1];
}

// ── POST /api/admin/approvals/create ────────────────────────────────────────
async function createApprovalRequest(req, res) {
  try {
    const { type, entityId, amount, description, metadata } = req.body;
    const userId = req.user.id;

    const validTypes = ['WITHDRAWAL', 'SUSU_PAYOUT', 'VENDOR_TIER_CHANGE', 'USER_BAN', 'FEE_OVERRIDE', 'MANUAL_BALANCE_ADJUST'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid approval type.' });
    }

    const amt = parseFloat(amount) || 0;
    const tier = getApprovalTier(amt);

    const request = await prisma.adminApprovalRequest.create({
      data: {
        type,
        entityId,
        amount: amt,
        description,
        metadata: metadata || {},
        requestedBy: userId,
        requiredApprovals: tier.requiredApprovals,
        status: tier.requiredApprovals === 0 ? 'AUTO_APPROVED' : 'PENDING',
        approvals: tier.requiredApprovals === 0
          ? [{ userId, role: req.user.role, auto: true, at: new Date().toISOString() }]
          : [],
      },
    });

    return res.json({
      success: true,
      request,
      autoApproved: tier.requiredApprovals === 0,
      message: tier.requiredApprovals === 0
        ? 'Auto-approved (below threshold).'
        : `Approval required from ${tier.requiredApprovals} admin(s).`,
    });
  } catch (err) {
    logger.error({ err }, '[adminRbac] createApproval error');
    return res.status(500).json({ success: false, message: 'Failed to create approval request.' });
  }
}

// ── POST /api/admin/approvals/:id/approve ───────────────────────────────────
async function approveRequest(req, res) {
  try {
    const requestId = parseInt(req.params.id);
    const userId = req.user.id;

    const request = await prisma.adminApprovalRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });
    if (request.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: `Request is ${request.status}.` });
    }

    // Check if already approved by this admin
    const approvals = request.approvals || [];
    if (approvals.some(a => a.userId === userId)) {
      return res.status(400).json({ success: false, message: 'You have already approved this request.' });
    }

    // Can't approve your own request (unless auto-approve)
    if (request.requestedBy === userId) {
      return res.status(400).json({ success: false, message: 'Cannot approve your own request.' });
    }

    // Add approval
    const newApprovals = [...approvals, {
      userId,
      role: req.user.role,
      at: new Date().toISOString(),
    }];

    const isFullyApproved = newApprovals.length >= request.requiredApprovals;

    const updated = await prisma.adminApprovalRequest.update({
      where: { id: requestId },
      data: {
        approvals: newApprovals,
        status: isFullyApproved ? 'APPROVED' : 'PENDING',
        approvedBy: isFullyApproved ? userId : null,
        approvedAt: isFullyApproved ? new Date() : null,
      },
    });

    // Socket notify other admins
    const io = req.app.get('io');
    if (io && isFullyApproved) {
      io.to('admin_room').emit('approval_completed', {
        requestId,
        type: request.type,
        entityId: request.entityId,
        amount: parseFloat(request.amount.toString()),
      });
    }

    return res.json({
      success: true,
      request: updated,
      fullyApproved: isFullyApproved,
      message: isFullyApproved
        ? 'Request fully approved. Action can now be executed.'
        : `Approval recorded. ${request.requiredApprovals - newApprovals.length} more needed.`,
    });
  } catch (err) {
    logger.error({ err }, '[adminRbac] approve error');
    return res.status(500).json({ success: false, message: 'Failed to approve.' });
  }
}

// ── POST /api/admin/approvals/:id/reject ────────────────────────────────────
async function rejectRequest(req, res) {
  try {
    const requestId = parseInt(req.params.id);
    const { reason } = req.body;

    const request = await prisma.adminApprovalRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });
    if (request.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: `Request is ${request.status}.` });
    }

    const updated = await prisma.adminApprovalRequest.update({
      where: { id: requestId },
      data: {
        status: 'REJECTED',
        rejectedBy: req.user.id,
        rejectedAt: new Date(),
        rejectionReason: reason || 'No reason provided.',
      },
    });

    return res.json({ success: true, request: updated, message: 'Request rejected.' });
  } catch (err) {
    logger.error({ err }, '[adminRbac] reject error');
    return res.status(500).json({ success: false, message: 'Failed to reject.' });
  }
}

// ── GET /api/admin/approvals ─────────────────────────────────────────────────
async function listApprovals(req, res) {
  try {
    const status = req.query.status || 'PENDING';
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const requests = await prisma.adminApprovalRequest.findMany({
      where: status === 'ALL' ? {} : { status },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return res.json({ success: true, requests });
  } catch (err) {
    logger.error({ err }, '[adminRbac] list error');
    return res.status(500).json({ success: false, message: 'Failed to list approvals.' });
  }
}

// ── Audit Log Export ────────────────────────────────────────────────────────
async function exportAuditLog(req, res) {
  try {
    const format = (req.query.format || 'json').toLowerCase();
    const startDate = req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = req.query.endDate ? new Date(req.query.endDate) : new Date();
    const category = req.query.category;

    const where = {
      createdAt: { gte: startDate, lte: endDate },
      ...(category ? { targetType: category } : {}),
    };

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 10000, // safety cap
    });

    if (format === 'csv') {
      const headers = ['id', 'actorId', 'action', 'targetType', 'targetId', 'metadata', 'ipAddress', 'createdAt'];
      const rows = logs.map(l => [
        l.id,
        l.actorId,
        l.action,
        l.targetType,
        l.targetType || '',
        l.targetId || '',
        JSON.stringify(l.metadata || {}),
        l.ipAddress || '',
        l.createdAt.toISOString(),
      ]);

      const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit_log_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csv);
    }

    return res.json({ success: true, count: logs.length, logs, exportedAt: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, '[adminRbac] export error');
    return res.status(500).json({ success: false, message: 'Failed to export audit log.' });
  }
}

// ── Susu Health Dashboard ────────────────────────────────────────────────────
async function getSusuHealthDashboard(req, res) {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Aggregate Susu stats from actual models
    const [
      totalGroups,
      activeGroups,
      completedGroups,
      totalMembers,
      totalCycles,
      paidOutCycles,
      defaultedCycles,
      totalContributions,
    ] = await Promise.all([
      prisma.susuGroup.count(),
      prisma.susuGroup.count({ where: { status: 'ACTIVE' } }),
      prisma.susuGroup.count({ where: { status: 'COMPLETED' } }),
      prisma.susuMember.count(),
      prisma.susuCycle.count(),
      prisma.susuCycle.count({ where: { status: 'PAID_OUT' } }),
      prisma.susuCycle.count({ where: { status: 'DEFAULTED' } }),
      prisma.susuContribution.aggregate({ _sum: { amountUsdc: true } }),
    ]);

    // Recent cycles with defaults
    const cyclesWithDefaults = await prisma.susuCycle.findMany({
      where: { defaultsCount: { gte: 1 }, createdAt: { gte: thirtyDaysAgo } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, cycleNumber: true, susuGroupId: true,
        payoutAmount: true, defaultsCount: true, status: true, collectionDate: true,
      },
    });

    // Health metrics
    const completionRate = totalGroups > 0
      ? ((completedGroups / totalGroups) * 100).toFixed(1)
      : '0.0';

    const cycleCompletionRate = totalCycles > 0
      ? ((paidOutCycles / totalCycles) * 100).toFixed(1)
      : '0.0';

    const avgGroupSize = totalGroups > 0
      ? (totalMembers / totalGroups).toFixed(1)
      : '0.0';

    const totalPayouts = await prisma.susuCycle.aggregate({
      where: { status: 'PAID_OUT' },
      _sum: { payoutAmount: true },
    });

    // At-risk groups: groups with cycles that have defaults
    const atRiskGroupIds = await prisma.susuCycle.findMany({
      where: { defaultsCount: { gte: 1 }, status: { in: ['COLLECTING', 'COLLECTING_GRACE'] } },
      distinct: ['susuGroupId'],
      select: { susuGroupId: true },
      take: 10,
    });

    const atRiskGroups = atRiskGroupIds.length > 0
      ? await prisma.susuGroup.findMany({
          where: { id: { in: atRiskGroupIds.map(g => g.susuGroupId) } },
          select: {
            id: true, status: true, contributionUsdc: true,
            totalCycles: true, startDate: true,
            cycles: { select: { cycleNumber: true, defaultsCount: true, status: true }, take: 1, orderBy: { cycleNumber: 'desc' } },
          },
        })
      : [];

    // Recent payouts (last 30 days)
    const recentPayouts = await prisma.susuCycle.findMany({
      where: { paidOutAt: { gte: thirtyDaysAgo } },
      orderBy: { paidOutAt: 'desc' },
      take: 10,
      select: { id: true, cycleNumber: true, susuGroupId: true, payoutAmount: true, payoutUserId: true, paidOutAt: true, feeUsdc: true },
    });

    return res.json({
      success: true,
      summary: {
        totalGroups,
        activeGroups,
        completedGroups,
        completionRate: parseFloat(completionRate),
        totalMembers,
        avgGroupSize: parseFloat(avgGroupSize),
        totalCycles,
        paidOutCycles,
        defaultedCycles,
        cycleCompletionRate: parseFloat(cycleCompletionRate),
        totalContributions: parseFloat(totalContributions._sum?.amountUsdc?.toString() || '0'),
        totalPayouts: parseFloat(totalPayouts._sum?.payoutAmount?.toString() || '0'),
        totalFeesCollected: 0, // TODO: aggregate from feeUsdc
      },
      atRiskGroups,
      cyclesWithDefaults,
      recentPayouts,
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, '[adminRbac] susu health error');
    return res.status(500).json({ success: false, message: 'Failed to load Susu health dashboard.' });
  }
}

// ── GET /api/admin/roles ─────────────────────────────────────────────────────
async function getAdminRoles(req, res) {
  return res.json({ success: true, roles: ADMIN_ROLES });
}

module.exports = {
  ADMIN_ROLES,
  checkAdminPermission,
  requireAdminPermission,
  createApprovalRequest,
  approveRequest,
  rejectRequest,
  listApprovals,
  exportAuditLog,
  getSusuHealthDashboard,
  getAdminRoles,
  getApprovalTier,
};
