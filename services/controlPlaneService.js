// Durable control-plane access service.
// Uses the existing Prisma connection through req.app.get('prisma') so this
// additive layer does not require changing the existing User.role enum.

const ADMIN_ROLES = new Set([
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'SUPPORT_ADMIN',
  'COMPLIANCE_ADMIN',
  'READ_ONLY_ADMIN',
]);

const LEGACY_ADMIN_PERMISSION = '*';

function normalize(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

async function getStaffProfile(prisma, userId) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT sp.*, u.username, u.email
    FROM "StaffProfile" sp
    JOIN "User" u ON u.id = sp."userId"
    WHERE sp."userId" = $1
    LIMIT 1
  `, Number(userId));
  return rows[0] || null;
}

async function hasPermission(prisma, user, permission) {
  if (!user) return false;
  if (normalize(user.role) === 'ADMIN') return true;

  const staff = await getStaffProfile(prisma, user.id);
  if (!staff || staff.status !== 'ACTIVE') return false;
  if (staff.isGlobalSuperAdmin) return true;

  const adminType = normalize(staff.adminType);
  if (adminType === 'SUPER_ADMIN' && staff.isGlobalSuperAdmin) return true;
  if (!ADMIN_ROLES.has(adminType) && normalize(staff.authorityClass) !== 'EMPLOYEE') return false;

  const rows = await prisma.$queryRawUnsafe(`
    SELECT cp."key"
    FROM "StaffPermissionGrant" spg
    JOIN "ControlPermission" cp ON cp.id = spg."permissionId"
    WHERE spg."staffProfileId" = $1
      AND cp."isActive" = TRUE
      AND (spg."expiresAt" IS NULL OR spg."expiresAt" > CURRENT_TIMESTAMP)
  `, Number(staff.id));

  return rows.some(row => row.key === LEGACY_ADMIN_PERMISSION || row.key === permission);
}

async function requirePermission(prisma, user, permission) {
  return hasPermission(prisma, user, permission);
}

async function recordActivity(prisma, { staffProfileId = null, actorUserId = null, eventType, targetType = null, targetId = null, metadata = {} }) {
  await prisma.$queryRawUnsafe(`
    INSERT INTO "StaffActivityEvent"
      ("staffProfileId", "actorUserId", "eventType", "targetType", "targetId", "metadata")
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  `, staffProfileId == null ? null : Number(staffProfileId), actorUserId == null ? null : Number(actorUserId), eventType, targetType, targetId == null ? null : String(targetId), JSON.stringify(metadata));
}

module.exports = {
  getStaffProfile,
  hasPermission,
  requirePermission,
  recordActivity,
};
