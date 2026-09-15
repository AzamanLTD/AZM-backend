// controllers/adminRbacController.js
// =============================================================================
// AZAMAN V3 — Admin RBAC, Multi-Step Approvals, Audit Log Export (Phase 4)
//
// Platform-level admin RBAC with granular permission scopes.
// Multi-step approval workflow for high-value operations (withdrawals > $10k,
// Susu payouts > $50k, vendor tier changes, user bans).
// Audit log export (CSV/JSON) for compliance.
//
// NOTE (2026-09-14 RBAC hardening):
//   • No eager PrismaClient here — every handler uses the request-scoped
//     shared instance via req.app.get('prisma').
//   • Action-specific permissions are actually enforced (creation, approval,
//     rejection, listing, audit export, Susu health) — the ADMIN_ROLES catalog
//     is no longer documentary.
//   • Non-monetary actions (USER_BAN, VENDOR_TIER_CHANGE) can never
//     auto-approve — they always require a second authorized admin.
//   • Approval/rejection writes are compare-and-swap concurrency-safe.
// NOTE (2026-09-14 catalog extension): COMPLIANCE_ADMIN now holds
//   `withdrawals.approve`. APPROVAL_TIERS declares it an eligible approver
//   for the >= $10k tiers and the >= $50k invariant requires Finance-or-
//   Compliance participation, but the action-permission gate previously
//   403'd Compliance before the tier logic could ever run — dead letter.
//   The tier system (requiredRoles + requiredApprovals + the $50k
//   invariant) remains the sole amount-scoping authority; this extension
//   only grants the action-type authority the declared policy presupposes.
// =============================================================================

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
      'withdrawals.approve', 'withdrawals.review', 'withdrawals.export',
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

// ── Action-type → permission mapping ─────────────────────────────────────────
// Single authority for which role may initiate/approve/reject each action
// type. VENDOR_TIER_CHANGE has no permission in the current catalog, so it
// stays SUPER_ADMIN/legacy-ADMIN only until the catalog is formally extended.
const APPROVAL_ACTION_PERMISSIONS = Object.freeze({
  WITHDRAWAL: 'withdrawals.approve',
  SUSU_PAYOUT: 'susu.approve_payout',
  USER_BAN: 'users.ban',
  FEE_OVERRIDE: 'fees.manage',
  MANUAL_BALANCE_ADJUST: 'fees.manage',
});

function hasApprovalActionPermission(user, type) {
  const normalizedType = String(type || '').trim().toUpperCase();

  if (normalizedType === 'VENDOR_TIER_CHANGE') {
    const role = String(user?.role || '').trim().toUpperCase();
    return role === 'ADMIN' || role === 'SUPER_ADMIN';
  }

  const permission = APPROVAL_ACTION_PERMISSIONS[normalizedType];
  return Boolean(permission && checkAdminPermission(user, permission));
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

// Type-aware approval requirement: non-monetary operations are not
// legitimately represented by a money amount, so they must never fall into
// the zero-approval auto-approve tier. They always require one approval from
// a second authorized admin (the requester can never self-approve).
function getApprovalRequirement(type, amount) {
  const normalizedType = String(type || '').trim().toUpperCase();

  if (normalizedType === 'USER_BAN' || normalizedType === 'VENDOR_TIER_CHANGE') {
    return {
      requiredApprovals: 1,
      requiredRoles: [],
    };
  }

  const tier = getApprovalTier(amount);

  return {
    requiredApprovals: tier.requiredApprovals,
    requiredRoles: tier.requiredRoles,
  };
}

// Role eligibility for a tier's requiredRoles set. Legacy ADMIN always
// qualifies; an empty requiredRoles list means any admin role may approve.
function isApprovalRoleEligible(role, requiredRoles) {
  const normalizedRole = String(role || '').trim().toUpperCase();
  if (!requiredRoles || requiredRoles.length === 0) return true;
  return requiredRoles.includes(normalizedRole) || normalizedRole === 'ADMIN';
}

// ── Deterministic conflict mapping ─────────────────────────────────────────
// Never surface raw Prisma errors for expected state conflicts.
const APPROVAL_ERROR_STATUS = Object.freeze({
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_NOT_PENDING: 400,
  APPROVAL_STATE_CONFLICT: 409,
  APPROVAL_CONFLICT: 409,
  APPROVAL_DUPLICATE: 400,
  APPROVAL_SELF: 400,
  APPROVAL_FORBIDDEN_TYPE: 403,
  APPROVAL_FORBIDDEN_ROLE: 403,
  APPROVAL_FORBIDDEN_FINANCE: 403,
});

function sendApprovalError(res, err) {
  const status = APPROVAL_ERROR_STATUS[err.code] || 500;
  const body = {
    success: false,
    message: err.code ? err.message : 'Failed to process approval request.',
  };
  // 409 conflict responses carry the deterministic machine code; 403s carry
  // the caller's role (matching the original API shapes). Never include a
  // raw Prisma error string.
  if (status === 409) body.code = err.code;
  if (status === 403) body.yourRole = err.yourRole;
  return res.status(status).json(body);
}

function approvalError(code, message, yourRole) {
  const err = new Error(message);
  err.code = code;
  if (yourRole !== undefined) err.yourRole = yourRole;
  return err;
}

// ── POST /api/admin/approvals ────────────────────────────────────────────────
async function createApprovalRequest(req, res) {
  try {
    const prisma = req.app.get('prisma');
    const { type, entityId, amount, description, metadata } = req.body;
    const userId = req.user.id;

    const validTypes = ['WITHDRAWAL', 'SUSU_PAYOUT', 'VENDOR_TIER_CHANGE', 'USER_BAN', 'FEE_OVERRIDE', 'MANUAL_BALANCE_ADJUST'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid approval type.' });
    }

    // The requester must hold the permission for the action being requested.
    if (!hasApprovalActionPermission(req.user, type)) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to create an approval request for this action type.',
        yourRole: req.user.role,
      });
    }

    const amt = parseFloat(amount) || 0;
    const requirement = getApprovalRequirement(type, amt);

    const request = await prisma.adminApprovalRequest.create({
      data: {
        type,
        entityId,
        amount: amt,
        description,
        metadata: metadata || {},
        requestedBy: userId,
        requiredApprovals: requirement.requiredApprovals,
        status: requirement.requiredApprovals === 0 ? 'AUTO_APPROVED' : 'PENDING',
        approvals: requirement.requiredApprovals === 0
          ? [{ userId, role: req.user.role, auto: true, at: new Date().toISOString() }]
          : [],
      },
    });

    return res.json({
      success: true,
      request,
      autoApproved: requirement.requiredApprovals === 0,
      message: requirement.requiredApprovals === 0
        ? 'Auto-approved (below threshold).'
        : `Approval required from ${requirement.requiredApprovals} admin(s).`,
    });
  } catch (err) {
    logger.error({ err }, '[adminRbac] createApproval error');
    return res.status(500).json({ success: false, message: 'Failed to create approval request.' });
  }
}

