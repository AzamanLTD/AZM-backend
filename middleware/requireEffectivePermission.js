// middleware/requireEffectivePermission.js
// =============================================================================
// r273 — AUTHORITATIVE EFFECTIVE-ROLE PERMISSION GATE (legacy migration,
// tranche 1).
//
// Legacy admin endpoints historically authorized on the JWT role claim (or
// the primary User.role alone). Because the Prisma Role enum only holds
// USER/VENDOR/ADMIN, EVERY provisioned specialized admin (FINANCE_ADMIN,
// SUPPORT_ADMIN, COMPLIANCE_ADMIN, READ_ONLY_ADMIN) carries a JWT whose role
// claim is 'ADMIN' — so on claim-gated surfaces the specialized designation
// is invisible and the account behaves as a full legacy admin. Conversely, a
// token whose claim does not match the account's live database state (forged
// claim, demoted account, stale pre-revocation token) is trusted as-is.
//
// This gate closes both directions at the endpoint boundary:
//
//   • The acting admin's role is resolved from AUTHORITATIVE database state
//     via rbac.resolveEffectiveAdminRole (AdminRoleAssignment + live User
//     row) — the same single authority used by the approval lifecycle,
//     approveWithdrawal and the provisioning surface. The JWT role claim is
//     never consulted for the permission decision.
//   • The resolved role must hold EVERY required permission in the role
//     catalog (controllers/adminRbacController.js ADMIN_ROLES). A permission
//     listed in no specialized role's catalog entry is, by construction,
//     reserved to SUPER_ADMIN ('*') and the legacy full-ADMIN fallback.
//   • Resolution FAILS CLOSED: no live user row, deleted, banned, demoted
//     below ADMIN, or a lingering assignment on a demoted account all
//     resolve to null → 403 before any handler, middleware side effect or
//     financial claim is reached. (Resolution errors surface as 503, never
//     as an accidental allow.)
//
// Legacy ADMIN accounts (User.role = ADMIN, no specialized assignment)
// intentionally retain full access: resolveEffectiveAdminRole returns the
// legacy 'ADMIN' role and checkAdminPermission grants it every permission.
// This matches the established semantics of every previously-enforced surface
// (approveWithdrawal, approval lifecycle, provisioning) and avoids locking
// out operators who have not yet been provisioned. It is an explicit,
// documented and tested policy — NOT a silent fallback. The migration path
// for retiring it is provisioning every operator into a specialized role
// (see docs/RBAC_SUPER_ADMIN_BOOTSTRAP.md).
//
// Usage (per-operation least privilege — pick the permission that matches
// the operation's risk, never a broader one):
//   router.post('/users/:id/credit',
//     requireEffectivePermission('fees.manage'),
//     idempotency({ ... }),
//     adminController.creditUserBalance);
//
// Multiple permissions are OR-composed when one endpoint legitimately serves
// several capabilities (e.g. the ban/unban lifecycle endpoint admits holders
// of either users.ban or users.unban; the handler then narrows to the
// action-specific permission).
// =============================================================================

const logger = require('../src/config/logger');
const rbac = require('../controllers/adminRbacController');

function requireEffectivePermission(...permissions) {
    // Resolve at wiring time, not per request: a gate with no permission
    // would silently allow everything.
    const required = permissions.flat().filter(Boolean);
    if (required.length === 0) {
        throw new Error(
            'requireEffectivePermission: at least one permission is required'
        );
    }

    return async (req, res, next) => {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
            });
        }

        const prisma = req.app.get('prisma');

        let effectiveRole;
        try {
            effectiveRole = await rbac.resolveEffectiveAdminRole(prisma, req.user.id);
        } catch (err) {
            logger.error({ err }, '[requireEffectivePermission] effective-role resolution failed');
            // Fail closed on infrastructure errors — never let a DB hiccup
            // turn into an allow.
            return res.status(503).json({
                success: false,
                message: 'Authorization check unavailable. Try again.',
            });
        }

        if (!effectiveRole) {
            return res.status(403).json({
                success: false,
                message: 'Your admin role could not be verified against the authoritative role source.',
                requiredPermissions: required,
                yourRole: effectiveRole,
            });
        }

        const actingUser = { id: req.user.id, role: effectiveRole };
        const granted = required.some((permission) =>
            rbac.checkAdminPermission(actingUser, permission)
        );

        if (!granted) {
            return res.status(403).json({
                success: false,
                message: `Admin permission required: ${required.join(' or ')}`,
                requiredPermissions: required,
                yourRole: effectiveRole,
            });
        }

        // Exposed for handlers that need to narrow further per action (the
        // resolved value is trusted only because THIS middleware set it in
        // the same request after authoritative resolution).
        req.effectiveAdminRole = effectiveRole;
        return next();
    };
}

module.exports = { requireEffectivePermission };
