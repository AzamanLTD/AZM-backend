// scripts/bootstrapSuperAdmin.js
// =============================================================================
// r272 follow-up — ONE-TIME, operator-run bootstrap of the initial Super Admin.
//
// Initialization problem being solved: ongoing role management (and every
// HTTP role-management endpoint) requires an AUTHORITATIVE SUPER_ADMIN
// designation in AdminRoleAssignment, but a fresh deployment has none —
// so there must be a controlled first-entry mechanism. This CLI is that
// mechanism: it is run deliberately by an operator with database access.
// It is deliberately NOT an HTTP endpoint — no unauthenticated or
// generally available backdoor exists.
//
// Safety properties (fail closed):
//   • Requires an EXPLICIT target user id AND a deliberate --confirm flag.
//     It never infers or selects an arbitrary account.
//   • Verifies the target exists, is not deleted, is not banned, and its
//     primary role is ADMIN.
//   • Refuses to run when ANY active SUPER_ADMIN designation already
//     exists (prevents duplicate or conflicting initial bootstraps),
//     except for an idempotent re-run targeting the SAME already-bootstrapped
//     account, which succeeds without writing anything.
//   • All writes (assignment + audit event) happen in ONE transaction under
//     the same advisory lock used by the role-management endpoints.
//   • Safe to re-run: preconditions are re-checked on every execution and
//     the script exits non-zero when they no longer hold.
//   • Never logs credentials, tokens, or secrets — only user ids and
//     usernames.
//
// Usage:
//   DATABASE_URL=<production database url> \
//     node scripts/bootstrapSuperAdmin.js --user-id <ADMIN_USER_ID> --confirm
//
// See docs/RBAC_SUPER_ADMIN_BOOTSTRAP.md for the full operational runbook.
// =============================================================================

const { PrismaClient } = require('@prisma/client');

// Must match controllers/adminRoleAdminController.js so the bootstrap
// serializes with HTTP role-management mutations.
const ROLE_MANAGEMENT_LOCK_KEY = 87272111;

