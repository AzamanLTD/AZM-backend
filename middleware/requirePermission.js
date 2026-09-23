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
const { ROLE_TEMPLATES, EMPLOYEE_ROLE_TEMPLATES, normalizePermissions } = require('../config/permissionTemplates');
const { runWithRequestContext } = require('../utils/requestContext');
const { runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');

/**
 * r26/P0-1 — AUTHORITATIVE BUSINESS CONTEXT RESOLUTION.
 *
 * The single source of truth for "which business is this user acting on?".
 * Resolution order (the first hit wins, and every branch is derived from the
 * USER's own durable relationships — never from a caller-supplied value):
 *
 *   1. ADMIN IMPERSONATION — only when adminBusinessScope already validated
 *      the user as ADMIN and resolved a real business from the
 *      x-admin-business-id header (req.adminBusinessScope is set ONLY there).
 *      An ordinary user sending the header gets NOTHING from it.
 *   2. OWNER — the user owns the BusinessProfile (bp.userId === user.id).
 *   3. ACTIVE EMPLOYEE — the user has an ACTIVE BusinessEmployee row; the
 *      employment's businessProfileId is the authoritative context. A
 *      suspended/terminated employment resolves to NO context (no
 *      permissions, no business access).
 *
 * An employee of business A therefore cannot manufacture a context for
 * business B: their resolution is derived from their own employment row,
 * and any caller-supplied businessProfileId from a non-admin is ignored.
 * (Multiple simultaneous employments are structurally prevented by
 * addEmployee's cross-business guard; if a legacy user somehow holds two
 * ACTIVE rows the resolution is deterministic: ownership first, then the
 * oldest employment — and requirePermission still enforces the permission
 * key against THAT business only.)
 *
 * Returns { businessProfileId, isBusinessOwner, isEmployee } or null.
 */
async function resolveBusinessContext(prisma, user, { adminScopedBusinessId = null, adminScoped = false } = {}) {
    if (!user?.id) return null;

    // 1. Admin impersonation — the explicitly authorized, validated scope.
    if (adminScoped && user.role === 'ADMIN' && adminScopedBusinessId) {
        const business = await prisma.businessProfile.findFirst({
            where: { id: adminScopedBusinessId },
            select: { id: true, userId: true },
        });
        if (business) {
            return { businessProfileId: business.id, isBusinessOwner: business.userId === user.id, isEmployee: false, isAdminImpersonation: true };
        }
        return null;
    }

    // 2. Owner — the user's own business.
    const owned = await prisma.businessProfile.findFirst({
        where: { userId: user.id },
        select: { id: true, userId: true },
    });
    if (owned) {
        return { businessProfileId: owned.id, isBusinessOwner: true, isEmployee: false, isAdminImpersonation: false };
    }

    // 3. Active employee — resolution through their own employment.
    const employment = await prisma.businessEmployee.findFirst({
        where: { userId: user.id, status: 'ACTIVE' },
        orderBy: { hireDate: 'asc' },
        select: { businessProfileId: true, businessProfile: { select: { id: true } } },
    });
    if (employment && employment.businessProfile) {
        return { businessProfileId: employment.businessProfileId, isBusinessOwner: false, isEmployee: true, isAdminImpersonation: false };
    }
    return null;
}

/**
 * Resolve a user's effective permission set for a given business.
 * Returns an array of permission strings. ['*'] means all permissions.
 *
 * r26/P0-5 — CANONICAL REVOCATION MODEL (stored set is authoritative):
 *   • The business OWNER holds ['*'] (authority derives from ownership).
 *   • An employee's STORED permissions[] is the effective set — normalized
 *     for legacy snake_case rows on read. It is seeded from the role
 *     template at creation (and re-seeded on role change), but the resolver
 *     NEVER silently re-adds template permissions after that: unchecking a
 *     permission in the stored set is a real revocation.
 *   • A row with permissions [] means explicitly NO permissions.
 *   • Suspended/terminated employees hold nothing.
 */
async function resolvePermissions(prisma, userId, businessProfileId) {
    // Check if user is the business owner
    const bp = await prisma.businessProfile.findFirst({
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

    // Wildcard held by the employee row itself
    if (employee.permissions.includes('*')) return ['*'];

    // The STORED set is authoritative (role templates are defaults, applied
    // only at creation/role-change time by EmployeeService — never re-added
    // here, so explicit removals actually revoke). Legacy snake_case strings
    // are normalized into dotted-key space on read.
    return normalizePermissions(employee.permissions || []);
}

/**
 * Express middleware factory: requirePermission(key)
 * Usage: router.post('/...', requirePermission('...'), wrap(...))
 */
function requirePermission(key) {
    return async (req, res, next) => {
        try {
            if (!req.user?.id) {
                return res.status(401).json({ success: false, message: 'Authentication required.' });
            }

            const prisma = req.app.get('prisma');

            // r26/P0-1 — AUTHORITATIVE context resolution for BOTH owners and
            // ordinary employees. A caller-supplied businessProfileId is NEVER
            // trusted here: req.businessProfileId is honored only when it was
            // set by adminBusinessScope for a genuine ADMIN (req.adminBusinessScope),
            // which is the documented, validated impersonation path.
            const context = await resolveBusinessContext(prisma, req.user, {
                adminScoped: Boolean(req.adminBusinessScope),
                adminScopedBusinessId: req.adminBusinessScope?.businessProfileId ?? null,
            });
            if (!context) {
                return res.status(403).json({ success: false, message: 'No business context found for this account.' });
            }
            const businessProfileId = context.businessProfileId;
            const businessProfile = { userId: context.isBusinessOwner ? req.user.id : null };

            // Make the effective business explicit for downstream controllers.
            // Controllers must never trust a caller-supplied businessProfileId.
            req.businessProfileId = businessProfileId;
            req.businessContext = context;

            // Resource-level tenant guard for the legacy tax-preset PATCH route.
            // The route updates by bare id, so verify the target belongs to the
            // effective business before allowing the handler to run.
            if (req.method === 'PATCH' && /^\/tax-presets\/[^/]+$/.test(req.path)) {
                const preset = await prisma.businessTaxPreset.findFirst({
                    where: { id: req.params.id, businessProfileId },
                    select: { id: true },
                });
                if (!preset) {
                    return res.status(404).json({ success: false, message: 'Tax preset not found.' });
                }
            }

            const requestContext = {
                businessProfileId,
                user: req.user,
                isAdmin: Boolean(req.businessProfileId && req.user.role === 'ADMIN'),
                isBusinessOwner: context.isBusinessOwner || businessProfile.userId === req.user.id,
            };

            // Payroll still consumes the legacy request context while the
            // shift and EWA services consume the Business OS context. Keep
            // both stores in scope until their callers share one context API.
            const runAuthorized = () => runWithRequestContext(
                requestContext,
                () => runWithBusinessRequestContext(requestContext, next),
            );

            // r26 follow-up: downstream authority paths (addEmployee,
            // updateRole, updatePermissions) derive the actor's effective
            // permission set from req.resolvedPermissions — it is now set on
            // EVERY branch, so a handler never has to guess whether the
            // caller is an owner/admin.
            if (context.isAdminImpersonation) {
                req.resolvedPermissions = ['*'];
                return runAuthorized();
            }

            const perms = await resolvePermissions(prisma, req.user.id, businessProfileId);
            req.resolvedPermissions = perms;

            if (perms.includes('*')) {
                return runAuthorized();
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
            runAuthorized();
        } catch (err) {
            logger.error('[requirePermission]', err);
            res.status(500).json({ success: false, message: 'Permission check failed.' });
        }
    };
}

module.exports = { requirePermission, resolvePermissions, resolveBusinessContext };
