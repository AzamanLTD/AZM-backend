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

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sanitizeActivityMetadata(value) {
  const blocked = new Set([
    'password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'authorization',
    'secret', 'clientSecret', 'apiKey', 'privateKey', 'otp', 'code', 'sessionToken',
  ]);
  if (Array.isArray(value)) return value.map(sanitizeActivityMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !blocked.has(key) && !/password|token|secret|authorization|private.?key|api.?key/i.test(key))
      .map(([key, entry]) => [key, sanitizeActivityMetadata(entry)])
  );
}

async function loadStaffById(p, staffId) {
  const rows = await p.$queryRawUnsafe('SELECT * FROM "StaffProfile" WHERE id = $1', staffId);
  return rows[0] || null;
}

async function assertStaffLifecycleMutable(req, p, staff, nextStatus) {
  const actorGlobal = await isGlobalController(req, p);
  if (staff.isGlobalSuperAdmin && !actorGlobal) {
    return { ok: false, status: 403, message: 'Only a global super admin may modify a global super-admin profile.' };
  }
  if (staff.userId === Number(req.user.id) && ['SUSPENDED', 'INACTIVE'].includes(nextStatus)) {
    return { ok: false, status: 403, message: 'You cannot suspend or deactivate your own staff profile.' };
  }
  return { ok: true };
}

async function transitionStaffLifecycle(req, res, nextStatus, eventType) {
  if (!(await authorize(req, 'staff.manage'))) return deny(res, 'staff.manage');
  const staffId = parsePositiveInt(req.params.id);
  if (!staffId) return res.status(400).json({ success: false, message: 'Valid staff id is required.' });
  const reason = cleanText(req.body?.reason);
  if (['SUSPENDED', 'INACTIVE'].includes(nextStatus) && reason.length < 3) {
    return res.status(400).json({ success: false, message: 'A reason is required for this staff lifecycle change.' });
  }
  if (reason.length > 500) {
    return res.status(400).json({ success: false, message: 'Reason cannot exceed 500 characters.' });
  }

  try {
    const p = prisma(req);
    const current = await loadStaffById(p, staffId);
    if (!current) return res.status(404).json({ success: false, message: 'Staff profile not found.' });
    const mutable = await assertStaffLifecycleMutable(req, p, current, nextStatus);
    if (!mutable.ok) return res.status(mutable.status).json({ success: false, message: mutable.message });

    const nextPresence = nextStatus === 'ACTIVE' ? current.presence : 'OFFLINE';
    const rows = await p.$queryRawUnsafe(`
      UPDATE "StaffProfile"
      SET status = $2,
          presence = $3,
          "lastActiveAt" = CASE WHEN $3 != presence THEN CURRENT_TIMESTAMP ELSE "lastActiveAt" END,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, staffId, nextStatus, nextPresence);

    const actor = await actorProfile(req, p);
    await recordActivity(p, {
      staffProfileId: staffId,
      actorUserId: req.user.id,
      eventType,
      targetType: 'STAFF_PROFILE',
      targetId: staffId,
      metadata: { beforeStatus: current.status, afterStatus: nextStatus, beforePresence: current.presence, afterPresence: nextPresence, reason: reason || null, actorStaffProfileId: actor?.id || null },
    });
    return res.json({ success: true, staff: rows[0] });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane staff lifecycle transition failed');
    return res.status(500).json({ success: false, message: 'Failed to update staff lifecycle.' });
  }
}

router.post('/me/presence', async (req, res) => {
  const presence = String(req.body?.presence || '').toUpperCase();
  if (!PRESENCE.has(presence)) return res.status(400).json({ success: false, message: 'Invalid presence.' });
  try {
    const p = prisma(req);
    const staff = await actorProfile(req, p);
    if (!staff) return res.status(403).json({ success: false, message: 'Staff profile is required to update presence.' });
    if (staff.status !== 'ACTIVE') return res.status(403).json({ success: false, message: 'Inactive or suspended staff cannot update presence.' });

    const rows = await p.$queryRawUnsafe(`
      UPDATE "StaffProfile"
      SET presence = $2, "lastActiveAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, Number(staff.id), presence);
    await recordActivity(p, {
      staffProfileId: staff.id,
      actorUserId: req.user.id,
      eventType: 'STAFF_PRESENCE_UPDATED',
      targetType: 'STAFF_PROFILE',
      targetId: staff.id,
      metadata: { beforePresence: staff.presence, afterPresence: presence },
    });
    return res.json({ success: true, staff: rows[0] });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane presence update failed');
    return res.status(500).json({ success: false, message: 'Failed to update presence.' });
  }
});

