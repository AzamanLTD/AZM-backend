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

const logger = require('../src/config/logger');
const { ROLE_TEMPLATES, ALL_KEYS } = require('../config/permissionTemplates');

// Permission-gated routes with resource IDs must prove that the target
// resource belongs to the same business before the handler is reached.
// This closes the common "valid permission + foreign resource ID" gap.
const MUTATION_TARGET_MODELS = {
    'shifts.update': 'shift',
    'shifts.delete': 'shift',
    'shifts.approve_swap': 'shiftSwap',
    'employees.manage': 'businessEmployee',
    'employees.permissions': 'businessEmployee',
};

async function validateMutationTarget(prisma, key, businessProfileId, req) {
    const modelName = MUTATION_TARGET_MODELS[key];
    const targetId = req.params?.id;
    if (!modelName || !targetId) return true;

    const target = await prisma[modelName].findFirst({
        where: { id: targetId, businessProfileId },
        select: { id: true },
    });

    return Boolean(target);
}

/**
 * Resolve a user's effective permission set for a given business.
 * Returns an array of permission strings. ['*'] means all permissions.
 */
async function resolvePermissions(prisma, userId, businessProfileId) {
    const bp = await prisma.businessProfile.findFirst({
        where: { id: businessProfileId },
        select: { userId: true },
    });
    if (!bp) return [];

    if (bp.userId === userId) return ['*'];

    const employee = await prisma.businessEmployee.findUnique({
        where: { businessProfileId_userId: { businessProfileId, userId } },
        select: { permissions: true, status: true, role: true },
    });

    if (!employee) return [];
    if (employee.status === 'SUSPENDED' || employee.status === 'TERMINATED') return [];

    const explicitPerms = employee.permissions || [];
    if (explicitPerms.includes('*')) return ['*'];

    const template = ROLE_TEMPLATES[employee.role];
    const templatePerms = template ? template.permissions : [];
    return Array.from(new Set([...templatePerms, ...explicitPerms]));
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

            let businessProfileId = req.businessProfileId;
            if (!businessProfileId) {
                const bp = await prisma.businessProfile.findFirst({
                    where: { userId: req.user.id },
                    select: { id: true },
                });
                if (!bp) {
                    return res.status(403).json({ success: false, message: 'No business profile found.' });
                }
                businessProfileId = bp.id;
            }

            // Resource ownership is checked independently of permission level,
            // including admin impersonation, so an ID from another business
            // can never reach a mutation handler through this boundary.
            if (!(await validateMutationTarget(prisma, key, businessProfileId, req))) {
                return res.status(403).json({ success: false, message: 'Resource does not belong to this business.' });
            }

            if (req.businessProfileId && req.user.role === 'ADMIN') {
                return next();
            }

            const perms = await resolvePermissions(prisma, req.user.id, businessProfileId);
            if (perms.includes('*')) return next();

            if (!perms.includes(key)) {
                return res.status(403).json({
                    success: false,
                    message: `You do not have permission to perform this action. Required: ${key}`,
                    requiredPermission: key,
                });
            }

            req.resolvedPermissions = perms;
            next();
        } catch (err) {
            logger.error('[requirePermission]', err);
            res.status(500).json({ success: false, message: 'Permission check failed.' });
        }
    };
}

module.exports = { requirePermission, resolvePermissions, validateMutationTarget };