// ── POST /api/admin/approvals/:id/approve ───────────────────────────────────
async function approveRequest(req, res) {
  try {
    const prisma = req.app.get('prisma');
    const requestId = parseInt(req.params.id);
    const userId = req.user.id;

    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.adminApprovalRequest.findUnique({
        where: { id: requestId },
      });

      if (!request) {
        throw approvalError('APPROVAL_NOT_FOUND', 'Request not found.');
      }
      if (request.status !== 'PENDING') {
        throw approvalError('APPROVAL_NOT_PENDING', `Request is ${request.status}.`);
      }

      // Approve the action type the STORED request is for, per the requestor's
      // stored type — never a client-supplied type.
      if (!hasApprovalActionPermission(req.user, request.type)) {
        throw approvalError(
          'APPROVAL_FORBIDDEN_TYPE',
          'You are not authorized to approve this action type.',
          req.user.role
        );
      }

      const approvals = Array.isArray(request.approvals) ? request.approvals : [];

      // Check if already approved by this admin
      if (approvals.some(a => a.userId === userId)) {
        throw approvalError('APPROVAL_DUPLICATE', 'You have already approved this request.');
      }

      // Can't approve your own request (unless auto-approve)
      if (request.requestedBy === userId) {
        throw approvalError('APPROVAL_SELF', 'Cannot approve your own request.');
      }

      // Tier role eligibility for the request's monetary amount.
      const tier = getApprovalTier(Number(request.amount));
      if (!isApprovalRoleEligible(req.user.role, tier.requiredRoles)) {
        throw approvalError(
          'APPROVAL_FORBIDDEN_ROLE',
          'Your admin role is not eligible to approve this request.',
          req.user.role
        );
      }

      // >= $50k requires at least one Finance or Compliance admin approval.
      const normalizedApprovals = approvals.map((approval) =>
        String(approval?.role || '').trim().toUpperCase()
      );
      const normalizedCurrentRole = String(req.user.role || '').trim().toUpperCase();

      if (Number(request.amount) >= 50000) {
        const financeOrComplianceAlreadyPresent =
          normalizedApprovals.includes('FINANCE_ADMIN') ||
          normalizedApprovals.includes('COMPLIANCE_ADMIN');

        const currentIsFinanceOrCompliance =
          normalizedCurrentRole === 'FINANCE_ADMIN' ||
          normalizedCurrentRole === 'COMPLIANCE_ADMIN';

        if (!financeOrComplianceAlreadyPresent && !currentIsFinanceOrCompliance) {
          throw approvalError(
            'APPROVAL_FORBIDDEN_FINANCE',
            'At least one Finance or Compliance admin approval is required for requests of $50,000 or more.',
            req.user.role
          );
        }
      }

      const newApprovals = [
        ...approvals,
        {
          userId,
          role: req.user.role,
          at: new Date().toISOString(),
        },
      ];

      const isFullyApproved =
        newApprovals.length >= Number(request.requiredApprovals);

      // Compare-and-swap: if another admin changed the approvals JSON while we
      // were deciding, this guarded update claims 0 rows instead of
      // overwriting their approval.
      const claimed = await tx.adminApprovalRequest.updateMany({
        where: {
          id: requestId,
          status: 'PENDING',
          approvals: { equals: approvals },
        },
        data: {
          approvals: newApprovals,
          status: isFullyApproved ? 'APPROVED' : 'PENDING',
          approvedBy: isFullyApproved ? userId : null,
          approvedAt: isFullyApproved ? new Date() : null,
        },
      });

      if (claimed.count !== 1) {
        throw approvalError(
          'APPROVAL_CONFLICT',
          'This approval request changed while you were approving it. Please refresh and try again.'
        );
      }

      const updated = await tx.adminApprovalRequest.findUnique({
        where: { id: requestId },
      });

      return { request: updated, isFullyApproved };
    });

    // Socket notify other admins
    const io = req.app.get('io');
    if (io && result.isFullyApproved) {
      io.to('admin_room').emit('approval_completed', {
        requestId,
        type: result.request.type,
        entityId: result.request.entityId,
        amount: parseFloat(result.request.amount.toString()),
      });
    }

    const approvalsCount = Array.isArray(result.request.approvals)
      ? result.request.approvals.length
      : 0;

    return res.json({
      success: true,
      request: result.request,
      fullyApproved: result.isFullyApproved,
      message: result.isFullyApproved
        ? 'Request fully approved. Action can now be executed.'
        : `Approval recorded. ${result.request.requiredApprovals - approvalsCount} more needed.`,
    });
  } catch (err) {
    if (err.code && APPROVAL_ERROR_STATUS[err.code]) {
      return sendApprovalError(res, err);
    }
    logger.error({ err }, '[adminRbac] approve error');
    return res.status(500).json({ success: false, message: 'Failed to approve.' });
  }
}

