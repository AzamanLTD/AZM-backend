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
//
// STRICT MODE — { throwOnError: true }:
//   Callers that make the audit row part of a financial transaction's atomic
//   success boundary (e.g. forceCancel's FORCE_CANCEL_TRADE row) pass the
//   Prisma TRANSACTION CLIENT as `prisma` and set throwOnError so a failed
//   AuditLog.create aborts the whole transaction instead of silently
//   committing the financial mutation without its mandatory audit evidence.
//   Default fire-and-forget behavior for legacy callers is unchanged.
// =============================================================================
async function audit(prisma, payload, opts = {}) {
  const strict = opts && opts.throwOnError === true;
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
    if (strict) throw err; // strict mode: the audit failure must abort the transaction
    // Intentionally swallowed — never break the request over a logging failure.
  }
}

module.exports = { audit };
