// utils/audit.js
// =============================================================================
// Fire-and-forget helper for the append-only AuditLog.
//
// Usage (inside any controller, after the privileged action succeeds):
//   const { audit } = require('../utils/audit');
//   await audit(prisma, {
//     actorId: req.user.id, actorName: req.user.username,
//     action: 'APPROVE_KYC', targetType: 'USER', targetId: String(userId),
//     metadata: { previousStatus: 'PENDING', newStatus: 'VERIFIED' },
const logger = require('../src/config/logger');
//     ipAddress: req.ip,
//   });
//
// Failures are caught and logged to console.error — they NEVER cause the
// surrounding request to fail. AuditLog rows are append-only: this helper only
// ever creates; nothing in the codebase should update or delete them.
// =============================================================================
async function audit(prisma, payload) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId:    payload.actorId   ? Number(payload.actorId)   : null,
        actorName:  payload.actorName  || null,
        action:     payload.action,
        targetType: payload.targetType,
        targetId:   payload.targetId  ? String(payload.targetId)  : null,
        metadata:   payload.metadata  || {},
        ipAddress:  payload.ipAddress  || null,
      },
    });
  } catch (err) {
    logger.error('[AuditLog] Failed to write audit row:', err.message, payload);
    // Intentionally swallowed — never break the request over a logging failure.
  }
}

module.exports = { audit };
