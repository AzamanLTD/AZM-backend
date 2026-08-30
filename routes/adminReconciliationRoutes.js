const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { hasPermission, getStaffProfile, recordActivity } = require('../services/controlPlaneService');

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

router.get('/exceptions', async (req, res) => {
  if (!(await authorize(req, 'staff.view'))) return deny(res, 'staff.view');
  const limit = req.query.limit == null ? 50 : Number(req.query.limit);
  const page = req.query.page == null ? 1 : Number(req.query.page);
  const status = req.query.status == null ? 'OPEN' : String(req.query.status).trim().toUpperCase();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ success: false, message: 'limit must be an integer between 1 and 100.' });
  if (!Number.isInteger(page) || page < 1 || page > 10000) return res.status(400).json({ success: false, message: 'page must be an integer between 1 and 10000.' });
  if (!['OPEN', 'RESOLVED', 'ALL'].includes(status)) return res.status(400).json({ success: false, message: 'status must be OPEN, RESOLVED, or ALL.' });

  try {
    const p = prisma(req);
    const params = [];
    const add = (v) => { params.push(v); return `$${params.length}`; };
    const where = status === 'ALL' ? '' : `WHERE re."status" = ${add(status)}`;
    const limitParam = add(limit + 1);
    const offsetParam = add((page - 1) * limit);
    const rows = await p.$queryRawUnsafe(`
      SELECT re."id", re."entityType", re."entityId", re."reference", re."reason", re."status",
             re."details", re."firstSeenAt", re."lastSeenAt", re."resolvedAt", re."resolvedBy",
             u.username AS "resolvedByUsername", u.email AS "resolvedByEmail"
      FROM "ReconciliationException" re
      LEFT JOIN "User" u ON u.id = re."resolvedBy"
      ${where}
      ORDER BY CASE WHEN re."status" = 'OPEN' THEN 0 ELSE 1 END, re."lastSeenAt" DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `, ...params);
    const hasMore = rows.length > limit;
    return res.json({ success: true, exceptions: rows.slice(0, limit), pagination: { page, limit, hasMore, nextPage: hasMore ? page + 1 : null } });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'admin reconciliation exception list failed');
    return res.status(500).json({ success: false, message: 'Failed to load reconciliation exceptions.' });
  }
});

router.post('/exceptions/:id/resolve', async (req, res) => {
  if (!(await authorize(req, 'staff.manage'))) return deny(res, 'staff.manage');
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) return res.status(400).json({ success: false, message: 'A resolution reason between 3 and 500 characters is required.' });

  try {
    const p = prisma(req);
    const actor = await getStaffProfile(p, Number(req.user.id));
    if (!actor) return res.status(403).json({ success: false, message: 'Staff profile is required.' });
    const rows = await p.$queryRawUnsafe(`
      UPDATE "ReconciliationException"
      SET "status" = 'RESOLVED', "resolvedAt" = CURRENT_TIMESTAMP, "resolvedBy" = $2,
          "lastSeenAt" = CURRENT_TIMESTAMP,
          "details" = COALESCE("details", '{}'::jsonb) || jsonb_build_object('resolutionReason', $3::text)
      WHERE "id" = $1 AND "status" = 'OPEN'
      RETURNING "id", "entityType", "entityId", "reference", "reason", "status", "details", "firstSeenAt", "lastSeenAt", "resolvedAt", "resolvedBy"
    `, String(req.params.id), Number(req.user.id), reason);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Open reconciliation exception not found.' });
    await recordActivity(p, {
      staffProfileId: actor.id,
      actorUserId: req.user.id,
      eventType: 'RECONCILIATION_EXCEPTION_RESOLVED',
      targetType: 'RECONCILIATION_EXCEPTION',
      targetId: rows[0].id,
      metadata: { entityType: rows[0].entityType, entityId: rows[0].entityId, exceptionReason: rows[0].reason, resolutionReason: reason },
    });
    return res.json({ success: true, exception: rows[0] });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'admin reconciliation exception resolve failed');
    return res.status(500).json({ success: false, message: 'Failed to resolve reconciliation exception.' });
  }
});

module.exports = router;