router.get('/presence', async (req, res) => {
  if (!(await authorize(req, 'staff.view'))) return deny(res, 'staff.view');
  try {
    const rows = await prisma(req).$queryRawUnsafe(`
      SELECT sp.id, sp."userId", sp.presence, sp."lastActiveAt", sp.status,
             sp."departmentId", d.name AS "departmentName",
             u.username, u.email,
             COUNT(sda.id)::int AS "activeDutyCount"
      FROM "StaffProfile" sp
      JOIN "User" u ON u.id = sp."userId"
      LEFT JOIN "ControlDepartment" d ON d.id = sp."departmentId"
      LEFT JOIN "StaffDutyAssignment" sda ON sda."staffProfileId" = sp.id AND sda.status = 'ACTIVE'
      GROUP BY sp.id, d.name, u.username, u.email
      ORDER BY
        CASE sp.presence WHEN 'ONLINE' THEN 1 WHEN 'AWAY' THEN 2 ELSE 3 END,
        sp."lastActiveAt" DESC NULLS LAST
    `);
    return res.json({ success: true, presence: rows });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane presence list failed');
    return res.status(500).json({ success: false, message: 'Failed to load staff presence.' });
  }
});

router.post('/staff/:id/suspend', async (req, res) => transitionStaffLifecycle(req, res, 'SUSPENDED', 'STAFF_SUSPENDED'));
router.post('/staff/:id/activate', async (req, res) => transitionStaffLifecycle(req, res, 'ACTIVE', 'STAFF_ACTIVATED'));
router.post('/staff/:id/deactivate', async (req, res) => transitionStaffLifecycle(req, res, 'INACTIVE', 'STAFF_DEACTIVATED'));

router.get('/departments', async (req, res) => {
  if (!(await authorize(req, 'staff.view'))) return deny(res, 'staff.view');
  try {
    const rows = await prisma(req).$queryRawUnsafe(`
      SELECT d.id, d.name, d.description, d."isActive", d."createdAt", d."updatedAt",
             COUNT(sp.id)::int AS "staffCount"
      FROM "ControlDepartment" d
      LEFT JOIN "StaffProfile" sp ON sp."departmentId" = d.id
      GROUP BY d.id
      ORDER BY d.name ASC
    `);
    return res.json({ success: true, departments: rows });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane department list failed');
    return res.status(500).json({ success: false, message: 'Failed to load departments.' });
  }
});

router.post('/departments', async (req, res) => {
  if (!(await authorize(req, 'departments.manage'))) return deny(res, 'departments.manage');
  const name = cleanText(req.body?.name);
  const description = cleanText(req.body?.description) || null;
  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ success: false, message: 'Department name must be between 2 and 80 characters.' });
  }
  if (description && description.length > 500) {
    return res.status(400).json({ success: false, message: 'Department description cannot exceed 500 characters.' });
  }

  try {
    const p = prisma(req);
    const rows = await p.$queryRawUnsafe(`
      INSERT INTO "ControlDepartment" (name, description)
      VALUES ($1, $2)
      RETURNING *
    `, name, description);
    const actor = await actorProfile(req, p);
    await recordActivity(p, {
      staffProfileId: actor?.id || null,
      actorUserId: req.user.id,
      eventType: 'DEPARTMENT_CREATED',
      targetType: 'CONTROL_DEPARTMENT',
      targetId: rows[0].id,
      metadata: { name, description },
    });
    return res.status(201).json({ success: true, department: rows[0] });
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ success: false, message: 'Department already exists.' });
    req.app.get('logger')?.error?.({ err }, 'control-plane department create failed');
    return res.status(500).json({ success: false, message: 'Failed to create department.' });
  }
});

