// controllers/adminRoleAdminController.js
// =============================================================================
// AZAMAN V3 — r272 follow-up: Secure Admin Role Provisioning & Revocation
//
// Operational provisioning for the AUTHORITATIVE specialized-role source
// introduced with AdminRoleAssignment. The RBAC catalog (ADMIN_ROLES in
// adminRbacController) is the single valid role list; the JWT role claim and
// any client-supplied role value are NEVER evidence of authority.
//
// Authorization model (fail closed, on every mutation):
//   • The route-level protect + isAdmin middleware stays as the
//     authentication boundary ONLY. Each handler re-resolves the ACTING
//     administrator's effective role from live database state inside the
//     transaction that performs the change — effective SUPER_ADMIN is
//     required for all role assignment, change, and deprovision operations.
//   • A legacy ADMIN account with no authoritative SUPER_ADMIN assignment
//     can never manage other administrators (its 'ADMIN' fallback is not
//     SUPER_ADMIN).
//   • Targets are validated against the live User row: missing, deleted,
//     banned, or non-admin accounts are rejected.
//   • The acting administrator can never be the target of a mutation
//     (no self-escalation, no self-demotion lockout).
//   • No mutation may leave zero active SUPER_ADMIN assignments (lockout
//     protection, enforced transactionally).
//
// Revocation semantics (r272 follow-up, requirement 4):
//   • Assigning READ_ONLY_ADMIN demotes to the intended restricted level —
//     the resolver returns READ_ONLY_ADMIN (not the legacy full-ADMIN
//     fallback), so the catalog, not the enum, scopes the account.
//   • Full deprovision removes administrative access safely IN ONE
//     TRANSACTION: the assignment is deleted, User.role becomes USER, and
//     User.tokenVersion is incremented so every outstanding token (which
//     carries the old tokenVersion claim) is rejected by authMiddleware.
//   • There is deliberately NO endpoint for bare assignment deletion:
//     with User.role still ADMIN, deleting a FINANCE_ADMIN or
//     COMPLIANCE_ADMIN assignment alone would fall back to LEGACY FULL
//     ADMIN in resolveEffectiveAdminRole() — a privilege ESCALATION, not a
//     revocation. Only the transactional deprovision path is exposed.
//
// Auditability: every successful mutation writes an AuditLog row inside the
// same transaction (actor, target, old/new effective roles, outcome).
// Refused attempts write no audit row, so failed attempts can never be
// mistaken for success events.
// =============================================================================

const rbac = require('./adminRbacController');

// The catalog is the single source of assignable specialized roles.
const ASSIGNABLE_ROLES = Object.keys(rbac.ADMIN_ROLES);

// Postgres advisory-lock key (transaction-scoped). All role-management
// mutations serialize on it, so concurrent conflicting changes are applied
// strictly one-after-another and the SUPER_ADMIN lockout check can never be
// raced into leaving zero active Super Admins.
const ROLE_MANAGEMENT_LOCK_KEY = 87272111;

function roleManagementError(code, status, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.expose = { code, message, ...extra };
  return err;
}

// Reusable request/response helpers follow the repo's r272 test idiom.
function sendError(res, err) {
  const status = Number(err.status) || 500;
  return res.status(status).json({ success: false, ...(err.expose || {}), message: err.message });
}

// ── Handler: list administrative accounts and their effective roles ────────
// Authorization: effective SUPER_ADMIN (resolved from live database state —
// the JWT claim decides nothing).
async function listAdmins(req, res) {
  const prisma = req.app.get('prisma');
  try {
    const actingRole = await rbac.resolveEffectiveAdminRole(prisma, req.user.id);
    if (actingRole !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        code: 'RBAC_SUPER_ADMIN_REQUIRED',
        message: 'Effective SUPER_ADMIN authority is required to view the administrator roster.',
        yourRole: actingRole,
      });
    }

    const [admins, assignments] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'ADMIN', isDeleted: false },
        select: { id: true, username: true, email: true, banStatus: true, createdAt: true },
        orderBy: { id: 'asc' },
      }),
      prisma.adminRoleAssignment.findMany(),
    ]);
    const byUser = new Map(assignments.map((a) => [a.userId, a]));

    const payload = await Promise.all(admins.map(async (u) => {
      const effectiveRole = await rbac.resolveEffectiveAdminRole(prisma, u.id);
      const assignment = byUser.get(u.id) || null;
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        banStatus: u.banStatus,
        createdAt: u.createdAt,
        effectiveRole, // null when banned: the account holds no admin powers
        legacyFullAdmin: effectiveRole === 'ADMIN',
        assignment: assignment
          ? { role: assignment.role, assignedBy: assignment.assignedBy, assignedAt: assignment.assignedAt }
          : null,
      };
    }));

    return res.status(200).json({ success: true, count: payload.length, admins: payload });
  } catch (err) {
    return sendError(res, err);
  }
}