// ── Transactional core (also imported by regression tests) ──────────────────
// `db` is a PrismaClient (or a transaction client). Returns a result object;
// throws with `.code`, `.exitCode`, and `.message` on refusal.
async function bootstrapSuperAdmin(db, targetUserId, { confirmed = false } = {}) {
  const targetId = Number(targetUserId);

  if (!Number.isInteger(targetId) || targetId <= 0) {
    const err = new Error('An explicit target user id is required (--user-id <id>).');
    err.code = 'BOOTSTRAP_TARGET_REQUIRED';
    err.exitCode = 2;
    throw err;
  }
  if (confirmed !== true) {
    const err = new Error('Deliberate operator confirmation is required: re-run with --confirm.');
    err.code = 'BOOTSTRAP_CONFIRMATION_REQUIRED';
    err.exitCode = 2;
    throw err;
  }

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROLE_MANAGEMENT_LOCK_KEY})`;

    const target = await tx.user.findUnique({
      where: { id: targetId },
      select: { id: true, username: true, email: true, role: true, banStatus: true, isDeleted: true },
    });

    if (!target || target.isDeleted) {
      const err = new Error(`Target user ${targetId} does not exist.`);
      err.code = 'BOOTSTRAP_TARGET_NOT_FOUND';
      err.exitCode = 3;
      throw err;
    }
    if (target.banStatus && target.banStatus !== 'ACTIVE') {
      const err = new Error(`Target user ${targetId} (${target.username}) is banned and cannot be bootstrapped.`);
      err.code = 'BOOTSTRAP_TARGET_NOT_ELIGIBLE';
      err.exitCode = 3;
      throw err;
    }
    if (String(target.role || '').toUpperCase() !== 'ADMIN') {
      const err = new Error(
        `Target user ${targetId} (${target.username}) has primary role ${target.role}; only active ADMIN accounts are eligible.`
      );
      err.code = 'BOOTSTRAP_TARGET_NOT_ADMIN';
      err.exitCode = 3;
      throw err;
    }

    // Refuse when any ACTIVE Super Admin already exists. Idempotent re-run
    // on an account that is ALREADY the (still-active) Super Admin is the
    // only exception and writes nothing.
    const targetAssignment = await tx.adminRoleAssignment.findUnique({ where: { userId: targetId } });
    const targetIsSuper = targetAssignment?.role === 'SUPER_ADMIN';
    if (targetIsSuper) {
      return {
        alreadyBootstrapped: true,
        targetId,
        username: target.username,
      };
    }
    const [row] = await tx.$queryRaw`
      SELECT a."userId" AS "userId"
      FROM "AdminRoleAssignment" a
      JOIN "User" u ON u.id = a."userId"
      WHERE a.role = 'SUPER_ADMIN'
        AND u.role = 'ADMIN'
        AND u."isDeleted" = false
        AND u."banStatus" = 'ACTIVE'
      LIMIT 1`;
    if (row) {
      const err = new Error(
        `A Super Admin already exists (user ${row.userId}). Bootstrap preconditions are consumed; ` +
        'use the role-management endpoints as that Super Admin instead.'
      );
      err.code = 'BOOTSTRAP_ALREADY_DONE';
      err.exitCode = 4;
      throw err;
    }

    const previousEffectiveRole = 'ADMIN'; // legacy fallback, pre-bootstrap
    const assignment = await tx.adminRoleAssignment.create({
      data: { userId: targetId, role: 'SUPER_ADMIN', assignedBy: null },
    });

    // Auditable provisioning event — actor is the operator/system (no HTTP
    // actor exists for a CLI run). No secrets are recorded.
    await tx.auditLog.create({
      data: {
        actorId: null,
        actorName: 'operator-cli',
        action: 'RBAC_BOOTSTRAP_SUPER_ADMIN',
        targetType: 'USER',
        targetId: String(targetId),
        metadata: {
          targetUsername: target.username,
          oldEffectiveRole: previousEffectiveRole,
          newEffectiveRole: 'SUPER_ADMIN',
          operatedBy: 'operator-cli',
          confirmed: true,
          outcome: 'SUCCESS',
        },
      },
    });

    return {
      alreadyBootstrapped: false,
      targetId,
      username: target.username,
      assignmentId: assignment.id,
      previousEffectiveRole,
      newEffectiveRole: 'SUPER_ADMIN',
    };
  });
}

// ── CLI entry point ────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const userIdArg = args.find((a) => a.startsWith('--user-id='));
  const positionalId = !userIdArg && args[args.indexOf('--user-id') + 1];
  const rawId = userIdArg ? userIdArg.split('=')[1] : positionalId;
  const confirmed = args.includes('--confirm');

  if (args.includes('--help') || args.includes('-h') || !rawId) {
    console.log([
      'Usage: node scripts/bootstrapSuperAdmin.js --user-id <ADMIN_USER_ID> --confirm',
      '',
      'Designates the given active ADMIN account as the initial Super Admin.',
      'Requires an explicit target id and the deliberate --confirm flag.',
      'Refuses to run if an active Super Admin already exists (idempotent for',
      'the same target). See docs/RBAC_SUPER_ADMIN_BOOTSTRAP.md.',
    ].join('\n'));
    process.exit(2);
  }

  const prisma = new PrismaClient();
  let exitCode = 0;
  try {
    const result = await bootstrapSuperAdmin(prisma, rawId, { confirmed });
    if (result.alreadyBootstrapped) {
      console.log(
        `Idempotent no-op: user ${result.targetId} (${result.username}) is already the bootstrapped Super Admin. Nothing written.`
      );
    } else {
      console.log(
        `Bootstrapped user ${result.targetId} (${result.username}) as SUPER_ADMIN ` +
        `(assignment #${result.assignmentId}, audit event RBAC_BOOTSTRAP_SUPER_ADMIN recorded).`
      );
    }
  } catch (err) {
    console.error(`Bootstrap refused [${err.code || 'ERROR'}]: ${err.message}`);
    exitCode = err.exitCode || 1;
  }
  await prisma.$disconnect();
  process.exit(exitCode);
}

module.exports = { bootstrapSuperAdmin, ROLE_MANAGEMENT_LOCK_KEY };

if (require.main === module) {
  main().catch((err) => {
    console.error(`Bootstrap failed: ${err.message}`);
    process.exit(1);
  });
}