// ── POST /api/admin/approvals/:id/reject ────────────────────────────────────
async function rejectRequest(req, res) {
  try {
    const prisma = req.app.get('prisma');
    const requestId = parseInt(req.params.id);
    const { reason } = req.body;

    const updated = await prisma.$transaction(async (tx) => {
      const request = await tx.adminApprovalRequest.findUnique({
        where: { id: requestId },
      });

      if (!request) {
        throw approvalError('APPROVAL_NOT_FOUND', 'Request not found.');
      }

      // Rejection authority follows the stored request type, not a
      // client-supplied type.
      if (!hasApprovalActionPermission(req.user, request.type)) {
        throw approvalError(
          'APPROVAL_FORBIDDEN_TYPE',
          'You are not authorized to approve this action type.',
          req.user.role
        );
      }

      // Atomic claim: only one transition out of PENDING can ever win.
      const claim = await tx.adminApprovalRequest.updateMany({
        where: {
          id: requestId,
          status: 'PENDING',
        },
        data: {
          status: 'REJECTED',
          rejectedBy: req.user.id,
          rejectedAt: new Date(),
          rejectionReason: reason || 'No reason provided.',
        },
      });

      if (claim.count !== 1) {
        const current = await tx.adminApprovalRequest.findUnique({
          where: { id: requestId },
        });

        if (!current) {
          throw approvalError('APPROVAL_NOT_FOUND', 'Request not found.');
        }

        throw approvalError('APPROVAL_STATE_CONFLICT', `Request is ${current.status}.`);
      }

      return tx.adminApprovalRequest.findUnique({
        where: { id: requestId },
      });
    });

    return res.json({ success: true, request: updated, message: 'Request rejected.' });
  } catch (err) {
    if (err.code && APPROVAL_ERROR_STATUS[err.code]) {
      return sendApprovalError(res, err);
    }
    logger.error({ err }, '[adminRbac] reject error');
    return res.status(500).json({ success: false, message: 'Failed to reject.' });
  }
}

// ── GET /api/admin/approvals ─────────────────────────────────────────────────
async function listApprovals(req, res) {
  try {
    if (!checkAdminPermission(req.user, 'audit.view')) {
      return res.status(403).json({
        success: false,
        message: 'Admin permission required: audit.view',
        yourRole: req.user.role,
      });
    }

    const prisma = req.app.get('prisma');
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
    if (!checkAdminPermission(req.user, 'audit.export')) {
      return res.status(403).json({
        success: false,
        message: 'Admin permission required: audit.export',
        yourRole: req.user.role,
      });
    }

    const prisma = req.app.get('prisma');
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
    if (!checkAdminPermission(req.user, 'susu.health')) {
      return res.status(403).json({
        success: false,
        message: 'Admin permission required: susu.health',
        yourRole: req.user.role,
      });
    }

    const prisma = req.app.get('prisma');
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
  getApprovalRequirement,
  hasApprovalActionPermission,
  isApprovalRoleEligible,
};
