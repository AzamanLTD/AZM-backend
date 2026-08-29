const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { hasPermission, getStaffProfile, recordActivity } = require('../services/controlPlaneService');

const router = express.Router();
router.use(protect);

const ADMIN_TYPES = new Set(['SUPER_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'COMPLIANCE_ADMIN', 'READ_ONLY_ADMIN']);
const AUTHORITY_CLASSES = new Set(['ADMIN', 'EMPLOYEE']);
const STAFF_STATUSES = new Set(['ACTIVE', 'SUSPENDED', 'INACTIVE']);
const PRESENCE = new Set(['ONLINE', 'AWAY', 'OFFLINE']);

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

async function actorProfile(req, p) {
  return getStaffProfile(p, Number(req.user.id));
}

async function isGlobalController(req, p) {
  const profile = await actorProfile(req, p);
  return Boolean(profile?.status === 'ACTIVE' && profile?.isGlobalSuperAdmin);
}

router.get('/staff', async (req, res) => {
  if (!(await authorize(req, 'staff.view'))) return deny(res, 'staff.view');
  try {
    const rows = await prisma(req).$queryRawUnsafe(`
      SELECT sp.id, sp."userId", sp."authorityClass", sp."adminType", sp."employeeType",
             sp."departmentId", sp."supervisorId", sp."isGlobalSuperAdmin", sp.status,
             sp.presence, sp."lastActiveAt", sp."createdAt", sp."updatedAt",
             u.username, u.email,
             d.name AS "departmentName"
      FROM "StaffProfile" sp
      JOIN "User" u ON u.id = sp."userId"
      LEFT JOIN "ControlDepartment" d ON d.id = sp."departmentId"
      ORDER BY sp."createdAt" DESC
    `);
    return res.json({ success: true, staff: rows });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane staff list failed');
    return res.status(500).json({ success: false, message: 'Failed to load staff.' });
  }
});

router.get('/staff/:id', async (req, res) => {
  if (!(await authorize(req, 'staff.view'))) return deny(res, 'staff.view');
  try {
    const rows = await prisma(req).$queryRawUnsafe(`
      SELECT sp.*, u.username, u.email, d.name AS "departmentName"
      FROM "StaffProfile" sp
      JOIN "User" u ON u.id = sp."userId"
      LEFT JOIN "ControlDepartment" d ON d.id = sp."departmentId"
      WHERE sp.id = $1
    `, Number(req.params.id));
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Staff profile not found.' });

    const permissions = await prisma(req).$queryRawUnsafe(`
      SELECT cp."key", cp.description, spg."expiresAt"
      FROM "StaffPermissionGrant" spg
      JOIN "ControlPermission" cp ON cp.id = spg."permissionId"
      WHERE spg."staffProfileId" = $1
      ORDER BY cp."key"
    `, Number(req.params.id));
    const duties = await prisma(req).$queryRawUnsafe(`
      SELECT sda.id, cd."key", cd.name, cd.description, sda.status, sda."assignedAt", sda."startedAt", sda."completedAt"
      FROM "StaffDutyAssignment" sda
      JOIN "ControlDuty" cd ON cd.id = sda."dutyId"
      WHERE sda."staffProfileId" = $1
      ORDER BY sda."assignedAt" DESC
    `, Number(req.params.id));

    return res.json({ success: true, staff: rows[0], permissions, duties });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load staff profile.' });
  }
});

router.post('/staff', async (req, res) => {
  if (!(await authorize(req, 'staff.manage'))) return deny(res, 'staff.manage');
  const { userId, authorityClass, adminType, employeeType, departmentId, supervisorId, isGlobalSuperAdmin = false } = req.body || {};
  const authority = String(authorityClass || '').toUpperCase();
  const admin = adminType ? String(adminType).toUpperCase() : null;
  if (!Number.isInteger(Number(userId)) || !AUTHORITY_CLASSES.has(authority)) {
    return res.status(400).json({ success: false, message: 'userId and a valid authorityClass are required.' });
  }
  if (authority === 'ADMIN' && (!admin || !ADMIN_TYPES.has(admin))) {
    return res.status(400).json({ success: false, message: 'A valid adminType is required for administrators.' });
  }
  if (authority === 'EMPLOYEE' && !employeeType) {
    return res.status(400).json({ success: false, message: 'employeeType is required for employees.' });
  }
  if (Boolean(isGlobalSuperAdmin) && admin !== 'SUPER_ADMIN') {
    return res.status(400).json({ success: false, message: 'Global super admin authority requires SUPER_ADMIN.' });
  }

  try {
    const p = prisma(req);
    const actorGlobal = await isGlobalController(req, p);
    const legacyAdminBootstrap = req.user.role === 'ADMIN';
    if (authority === 'ADMIN' && !actorGlobal && !legacyAdminBootstrap) {
      return res.status(403).json({ success: false, message: 'Only a global super admin may create administrator profiles.' });
    }
    if (Boolean(isGlobalSuperAdmin) && !actorGlobal) {
      return res.status(403).json({ success: false, message: 'Only a global super admin may grant global super-admin authority.' });
    }

    const user = await p.user.findUnique({ where: { id: Number(userId) }, select: { id: true } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    const existing = await getStaffProfile(p, Number(userId));
    if (existing) return res.status(409).json({ success: false, message: 'User already has a staff profile.' });

    const rows = await p.$queryRawUnsafe(`
      INSERT INTO "StaffProfile"
        ("userId", "authorityClass", "adminType", "employeeType", "departmentId", "supervisorId", "isGlobalSuperAdmin")
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, Number(userId), authority, admin, authority === 'EMPLOYEE' ? String(employeeType) : null,
       departmentId == null ? null : Number(departmentId), supervisorId == null ? null : Number(supervisorId), Boolean(isGlobalSuperAdmin));

    await recordActivity(p, {
      staffProfileId: rows[0].id,
      actorUserId: req.user.id,
      eventType: 'STAFF_PROFILE_CREATED',
      targetType: 'STAFF_PROFILE',
      targetId: rows[0].id,
      metadata: { authorityClass: authority, adminType: admin, employeeType: employeeType || null, isGlobalSuperAdmin: Boolean(isGlobalSuperAdmin) },
    });
    return res.status(201).json({ success: true, staff: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to create staff profile.' });
  }
});

router.patch('/staff/:id', async (req, res) => {
  if (!(await authorize(req, 'staff.manage'))) return deny(res, 'staff.manage');
  const allowed = ['status', 'presence', 'departmentId', 'supervisorId', 'employeeType', 'adminType'];
  const body = req.body || {};
  const status = body.status == null ? null : String(body.status).toUpperCase();
  const presence = body.presence == null ? null : String(body.presence).toUpperCase();
  if (status && !STAFF_STATUSES.has(status)) return res.status(400).json({ success: false, message: 'Invalid staff status.' });
  if (presence && !PRESENCE.has(presence)) return res.status(400).json({ success: false, message: 'Invalid presence.' });

  try {
    const p = prisma(req);
    const currentRows = await p.$queryRawUnsafe('SELECT * FROM "StaffProfile" WHERE id = $1', Number(req.params.id));
    const current = currentRows[0];
    if (!current) return res.status(404).json({ success: false, message: 'Staff profile not found.' });
    const actorGlobal = await isGlobalController(req, p);
    const authorityChange = Object.prototype.hasOwnProperty.call(body, 'adminType') || Object.prototype.hasOwnProperty.call(body, 'authorityClass') || Object.prototype.hasOwnProperty.call(body, 'isGlobalSuperAdmin');
    if (current.isGlobalSuperAdmin && !actorGlobal) return res.status(403).json({ success: false, message: 'Only a global super admin may modify a global super-admin profile.' });
    if (authorityChange && !actorGlobal) return res.status(403).json({ success: false, message: 'Only a global super admin may change staff authority.' });
    if (current.userId === Number(req.user.id) && (authorityChange || status === 'SUSPENDED' || status === 'INACTIVE')) {
      return res.status(403).json({ success: false, message: 'You cannot modify your own authority or deactivate your own staff profile.' });
    }
    if (Object.prototype.hasOwnProperty.call(body, 'isGlobalSuperAdmin') && Boolean(body.isGlobalSuperAdmin) && String(body.adminType || current.adminType).toUpperCase() !== 'SUPER_ADMIN') {
      return res.status(400).json({ success: false, message: 'Global super admin authority requires SUPER_ADMIN.' });
    }
    const nextAdmin = body.adminType == null ? current.adminType : String(body.adminType).toUpperCase();
    if (current.authorityClass === 'ADMIN' && !ADMIN_TYPES.has(nextAdmin)) return res.status(400).json({ success: false, message: 'Invalid adminType.' });

    const rows = await p.$queryRawUnsafe(`
      UPDATE "StaffProfile"
      SET status = COALESCE($2, status),
          presence = COALESCE($3, presence),
          "departmentId" = COALESCE($4, "departmentId"),
          "supervisorId" = COALESCE($5, "supervisorId"),
          "employeeType" = COALESCE($6, "employeeType"),
          "adminType" = COALESCE($7, "adminType"),
          "isGlobalSuperAdmin" = CASE WHEN $8::boolean IS NULL THEN "isGlobalSuperAdmin" ELSE $8::boolean END,
          "lastActiveAt" = CASE WHEN $3 IS NOT NULL THEN CURRENT_TIMESTAMP ELSE "lastActiveAt" END,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, Number(req.params.id), status, presence,
       body.departmentId == null ? null : Number(body.departmentId),
       body.supervisorId == null ? null : Number(body.supervisorId),
       body.employeeType == null ? null : String(body.employeeType), nextAdmin,
       Object.prototype.hasOwnProperty.call(body, 'isGlobalSuperAdmin') ? Boolean(body.isGlobalSuperAdmin) : null);

    await recordActivity(p, { staffProfileId: current.id, actorUserId: req.user.id, eventType: 'STAFF_PROFILE_UPDATED', targetType: 'STAFF_PROFILE', targetId: current.id, metadata: { fields: allowed.filter(k => Object.prototype.hasOwnProperty.call(body, k)) } });
    return res.json({ success: true, staff: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update staff profile.' });
  }
});

router.get('/permissions', async (req, res) => {
  if (!(await authorize(req, 'staff.view'))) return deny(res, 'staff.view');
  const rows = await prisma(req).$queryRawUnsafe('SELECT id, "key", description FROM "ControlPermission" WHERE "isActive" = TRUE ORDER BY "key"');
  return res.json({ success: true, permissions: rows });
});

router.put('/staff/:id/permissions', async (req, res) => {
  if (!(await authorize(req, 'staff.permissions.manage'))) return deny(res, 'staff.permissions.manage');
  const keys = Array.isArray(req.body?.permissions) ? [...new Set(req.body.permissions.map(String))] : [];
  try {
    const p = prisma(req);
    const staffId = Number(req.params.id);
    const actorGlobal = await isGlobalController(req, p);
    const staff = await p.$queryRawUnsafe('SELECT id, "userId", "isGlobalSuperAdmin" FROM "StaffProfile" WHERE id = $1', staffId);
    if (!staff[0]) return res.status(404).json({ success: false, message: 'Staff profile not found.' });
    if (staff[0].isGlobalSuperAdmin && !actorGlobal) return res.status(403).json({ success: false, message: 'Only a global super admin may modify global-super-admin permissions.' });
    const permissionRows = keys.length ? await p.$queryRawUnsafe('SELECT id, "key" FROM "ControlPermission" WHERE "key" = ANY($1::text[]) AND "isActive" = TRUE', keys) : [];
    if (permissionRows.length !== keys.length) return res.status(400).json({ success: false, message: 'One or more permissions are invalid or inactive.' });
    if (!actorGlobal) {
      const actorPermissions = await p.$queryRawUnsafe(`SELECT cp."key" FROM "StaffPermissionGrant" spg JOIN "ControlPermission" cp ON cp.id = spg."permissionId" WHERE spg."staffProfileId" = (SELECT id FROM "StaffProfile" WHERE "userId" = $1) AND cp."isActive" = TRUE AND (spg."expiresAt" IS NULL OR spg."expiresAt" > CURRENT_TIMESTAMP)`, Number(req.user.id));
      const allowed = new Set(actorPermissions.map((row) => row.key));
      if (keys.some((key) => !allowed.has(key))) return res.status(403).json({ success: false, message: 'You cannot grant a permission you do not possess.' });
    }
    await p.$queryRawUnsafe('DELETE FROM "StaffPermissionGrant" WHERE "staffProfileId" = $1', staffId);
    for (const permission of permissionRows) {
      await p.$queryRawUnsafe('INSERT INTO "StaffPermissionGrant" ("staffProfileId", "permissionId", "grantedByUserId") VALUES ($1, $2, $3)', staffId, permission.id, Number(req.user.id));
    }
    await recordActivity(p, { staffProfileId: staffId, actorUserId: req.user.id, eventType: 'STAFF_PERMISSIONS_REPLACED', targetType: 'STAFF_PROFILE', targetId: staffId, metadata: { permissions: keys } });
    return res.json({ success: true, permissions: permissionRows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update staff permissions.' });
  }
});

router.get('/duties', async (req, res) => {
  if (!(await authorize(req, 'staff.view'))) return deny(res, 'staff.view');
  const rows = await prisma(req).$queryRawUnsafe(`
    SELECT cd.id, cd."key", cd.name, cd.description, cd."departmentId", d.name AS "departmentName"
    FROM "ControlDuty" cd LEFT JOIN "ControlDepartment" d ON d.id = cd."departmentId"
    WHERE cd."isActive" = TRUE ORDER BY cd.name
  `);
  return res.json({ success: true, duties: rows });
});

router.post('/staff/:id/duties', async (req, res) => {
  if (!(await authorize(req, 'staff.duties.manage'))) return deny(res, 'staff.duties.manage');
  const dutyKey = String(req.body?.dutyKey || '').trim();
  if (!dutyKey) return res.status(400).json({ success: false, message: 'dutyKey is required.' });
  try {
    const p = prisma(req);
    const staffId = Number(req.params.id);
    const duty = await p.$queryRawUnsafe('SELECT id, "key", name FROM "ControlDuty" WHERE "key" = $1 AND "isActive" = TRUE', dutyKey);
    if (!duty[0]) return res.status(404).json({ success: false, message: 'Duty not found.' });
    const staff = await p.$queryRawUnsafe('SELECT id FROM "StaffProfile" WHERE id = $1', staffId);
    if (!staff[0]) return res.status(404).json({ success: false, message: 'Staff profile not found.' });
    const rows = await p.$queryRawUnsafe(`
      INSERT INTO "StaffDutyAssignment" ("staffProfileId", "dutyId", "assignedByUserId")
      VALUES ($1, $2, $3)
      ON CONFLICT ("staffProfileId", "dutyId") DO UPDATE SET status = 'ACTIVE', "assignedAt" = CURRENT_TIMESTAMP
      RETURNING *
    `, staffId, duty[0].id, Number(req.user.id));
    await recordActivity(p, { staffProfileId: staffId, actorUserId: req.user.id, eventType: 'DUTY_ASSIGNED', targetType: 'DUTY', targetId: duty[0].id, metadata: { dutyKey } });
    return res.status(201).json({ success: true, assignment: rows[0], duty: duty[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to assign duty.' });
  }
});

router.delete('/staff/:id/duties/:dutyId', async (req, res) => {
  if (!(await authorize(req, 'staff.duties.manage'))) return deny(res, 'staff.duties.manage');
  try {
    const p = prisma(req);
    const rows = await p.$queryRawUnsafe(`UPDATE "StaffDutyAssignment" SET status = 'REVOKED' WHERE "staffProfileId" = $1 AND "dutyId" = $2 RETURNING *`, Number(req.params.id), Number(req.params.dutyId));
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Duty assignment not found.' });
    await recordActivity(p, { staffProfileId: Number(req.params.id), actorUserId: req.user.id, eventType: 'DUTY_REVOKED', targetType: 'DUTY', targetId: Number(req.params.dutyId) });
    return res.json({ success: true, assignment: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to revoke duty.' });
  }
});

router.get('/staff/:id/activity', async (req, res) => {
  if (!(await authorize(req, 'staff.activity.view'))) return deny(res, 'staff.activity.view');
  const rows = await prisma(req).$queryRawUnsafe(`SELECT id, "eventType", "targetType", "targetId", metadata, "createdAt" FROM "StaffActivityEvent" WHERE "staffProfileId" = $1 ORDER BY "createdAt" DESC LIMIT 200`, Number(req.params.id));
  return res.json({ success: true, events: rows });
});

module.exports = router;
