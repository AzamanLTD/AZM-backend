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

async function authorize(req, permission) {
  return hasPermission(prisma(req), req.user, permission);
}

function deny(res, permission) {
  return res.status(403).json({ success: false, message: `Control-plane permission required: ${permission}` });
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

module.exports = router;
