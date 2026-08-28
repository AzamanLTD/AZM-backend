const { randomUUID } = require('crypto');

/**
 * Durable platform staff/access operations.
 *
 * This service intentionally uses parameterized raw SQL because the control
 * plane tables are introduced additively before the very large Prisma schema
 * is regenerated. Once the schema is regenerated, these queries can be
 * migrated to typed Prisma calls without changing the public service API.
 */

const ADMIN_TYPES = new Set([
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'SUPPORT_ADMIN',
  'COMPLIANCE_ADMIN',
  'READ_ONLY_ADMIN',
]);

const STAFF_TYPES = new Set(['ADMIN', 'EMPLOYEE']);

async function getStaffProfile(prisma, userId) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT * FROM "PlatformStaffProfile" WHERE "userId" = $1 LIMIT 1',
    userId
  );
  return rows[0] || null;
}

async function hasPermission(prisma, userId, permissionKey) {
  const profile = await getStaffProfile(prisma, userId);
  if (!profile || profile.status !== 'ACTIVE') return false;
  if (profile.isCeo || profile.adminType === 'SUPER_ADMIN') return true;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1
       FROM "PlatformStaffPermission" sp
       JOIN "PlatformPermission" p ON p."id" = sp."permissionId"
      WHERE sp."staffProfileId" = $1 AND p."key" = $2
      LIMIT 1`,
    profile.id,
    permissionKey
  );
  return rows.length > 0;
}

async function upsertStaffProfile(prisma, {
  userId,
  staffType,
  adminType = null,
  employeeType = null,
  department = null,
  title = null,
  isCeo = false,
  status = 'ACTIVE',
}) {
  if (!Number.isInteger(userId)) throw new TypeError('userId must be an integer');
  if (!STAFF_TYPES.has(staffType)) throw new TypeError('invalid staffType');
  if (adminType !== null && !ADMIN_TYPES.has(adminType)) throw new TypeError('invalid adminType');
  if (!['ACTIVE', 'SUSPENDED', 'TERMINATED', 'ON_LEAVE'].includes(status)) {
    throw new TypeError('invalid status');
  }
  if (isCeo && staffType !== 'ADMIN') throw new TypeError('CEO must be an ADMIN staff profile');
  if (isCeo && adminType !== 'SUPER_ADMIN') throw new TypeError('CEO must be SUPER_ADMIN');

  const id = randomUUID();
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "PlatformStaffProfile"
      ("id","userId","staffType","adminType","employeeType","department","title","isCeo","status","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP)
     ON CONFLICT ("userId") DO UPDATE SET
       "staffType" = EXCLUDED."staffType",
       "adminType" = EXCLUDED."adminType",
       "employeeType" = EXCLUDED."employeeType",
       "department" = EXCLUDED."department",
       "title" = EXCLUDED."title",
       "isCeo" = EXCLUDED."isCeo",
       "status" = EXCLUDED."status",
       "updatedAt" = CURRENT_TIMESTAMP
     RETURNING *`,
    id, userId, staffType, adminType, employeeType, department, title, isCeo, status
  );
  return rows[0];
}

async function grantPermission(prisma, { staffProfileId, permissionKey, grantedByUserId = null }) {
  const permissions = await prisma.$queryRawUnsafe(
    'SELECT "id" FROM "PlatformPermission" WHERE "key" = $1 LIMIT 1',
    permissionKey
  );
  if (!permissions[0]) throw new Error(`Unknown platform permission: ${permissionKey}`);

  const id = randomUUID();
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "PlatformStaffPermission"
      ("id","staffProfileId","permissionId","grantedByUserId")
     VALUES ($1,$2,$3,$4)
     ON CONFLICT ("staffProfileId","permissionId") DO UPDATE SET
       "grantedByUserId" = EXCLUDED."grantedByUserId"
     RETURNING *`,
    id, staffProfileId, permissions[0].id, grantedByUserId
  );
  return rows[0];
}

async function assignDuty(prisma, { staffProfileId, dutyKey, assignedByUserId = null }) {
  const duties = await prisma.$queryRawUnsafe(
    'SELECT "id" FROM "PlatformDuty" WHERE "key" = $1 LIMIT 1',
    dutyKey
  );
  if (!duties[0]) throw new Error(`Unknown platform duty: ${dutyKey}`);

  const id = randomUUID();
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "PlatformStaffDuty"
      ("id","staffProfileId","dutyId","assignedByUserId")
     VALUES ($1,$2,$3,$4)
     ON CONFLICT ("staffProfileId","dutyId") DO UPDATE SET
       "assignedByUserId" = EXCLUDED."assignedByUserId",
       "assignedAt" = CURRENT_TIMESTAMP,
       "endedAt" = NULL
     RETURNING *`,
    id, staffProfileId, duties[0].id, assignedByUserId
  );
  return rows[0];
}

async function touchActivity(prisma, userId, at = new Date()) {
  await prisma.$executeRawUnsafe(
    'UPDATE "PlatformStaffProfile" SET "lastActiveAt" = $1 WHERE "userId" = $2',
    at,
    userId
  );
}

module.exports = {
  ADMIN_TYPES,
  STAFF_TYPES,
  getStaffProfile,
  hasPermission,
  upsertStaffProfile,
  grantPermission,
  assignDuty,
  touchActivity,
};
