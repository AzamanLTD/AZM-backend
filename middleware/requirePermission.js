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
const { runWithRequestContext } = require('../utils/requestContext');
const { runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');

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
    if (employee.permissions.includes('*')) return ['*'];

    const template = ROLE_TEMPLATES[employee.role];
    const templatePerms = template ? template.permissions : [];
    const explicitPerms = employee.permissions || [];
    return Array.from(new Set([...templatePerms, ...explicitPerms]));
}

function requirePermission(key) {
    return async (req, res, next) => {
        try {
            if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });

            const prisma = req.app.get('prisma');
            let businessProfileId = req.businessProfileId;
            let businessProfile;
            if (!businessProfileId) {
                businessProfile = await prisma.businessProfile.findFirst({
                    where: { userId: req.user.id },
                    select: { id: true, userId: true },
                });
                if (!businessProfile) return res.status(403).json({ success: false, message: 'No business profile found.' });
                businessProfileId = businessProfile.id;
            } else {
                businessProfile = await prisma.businessProfile.findFirst({
                    where: { id: businessProfileId },
                    select: { userId: true },
                });
                if (!businessProfile) return res.status(403).json({ success: false, message: 'Business profile not found.' });
            }

            // Resource-level tenant guard for the legacy tax-preset PATCH route.
            // The route itself updates by bare id, so verify the target belongs to
            // the effective business before allowing the handler to run.
            if (req.method === 'PATCH' && /^\/tax-presets\/[^/]+$/.test(req.path)) {
                const preset = await prisma.businessTaxPreset.findFirst({
                    where: { id: req.params.id, businessProfileId },
                    select: { id: true },
                });
                if (!preset) return res.status(404).json({ success: false, message: 'Tax preset not found.' });
            }

            const requestContext = {
                businessProfileId,
                user: req.user,
                isAdmin: Boolean(req.businessProfileId && req.user.role === 'ADMIN'),
                isBusinessOwner: businessProfile.userId === req.user.id,
            };
            const runAuthorized = () => runWithRequestContext(
                requestContext,
                () => runWithBusinessRequestContext(requestContext, next),
            );

            if (req.businessProfileId && req.user.role === 'ADMIN') return runAuthorized();
            const perms = await resolvePermissions(prisma, req.user.id, businessProfileId);
            if (perms.includes('*')) return runAuthorized();
            if (!perms.includes(key)) {
                return res.status(403).json({
                    success: false,
                    message: `You do not have permission to perform this action. Required: ${key}`,
                    requiredPermission: key,
                });
            }
            req.resolvedPermissions = perms;
            return runAuthorized();
        } catch (err) {
            logger.error('[requirePermission]', err);
            return res.status(500).json({ success: false, message: 'Permission check failed.' });
        }
    };
}

module.exports = { requirePermission, resolvePermissions };
