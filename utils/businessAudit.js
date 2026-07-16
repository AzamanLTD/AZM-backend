// utils/businessAudit.js
// =============================================================================
// AZM Business Portal — Business-scoped audit log helper
//
// Extends the platform-level audit() with business-specific context.
// Every destructive or financial action in the business portal should
// call logBusinessAudit() so the owner can review a chronological history
// of who did what within their business.
//
// Usage:
//   const { logBusinessAudit } = require('../utils/businessAudit');
//   await logBusinessAudit(prisma, {
//     businessProfileId: bp.id,
//     actorId: req.user.id,
//     actorName: req.user.username,
//     action: 'EMPLOYEE_TERMINATED',
//     targetType: 'BUSINESS_EMPLOYEE',
//     targetId: employeeId,
//     metadata: { reason: 'No-call no-show', previousStatus: 'ACTIVE' },
//     ipAddress: req.ip,
//   });
//
// Failures are caught and logged — they NEVER cause the surrounding request
// to fail (same pattern as utils/audit.js).
// =============================================================================

const { audit } = require('./audit');

async function logBusinessAudit(prisma, payload) {
    try {
        // Write to the platform-level AuditLog with business-scoped metadata
        await audit(prisma, {
            actorId:    payload.actorId   ? Number(payload.actorId)   : null,
            actorName:  payload.actorName  || null,
            action:     payload.action,
            targetType: payload.targetType || 'BUSINESS',
            targetId:   payload.targetId  ? String(payload.targetId) : null,
            metadata:   {
                ...payload.metadata,
                businessProfileId: payload.businessProfileId,
                // Tag so the Activity Log screen can filter business-scoped entries
                _bizAudit: true,
            },
            ipAddress:  payload.ipAddress  || null,
        });
    } catch (err) {
        console.error('[BusinessAudit] Failed to write audit row:', err.message, payload);
        // Intentionally swallowed — never break the request over a logging failure.
    }
}

module.exports = { logBusinessAudit };
