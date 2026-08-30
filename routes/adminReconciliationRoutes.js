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

router.post('/exceptions/:id/claim', async (req, res) => {
  if (!(await authorize(req, 'staff.manage'))) return deny(res, 'staff.manage');

  try {
    const p = prisma(req);
    const actor = await getStaffProfile(p, Number(req.user.id));
    if (!actor) return res.status(403).json({ success: false, message: 'Staff profile is required.' });

    const rows = await p.$queryRawUnsafe(`
      UPDATE "ReconciliationException"
      SET "details" = COALESCE("details", '{}'::jsonb) || jsonb_build_object(
            'claim', jsonb_build_object(
              'staffProfileId', $2::int,
              'actorUserId', $3::int,
              'claimedAt', CURRENT_TIMESTAMP,
              'expiresAt', CURRENT_TIMESTAMP + INTERVAL '15 minutes'
            )
          ),
          "lastSeenAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
        AND "status" = 'OPEN'
        AND (
          "details"->'claim' IS NULL
          OR ("details"->'claim'->>'expiresAt')::timestamptz <= CURRENT_TIMESTAMP
          OR ("details"->'claim'->>'actorUserId')::int = $3
        )
      RETURNING "id", "entityType", "entityId", "reference", "reason", "status", "details", "firstSeenAt", "lastSeenAt"
    `, String(req.params.id), actor.id, Number(req.user.id));

    if (!rows[0]) {
      const existing = await p.$queryRawUnsafe(`
        SELECT "id", "status", "details" FROM "ReconciliationException" WHERE "id" = $1
      `, String(req.params.id));
      if (!existing[0]) return res.status(404).json({ success: false, message: 'Reconciliation exception not found.' });
      if (existing[0].status !== 'OPEN') return res.status(409).json({ success: false, message: 'Only open reconciliation exceptions can be claimed.' });
      return res.status(409).json({ success: false, message: 'Reconciliation exception is currently claimed by another operator.' });
    }

    await recordActivity(p, {
      staffProfileId: actor.id,
      actorUserId: req.user.id,
      eventType: 'RECONCILIATION_EXCEPTION_CLAIMED',
      targetType: 'RECONCILIATION_EXCEPTION',
      targetId: rows[0].id,
      metadata: { entityType: rows[0].entityType, entityId: rows[0].entityId, leaseMinutes: 15 },
    });

    return res.json({ success: true, exception: rows[0] });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'admin reconciliation exception claim failed');
    return res.status(500).json({ success: false, message: 'Failed to claim reconciliation exception.' });
  }
});

router.post('/exceptions/:id/release', async (req, res) => {
  if (!(await authorize(req, 'staff.manage'))) return deny(res, 'staff.manage');

  try {
    const p = prisma(req);
    const actor = await getStaffProfile(p, Number(req.user.id));
    if (!actor) return res.status(403).json({ success: false, message: 'Staff profile is required.' });

    const rows = await p.$queryRawUnsafe(`
      UPDATE "ReconciliationException"
      SET "details" = COALESCE("details", '{}'::jsonb) - 'claim',
          "lastSeenAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
        AND "status" = 'OPEN'
        AND (
          "details"->'claim' IS NULL
          OR ("details"->'claim'->>'actorUserId')::int = $2
          OR ("details"->'claim'->>'expiresAt')::timestamptz <= CURRENT_TIMESTAMP
        )
      RETURNING "id", "entityType", "entityId", "reference", "reason", "status", "details", "firstSeenAt", "lastSeenAt"
    `, String(req.params.id), Number(req.user.id));

    if (!rows[0]) return res.status(409).json({ success: false, message: 'Exception is claimed by another active operator.' });

    await recordActivity(p, {
      staffProfileId: actor.id,
      actorUserId: req.user.id,
      eventType: 'RECONCILIATION_EXCEPTION_RELEASED',
      targetType: 'RECONCILIATION_EXCEPTION',
      targetId: rows[0].id,
      metadata: { entityType: rows[0].entityType, entityId: rows[0].entityId },
    });

    return res.json({ success: true, exception: rows[0] });
  } catch (err) {
    req.app.get('logger')?.error?.({ err }, 'admin reconciliation exception release failed');
    return res.status(500).json({ success: false, message: 'Failed to release reconciliation exception.' });
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
          "details" = (COALESCE("details", '{}'::jsonb) || jsonb_build_object('resolutionReason', $3::text)) - 'claim'
      WHERE "id" = $1 AND "status" = 'OPEN'
        AND (
          "details"->'claim' IS NULL
          OR ("details"->'claim'->>'actorUserId')::int = $2
          OR ("details"->'claim'->>'expiresAt')::timestamptz <= CURRENT_TIMESTAMP
        )
      RETURNING "id", "entityType", "entityId", "reference", "reason", "status", "details", "firstSeenAt", "lastSeenAt", "resolvedAt", "resolvedBy"
    `, String(req.params.id), Number(req.user.id), reason);
    if (!rows[0]) return res.status(409).json({ success: false, message: 'Exception is claimed by another active operator or is no longer open.' });
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
