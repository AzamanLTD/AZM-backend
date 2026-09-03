// middleware/banGuardMiddleware.js
// =============================================================================
// AZAMAN V2 — BAN GUARD
//
// Enforces the "Ghost Ban" model from AZAMAN_MASTER_SOUL.md:
//   - Banned users retain READ-ONLY access (GET requests pass through).
//   - Any write action (POST / PUT / PATCH / DELETE) is rejected with a
//     structured 403 envelope so the frontend can render the appeal banner.
//   - Time-bound bans (banUntil in the past) auto-restore to ACTIVE.
//
// Pairs with the existing `protect` middleware. The exported `protectActive`
// chain runs `protect` first to populate req.user, then establishes a request-
// scoped business context for Business OS mutations, then checks the ban.
// =============================================================================

const logger = require('../src/config/logger');
const { protect } = require('./authMiddleware');
const { runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');

const APPEAL_EMAIL = process.env.APPEAL_EMAIL || 'support@azaman.me';

/**
 * Establish the tenant/user context used by Business OS mutation services.
 *
 * Business OS routes already run `adminBusinessScope` before this middleware,
 * so an admin's selected business is available as req.businessProfileId.
 * Normal business owners are resolved by their owned BusinessProfile; worker
 * accounts are resolved by their active BusinessEmployee record.
 *
 * The context is request-local via AsyncLocalStorage, avoiding a shared global
 * mutable value on the singleton Prisma client.
 */
const establishBusinessRequestContext = async (req, res, next) => {
    if (!req.user?.id || req.method === 'GET' || req.baseUrl !== '/api/business-os') {
        return next();
    }

    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    try {
        let businessProfileId = req.businessProfileId || null;
        let isBusinessOwner = false;

        if (businessProfileId) {
            const scopedBusiness = await prisma.businessProfile.findFirst({
                where: { id: businessProfileId, userId },
                select: { id: true },
            });
            isBusinessOwner = Boolean(scopedBusiness);
        } else {
            const ownedBusiness = await prisma.businessProfile.findFirst({
                where: { userId },
                select: { id: true },
            });
            if (ownedBusiness) {
                businessProfileId = ownedBusiness.id;
                isBusinessOwner = true;
            }
        }

        if (!businessProfileId) {
            const employee = await prisma.businessEmployee.findFirst({
                where: { userId, status: 'ACTIVE' },
                select: { businessProfileId: true },
            });
            businessProfileId = employee?.businessProfileId || null;
        }

        return runWithBusinessRequestContext({
            userId,
            businessProfileId,
            isBusinessOwner,
            isAdmin: req.user.role?.toUpperCase?.() === 'ADMIN',
            adminScopedBusinessId: req.businessProfileId || null,
        }, next);
    } catch (err) {
        logger.error({ err }, '[businessRequestContext] error');
        return res.status(500).json({
            success: false,
            message: 'Unable to establish business authorization context.',
        });
    }
};

/**
 * checkBan
 *
 * Assumes `protect` has already populated req.user with the JWT payload.
 * GET requests are permitted unconditionally so banned users can browse the
 * marketplace, view their trades, and read chats. Any non-GET request is
 * blocked unless banStatus === 'ACTIVE' or the time-bound ban has expired.
 */
const checkBan = async (req, res, next) => {
    // No user context → let the route's own protect/auth handler reject it.
    if (!req.user || !req.user.id) return next();

    // Read-only access is always allowed (Ghost Ban semantics).
    if (req.method === 'GET') return next();

    const prisma = req.app.get('prisma');

    try {
        const user = await prisma.user.findUnique({
            where: { id: parseInt(req.user.id, 10) },
            select: { banStatus: true, banUntil: true, isDeleted: true }
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                code:    'USER_NOT_FOUND',
                message: 'Authenticated user no longer exists.'
            });
        }

        if (user.isDeleted) {
            return res.status(403).json({
                success: false,
                code:    'ACCOUNT_DELETED',
                message: 'This account has been deactivated.'
            });
        }

        // Active user — pass through.
        if (user.banStatus === 'ACTIVE') return next();

        // Auto-restore expired time-bound bans.
        if (user.banUntil && new Date(user.banUntil) <= new Date()) {
            await prisma.user.update({
                where: { id: parseInt(req.user.id, 10) },
                data:  { banStatus: 'ACTIVE', banUntil: null }
            });
            logger.info(`[banGuard] Auto-restored expired ban for user ${req.user.id}`);
            return next();
        }

        // Indefinite or still-active timed ban — reject the write.
        return res.status(403).json({
            success: false,
            code:        'ACCOUNT_RESTRICTED',
            banStatus:   user.banStatus,
            banUntil:    user.banUntil,
            appealEmail: APPEAL_EMAIL,
            message:
                'Your account is currently restricted. You retain read-only access. ' +
                `If you believe this is in error, contact ${APPEAL_EMAIL} to appeal.`
        });
    } catch (err) {
        logger.error({ err: err }, '[banGuard] error');
        // Fail-closed on the strict reading: if we cannot verify ban status,
        // do not allow the write to proceed.
        return res.status(500).json({
            success: false,
            code:    'BAN_GUARD_FAILURE',
            message: 'Unable to verify account status. Please try again.'
        });
    }
};

/**
 * protectActive
 *
 * Drop-in replacement for `protect` on routes that mutate state. Ensures the
 * caller is both authenticated AND has an ACTIVE banStatus before the
 * controller runs. Business OS mutations also receive request-local tenant
 * context before the ban check runs.
 */
const protectActive = [protect, establishBusinessRequestContext, checkBan];

module.exports = { checkBan, protectActive, APPEAL_EMAIL, establishBusinessRequestContext };