router.patch('/departments/:id', async (req, res) => {
  if (!(await authorize(req, 'departments.manage'))) return deny(res, 'departments.manage');
  const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, 'name');
  const hasDescription = Object.prototype.hasOwnProperty.call(req.body || {}, 'description');
  const hasIsActive = Object.prototype.hasOwnProperty.call(req.body || {}, 'isActive');
  if (!hasName && !hasDescription && !hasIsActive) {
    return res.status(400).json({ success: false, message: 'At least one department field is required.' });
  }

  const name = hasName ? cleanText(req.body.name) : null;
  const description = hasDescription ? cleanText(req.body.description) || null : null;
  if (hasIsActive && typeof req.body.isActive !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isActive must be a boolean.' });
  }
  const isActive = hasIsActive ? req.body.isActive : null;
  if (hasName && (name.length < 2 || name.length > 80)) {
    return res.status(400).json({ success: false, message: 'Department name must be between 2 and 80 characters.' });
  }
  if (description && description.length > 500) {
    return res.status(400).json({ success: false, message: 'Department description cannot exceed 500 characters.' });
  }

  try {
    const departmentId = parsePositiveInt(req.params.id);
    if (!departmentId) return res.status(400).json({ success: false, message: 'Valid department id is required.' });
    const p = prisma(req);
    const currentRows = await p.$queryRawUnsafe('SELECT * FROM "ControlDepartment" WHERE id = $1', departmentId);
    if (!currentRows[0]) return res.status(404).json({ success: false, message: 'Department not found.' });
    const rows = await p.$queryRawUnsafe(`
      UPDATE "ControlDepartment"
      SET name = CASE WHEN $2::text IS NULL THEN name ELSE $2::text END,
          description = CASE WHEN $3::boolean THEN $4::text ELSE description END,
          "isActive" = CASE WHEN $5::boolean IS NULL THEN "isActive" ELSE $5::boolean END,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, departmentId, hasName ? name : null, hasDescription, description, hasIsActive ? isActive : null);
    const actor = await actorProfile(req, p);
    await recordActivity(p, {
      staffProfileId: actor?.id || null,
      actorUserId: req.user.id,
      eventType: 'DEPARTMENT_UPDATED',
      targetType: 'CONTROL_DEPARTMENT',
      targetId: rows[0].id,
      metadata: {
        fields: ['name', 'description', 'isActive'].filter((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field)),
        before: currentRows[0],
        after: rows[0],
      },
    });
    return res.json({ success: true, department: rows[0] });
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ success: false, message: 'Department already exists.' });
    req.app.get('logger')?.error?.({ err }, 'control-plane department update failed');
    return res.status(500).json({ success: false, message: 'Failed to update department.' });
  }
});

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

router.get('/activity', async (req, res) => {
  if (!(await authorize(req, 'staff.activity.view'))) return deny(res, 'staff.activity.view');

  const limitValue = req.query.limit == null ? 50 : Number(req.query.limit);
  const pageValue = req.query.page == null ? 1 : Number(req.query.page);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) {
    return res.status(400).json({ success: false, message: 'limit must be an integer between 1 and 100.' });
  }
  if (!Number.isInteger(pageValue) || pageValue < 1 || pageValue > 10000) {
    return res.status(400).json({ success: false, message: 'page must be an integer between 1 and 10000.' });
  }

  const staffId = req.query.staffId == null ? null : parsePositiveInt(req.query.staffId);
  const actorUserId = req.query.actorUserId == null ? null : parsePositiveInt(req.query.actorUserId);
  const targetId = req.query.targetId == null ? null : cleanText(req.query.targetId);
  const eventType = req.query.eventType == null ? null : cleanText(req.query.eventType);
  const targetType = req.query.targetType == null ? null : cleanText(req.query.targetType);
  const startAt = req.query.startAt == null ? null : parseDate(req.query.startAt);
  const endAt = req.query.endAt == null ? null : parseDate(req.query.endAt);

  if (req.query.staffId != null && !staffId) return res.status(400).json({ success: false, message: 'staffId must be a positive integer.' });
  if (req.query.actorUserId != null && !actorUserId) return res.status(400).json({ success: false, message: 'actorUserId must be a positive integer.' });
  if (req.query.targetId != null && !targetId) return res.status(400).json({ success: false, message: 'targetId cannot be empty.' });
  if (req.query.eventType != null && !eventType) return res.status(400).json({ success: false, message: 'eventType cannot be empty.' });
  if (req.query.targetType != null && !targetType) return res.status(400,).json({ success: false, message: 'targetType cannot be empty.' });
  if (req.query.startAt != null && !startAt) return res.status(400).json({ success: false, message: 'startAt must be a valid date.' });
  if (req.query.endAt != null && !endAt) return res.status(400).json({ success: false, message: 'endAt must be a valid date.' });
  if (startAt && endAt && startAt > endAt) return res.status(400).json({ success: false, message: 'startAt cannot be after endAt.' });

  try {
    const p = prisma(req);
    const where = [];
    const params = [];
    const addParam = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (staffId) where.push(`ae."staffProfileId" = ${addParam(staffId)}`);
    if (actorUserId) where.push(`ae."actorUserId" = ${addParam(actorUserId)}`);
    if (eventType) where.push(`ae."eventType" = ${addParam(eventType)}`);
    if (targetType) where.push(`ae."targetType" = ${addParam(targetType)}`);
    if (targetId) where.push(`ae."targetId" = ${addParam(targetId)}`);
    if (startAt) where.push(`ae."createdAt" >= ${addParam(startAt)}`);
    if (endAt) where.push(`ae."createdAt" <= ${addParam(endAt)}`);

    const offset = (pageValue - 1) * limitValue;
    const limitParam = addParam(limitValue + 1);
    const offsetParam = addParam(offset);
    const rows = await p.$queryRawUnsafe(`
      SELECT ae.id, ae."staffProfileId", ae."actorUserId", ae."eventType", ae."targetType", ae."targetId", ae.metadata, ae."createdAt",
             actor.username AS "actorUsername", actor.email AS "actorEmail",
             subject.username AS "staffUsername", subject.email AS "staffEmail"
      FROM "StaffActivityEvent" ae
      LEFT JOIN "User" actor ON actor.id = ae."actorUserId"
      LEFT JOIN "StaffProfile" staff ON staff.id = ae."staffProfileId"
      LEFT JOIN "User" subject ON subject.id = staff."userId"
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ae."createdAt" DESC, ae.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `, ...params);

    const hasMore = rows.length > limitValue;
    const events = rows.slice(0, limitValue).map((row) => ({
      ...row,
      metadata: sanitizeActivityMetadata(row.metadata),
    }));
    return res.json({
      success: true,
      events,
      pagination: {
        page: pageValue,
        limit: limitValue,
        hasMore,
        nextPage: hasMore ? pageValue + 1 : null,
      },
    });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'control-plane activity feed failed');
    return res.status(500).json({ success: false, message: 'Failed to load activity feed.' });
  }
});

router.get('/staff/:id/activity', async (req, res) => {
  if (!(await authorize(req, 'staff.activity.view'))) return deny(res, 'staff.activity.view');
  const rows = await prisma(req).$queryRawUnsafe(`SELECT id, "eventType", "targetType", "targetId", metadata, "createdAt" FROM "StaffActivityEvent" WHERE "staffProfileId" = $1 ORDER BY "createdAt" DESC LIMIT 200`, Number(req.params.id));
  return res.json({ success: true, events: rows.map((row) => ({ ...row, metadata: sanitizeActivityMetadata(row.metadata) })) });
});

module.exports = router;