// ── In-transaction mutation core (shared by assign + deprovision) ───────────
async function authorizeMutation(tx, req) {
  const actingRole = await rbac.resolveEffectiveAdminRole(tx, req.user.id);
  if (actingRole !== 'SUPER_ADMIN') {
    throw roleManagementError('RBAC_SUPER_ADMIN_REQUIRED', 403,
      'Effective SUPER_ADMIN authority is required to manage administrator roles.',
      { yourRole: actingRole });
  }
  return actingRole;
}

async function loadTarget(tx, targetId, actingId) {
  const numericId = Number(targetId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw roleManagementError('RBAC_TARGET_INVALID_ID', 400, 'A valid target user id is required.');
  }
  if (numericId === Number(actingId)) {
    throw roleManagementError('RBAC_SELF_MANAGEMENT_FORBIDDEN', 400,
      'Administrators cannot change their own role assignment or deprovision themselves.');
  }

  const target = await tx.user.findUnique({
    where: { id: numericId },
    select: { id: true, username: true, email: true, role: true, banStatus: true, isDeleted: true, tokenVersion: true },
  });
  if (!target || target.isDeleted) {
    throw roleManagementError('RBAC_TARGET_NOT_FOUND', 404, 'Target account does not exist.');
  }
  if (target.banStatus && target.banStatus !== 'ACTIVE') {
    throw roleManagementError('RBAC_TARGET_NOT_ACTIVE', 409, 'Target account is banned and cannot hold a specialized admin role.');
  }
  return target;
}

async function assertLockoutSafe(tx, targetId, wouldRemoveSuper) {
  if (!wouldRemoveSuper) return;
  // Count OTHER active Super Admins (live assignment + live ADMIN account).
  const [row] = await tx.$queryRaw`
    SELECT COUNT(*)::int AS remaining
    FROM "AdminRoleAssignment" a
    JOIN "User" u ON u.id = a."userId"
    WHERE a.role = 'SUPER_ADMIN'
      AND u.role = 'ADMIN'
      AND u."isDeleted" = false
      AND u."banStatus" = 'ACTIVE'
      AND a."userId" <> ${targetId}`;
  if (!row || row.remaining < 1) {
    throw roleManagementError('RBAC_SUPER_ADMIN_LOCKOUT', 409,
      'This change would leave the platform with no active Super Admin. Demote or deprovision another Super Admin only after designating a replacement.');
  }
}

