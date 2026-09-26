// middleware/adminBusinessScope.js
// =============================================================================
// Admin Business Scope — allows a genuine ADMIN to act on behalf of a business
//
// r32/P0 (audit item A) — THE CANONICAL SCOPE PROPERTY.
//
// This middleware is globally mounted BEFORE the Business OS routers, so it
// resolves admin impersonation once, as early as possible. It writes exactly
// ONE canonical request property:
//
//     req.adminBusinessScope = { businessProfileId, business }
//
// Consumers (requirePermission.js, banGuardMiddleware.js, the Business OS
// route helpers) MUST read this property — never a bare req.businessProfileId
// — to recognize impersonation. requirePermission is the authoritative
// boundary that derives req.businessProfileId / req.businessContext /
// req.resolvedPermissions from it.
//
// Contract:
//   • ADMIN identity is required (JWT-verified role, or a prior `protect`).
//   • x-admin-business-id must resolve to a REAL BusinessProfile.
//   • Ordinary users sending the header get NOTHING from it.
//   • On any failure the property is simply absent, and every downstream
//     resolver falls back to the caller's OWN durable relationships.
// =============================================================================

const logger = require('../src/config/logger');
const jwt = require('jsonwebtoken');

exports.adminBusinessScope = async (req, res, next) => {
    let user = req.user;
    // The middleware is globally mounted BEFORE per-route `protect`, so the
    // JWT may not be decoded yet. Decode it here with the same secret
    // `protect` uses; an invalid token yields no user and no scope (the
    // per-route `protect` will reject the request itself).
    if (!user && req.headers.authorization?.startsWith('Bearer')) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            user = jwt.verify(token, process.env.JWT_SECRET);
            req.user = user;
        } catch (e) {
            // ignore — the per-route `protect` middleware owns the 401.
        }
    }

    // Only a genuine ADMIN may establish a scoped business context. An
    // ordinary user or employee sending x-admin-business-id gets NOTHING.
    if (user?.role?.toUpperCase() === 'ADMIN' && req.headers['x-admin-business-id']) {
        try {
            const prisma = req.app.get('prisma');
            const bizId = req.headers['x-admin-business-id'];

            const business = await prisma.businessProfile.findUnique({
                where: { id: bizId },
                select: { id: true, businessName: true, category: true, kybStatus: true },
            });

            if (business) {
                // The ONE canonical scope property. Downstream authority
                // (requirePermission) re-validates ADMIN role and business
                // existence before trusting it — defense in depth.
                req.adminBusinessScope = { businessProfileId: business.id, business };
            } else {
                logger.warn(`[adminBusinessScope] ADMIN ${user.id} scoped to nonexistent business ${bizId} — no scope granted`);
            }
        } catch (err) {
            logger.error('[adminBusinessScope] scope resolution failed', err);
        }
    }
    next();
};
