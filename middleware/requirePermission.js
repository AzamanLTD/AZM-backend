// middleware/requirePermission.js
// =============================================================================
// AZM Business Portal — Permission Middleware
//
// Validates that the authenticated user has the required permission key
// for the business they're acting on. Works with both normal business
// owners and admin impersonation (x-admin-business-id header).
//
// Usage in routes:
//   const { requirePermission } = require('../middleware/requirePermission');
//   router.post('/employees', requirePermission('employees.create'), wrap(async (req, res) => { ... }));
//
// The middleware resolves the user's effective permission set:
//   1. If the user IS the BusinessProfile owner (userId === bp.userId) → all perms
//   2. If the user is an admin impersonating a business → all perms (admin override)
//   3. If the user is a BusinessEmployee → check their resolved permissions[]
//   4. Otherwise → 403
//
// Permission resolution: if permissions[] contains '*', the user has all keys.
// Otherwise, the specific key must be present in the array.
// =============================================================================

const { ROLE_TEMPLATES, ALL_KEYS } = require('../config/permissionTemplates');

/**
 * Resolve a user's effective permission set for a given business.
 * Returns an array of permission strings. ['*'] means all permissions.
 */
async function resolvePermissions(prisma, userId, businessProfileId) {
    // Admin impersonation: if req.businessProfileId is set by adminBusinessScope,
    // the user is an admin — they get all permissions.
    // This is checked by the caller before invoking this function (see middleware below).

    // Check if user is the business owner
    const bp = await prisma.businessProfile.findUnique({
        where: { id: businessProfileId },
        select: { userId: true },
    });
    if (!bp) return [];

    // Owner gets all permissions
    if (bp.userId === userId) return ['*'];

    // Check if user is an employee of this business
    const employee = await prisma.businessEmployee.findUnique({
        where: { businessProfileId_userId: { businessProfileId, userId } },
        select: { permissions: true, status: true, role: true },
    });

    if (!employee) return [];

    // Suspended or terminated employees have no permissions
    if (employee.status === 'SUSPENDED' || employee.status === 'TERMINATED') return [];

    // If they have '*' in their permissions, they have everything
    if (employee.permissions.includes('*')) return ['*'];

    // Resolve: merge template defaults with explicit overrides
    const template = ROLE_TEMPLATES[employee.role];
    const templatePerms = template ? template.permissions : [];
    const explicitPerms = employee.permissions || [];

    // Merge: template perms + any explicit perms that aren't already covered
    // (explicit perms may add or override; for removal, the frontend stores
    // only the final resolved set, so no need for subtraction logic here)
    const merged = new Set([...templatePerms, ...explicitPerms]);
    return Array.from(merged);
}

/**
 * Express middleware factory: requirePermission(key)
 * Usage: router.post('/...', requirePermission('employees.create'), wrap(handler))
 */
function requirePermission(key) {
    return async (req, res, next) => {
        try {
            if (!req.user?.id) {
                return res.status(401).json({ success: false, message: 'Authentication required.' });
            }

            const prisma = req.app.get('prisma');

            // Resolve business profile ID (same logic as getBusinessProfileId in routes)
            let businessProfileId = req.businessProfileId; // admin impersonation
            if (!businessProfileId) {
                const bp = await prisma.businessProfile.findUnique({
                    where: { userId: req.user.id },
                    select: { id: true },
                });
                if (!bp) {
                    return res.status(403).json({ success: false, message: 'No business profile found.' });
                }
                businessProfileId = bp.id;
            }

            // Admin users (impersonating) get all permissions
            if (req.businessProfileId && req.user.role === 'ADMIN') {
                return next();
            }

            const perms = await resolvePermissions(prisma, req.user.id, businessProfileId);

            if (perms.includes('*')) {
                return next();
            }

            if (!perms.includes(key)) {
                return res.status(403).json({
                    success: false,
                    message: `You do not have permission to perform this action. Required: ${key}`,
                    requiredPermission: key,
                });
            }

            // Attach resolved permissions to req for downstream use
            req.resolvedPermissions = perms;
            next();
        } catch (err) {
            console.error('[requirePermission]', err);
            res.status(500).json({ success: false, message: 'Permission check failed.' });
        }
    };
}

module.exports = { requirePermission, resolvePermissions };