// ── Handler: assign / change a specialized role for a target admin ─────────
async function assignAdminRole(req, res) {
  const prisma = req.app.get('prisma');
  try {
    const requestedRole = String(req.body?.role || '').trim().toUpperCase();
    if (!ASSIGNABLE_ROLES.includes(requestedRole)) {
      return res.status(400).json({
        success: false,
        code: 'RBAC_INVALID_ROLE',
        message: `Unknown role. Valid roles: ${ASSIGNABLE_ROLES.join(', ')}.`,
        assignableRoles: ASSIGNABLE_ROLES,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Serialize all role-management mutations: the SUPER_ADMIN lockout
      // check and the old→new transition must observe the latest committed
      // state, never a racy snapshot.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROLE_MANAGEMENT_LOCK_KEY})`;

      await authorizeMutation(tx, req);
      const target = await loadTarget(tx, req.params.id, req.user.id);

      if (String(target.role || '').toUpperCase() !== 'ADMIN') {
        throw roleManagementError('RBAC_TARGET_NOT_ADMIN', 400,
          'Specialized roles can only be assigned to accounts whose primary role is ADMIN.');
      }

      const previousEffectiveRole = await rbac.resolveEffectiveAdminRole(tx, target.id);
      const wouldRemoveSuper = previousEffectiveRole === 'SUPER_ADMIN' && requestedRole !== 'SUPER_ADMIN';
      await assertLockoutSafe(tx, target.id, wouldRemoveSuper);

      const assignment = await tx.adminRoleAssignment.upsert({
        where: { userId: target.id },
        create: { userId: target.id, role: requestedRole, assignedBy: req.user.id },
        update: { role: requestedRole, assignedBy: req.user.id },
      });

      // Audit is authoritative evidence — it belongs INSIDE the same
      // transaction as the change it describes.
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          actorName: req.user?.username || null,
          action: 'RBAC_ASSIGN_ADMIN_ROLE',
          targetType: 'USER',
          targetId: String(target.id),
          metadata: {
            targetUsername: target.username,
            oldEffectiveRole: previousEffectiveRole,
            newEffectiveRole: requestedRole,
            outcome: 'SUCCESS',
          },
          ipAddress: req.ip || null,
        },
      });

      // Re-check the authoritative resolver AFTER the transition: the
      // effective role must be exactly what was requested — never a silent
      // fallback to legacy full ADMIN.
      const effectiveRoleAfter = await rbac.resolveEffectiveAdminRole(tx, target.id);
      if (effectiveRoleAfter !== requestedRole) {
        throw roleManagementError('RBAC_TRANSITION_INCONSISTENT', 500,
          'Role change did not produce the requested effective role; rolled back.');
      }

      return { target, assignment, previousEffectiveRole, effectiveRoleAfter };
    });

    return res.status(200).json({
      success: true,
      message: 'Role assignment updated.',
      admin: {
        id: result.target.id,
        username: result.target.username,
        previousEffectiveRole: result.previousEffectiveRole,
        effectiveRole: result.effectiveRoleAfter,
        assignment: {
          role: result.assignment.role,
          assignedBy: result.assignment.assignedBy,
          assignedAt: result.assignment.assignedAt,
        },
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
}

// ── Handler: full deprovision (safe removal of ALL admin access) ───────────
async function deprovisionAdmin(req, res) {
  const prisma = req.app.get('prisma');
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROLE_MANAGEMENT_LOCK_KEY})`;

      await authorizeMutation(tx, req);
      const target = await loadTarget(tx, req.params.id, req.user.id);

      if (String(target.role || '').toUpperCase() !== 'ADMIN') {
        throw roleManagementError('RBAC_TARGET_NOT_ADMIN', 400,
          'Only administrative accounts can be deprovisioned.');
      }

      const previousEffectiveRole = await rbac.resolveEffectiveAdminRole(tx, target.id);
      await assertLockoutSafe(tx, target.id, previousEffectiveRole === 'SUPER_ADMIN');

      const removed = await tx.adminRoleAssignment.deleteMany({ where: { userId: target.id } });

      // Remove the primary admin role AND invalidate every outstanding
      // token in the SAME transaction: authMiddleware rejects tokens whose
      // tokenVersion claim is below the live value, so stale admin tokens
      // die with the assignment, not after.
      const updated = await tx.user.update({
        where: { id: target.id },
        data: {
          role: 'USER',
          tokenVersion: { increment: 1 },
        },
        select: { id: true, username: true, role: true, tokenVersion: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          actorName: req.user?.username || null,
          action: 'RBAC_DEPROVISION_ADMIN',
          targetType: 'USER',
          targetId: String(target.id),
          metadata: {
            targetUsername: target.username,
            oldEffectiveRole: previousEffectiveRole,
            newEffectiveRole: null,
            assignmentRemoved: removed.count > 0,
            tokenVersionInvalidated: true,
            outcome: 'SUCCESS',
          },
          ipAddress: req.ip || null,
        },
      });

      // Fail closed: after deprovisioning, the account must hold NO admin
      // powers at all — not even the legacy fallback.
      const effectiveRoleAfter = await rbac.resolveEffectiveAdminRole(tx, target.id);
      if (effectiveRoleAfter !== null) {
        throw roleManagementError('RBAC_DEPROVISION_INCOMPLETE', 500,
          'Deprovision did not fully remove administrative access; rolled back.');
      }

      return { target, updated, previousEffectiveRole };
    });

    return res.status(200).json({
      success: true,
      message: 'Administrator fully deprovisioned; outstanding tokens invalidated.',
      admin: {
        id: result.target.id,
        username: result.target.username,
        previousEffectiveRole: result.previousEffectiveRole,
        effectiveRole: null,
        primaryRole: result.updated.role,
        tokenVersion: result.updated.tokenVersion,
        tokenVersionInvalidated: true,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
}

module.exports = {
  ASSIGNABLE_ROLES,
  ROLE_MANAGEMENT_LOCK_KEY,
  listAdmins,
  assignAdminRole,
  deprovisionAdmin,
};
