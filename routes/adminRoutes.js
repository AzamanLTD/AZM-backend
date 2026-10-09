// routes/adminRoutes.js
// =============================================================================
// AZAMAN V4 — ADMIN ROUTES (Consolidated Command Center)
//
// ALL routes require both `protect` (JWT) AND `adminOnly` (role check).
// This is the single entry point for all admin functionality.
//
// Mounted at /api/admin in server.js
// =============================================================================

const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const _exact = (n) => (n instanceof Prisma.Decimal ? n.toFixed(8) : Number(n).toFixed(8));
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const profitBreakdownController = require('../controllers/adminProfitBreakdownController');
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { requireEffectivePermission } = require('../middleware/requireEffectivePermission');
const { idempotency } = require('../middleware/idempotency');
const { validate } = require('../middleware/validate');
const {
    approveKycSchema,
    rejectKycSchema,
    banUserSchema,
    forceReleaseSchema,
} = require('../services/validation/financialSchemas');

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY: ALL admin routes require BOTH protect + adminOnly
// ═══════════════════════════════════════════════════════════════════════════════
router.use(protect);
router.use(adminOnly);

// ─── PLATFORM OVERVIEW ───────────────────────────────────────────────────────
router.get('/stats', requireEffectivePermission('reports.view'), adminController.getPlatformStats);
router.get('/system-health', requireEffectivePermission('reports.view'), adminController.getSystemHealth);
router.get('/profit-breakdown', requireEffectivePermission('fees.manage'), profitBreakdownController.getProfitBreakdown);

// ─── TRADE OVERSIGHT ─────────────────────────────────────────────────────────
router.get('/trades/live', requireEffectivePermission('trades.view'), adminController.getLiveTrades);
router.get('/disputes', requireEffectivePermission('disputes.view'), adminController.getAllDisputes);
router.post('/disputes/force-release', requireEffectivePermission('disputes.resolve'), validate(forceReleaseSchema), adminController.forceRelease);
router.post('/disputes/force-cancel', requireEffectivePermission('disputes.resolve'), validate(forceReleaseSchema), adminController.forceCancel);

// ─── USER MANAGEMENT ─────────────────────────────────────────────────────────
router.get('/users', requireEffectivePermission('users.view'), adminController.getUsers);
router.post('/users/:id/ban', requireEffectivePermission('users.ban', 'users.unban'), validate(banUserSchema), adminController.banUser);
router.post('/users/:id/role', requireEffectivePermission('users.role_change'), adminController.changeUserRole);

// ─── KYC MANAGEMENT ──────────────────────────────────────────────────────────
router.get('/kyc/pending', requireEffectivePermission('users.view'), adminController.getPendingKyc);
router.post('/kyc/approve', requireEffectivePermission('users.kyc_approve'), validate(approveKycSchema), adminController.approveKyc);
router.post('/kyc/reject', requireEffectivePermission('users.kyc_reject'), validate(rejectKycSchema), adminController.rejectKyc);

// ─── WITHDRAWAL MANAGEMENT ───────────────────────────────────────────────────
router.get('/withdrawals/pending', requireEffectivePermission('withdrawals.review'), adminController.getPendingWithdrawals);
router.post('/withdrawals/:id/approve', adminController.approveWithdrawal);
router.post('/withdrawals/:id/reject', requireEffectivePermission('withdrawals.approve'), adminController.rejectWithdrawal);
// P0 (NEEDS_MANUAL_REVIEW dead-end): deterministic operator resolution of
// parked withdrawals — backend-proven eligibility, single-winner CAS.
router.post('/withdrawals/:id/resolve-review', requireEffectivePermission('withdrawals.approve'), adminController.resolveManualReview);

// ─── CHAT INTERVENTION ───────────────────────────────────────────────────────
router.post('/chat/inject', requireEffectivePermission('messages.inject'), adminController.sendAdminMessage);

// ─── PROFIT OPERATIONS ───────────────────────────────────────────────────────
router.post('/profits/liquidate', requireEffectivePermission('fees.manage'), adminController.liquidateProfits);

// ─── FEE PROFILES (Phase Q1) ─────────────────────────────────────────────────
const feeProfileController = require('../controllers/adminFeeProfileController');
router.get('/fee-profiles',          requireEffectivePermission('fees.manage'), feeProfileController.listFeeProfiles);
router.get('/fee-profiles/resolve',  requireEffectivePermission('fees.manage'), feeProfileController.resolveProfile);
router.post('/fee-profiles',         requireEffectivePermission('fees.manage'), feeProfileController.createFeeProfile);
router.put('/fee-profiles/:id',      requireEffectivePermission('fees.manage'), feeProfileController.updateFeeProfile);
router.delete('/fee-profiles/:id',   requireEffectivePermission('fees.manage'), feeProfileController.deactivateFeeProfile);

// ─── GLOBAL SETTINGS & FINANCIAL PARAMETERS ──────────────────────────────────
const adminSettingsController = require('../controllers/adminSettingsController');
router.get('/settings',              requireEffectivePermission('platform.settings'), adminSettingsController.getSettings);
router.put('/settings',              requireEffectivePermission('platform.settings'), adminSettingsController.updateSettings);
router.post('/users/:id/risk-tier',  requireEffectivePermission('users.risk_tier'), adminSettingsController.setUserRiskTier);

// ─── USER DETAIL DRAWER (Phase 3) ────────────────────────────────────────────
router.get("/users/:id/detail", requireEffectivePermission('users.view'), async (req, res) => {
    const prisma = req.app.get("prisma");
    const readPrisma = req.app.get("readPrisma") || prisma;
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).json({ success: false, message: "Invalid user ID." });

        const user = await readPrisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true, username: true, email: true, role: true, kycStatus: true,
                legalName: true, idType: true, idNumber: true, profilePictureUrl: true,
                banStatus: true, banUntil: true, strikeCount: true, cancellationAbuseCount: true,
                availableBalance: true, escrowLockedBalance: true, azmBalance: true, disputeEscrowBalance: true,
                tradesCompleted: true, completionRate: true, positiveReviews: true, negativeReviews: true,
                vendorLevel: true, vendorXp: true, loyaltyTier: true, withdrawalRiskTier: true,
                loginStreak: true, lastLoginAt: true, createdAt: true, isOnline: true, lastSeenAt: true,
                country: true, phoneNumber: true, phoneVerified: true, azamanId: true, displayName: true, bio: true,
                totalVolumeUsdc: true, totalProfitUsdc: true, currentStreak: true, longestStreak: true,
                equippedCardSkin: true, onboardingCompleted: true, preferredCurrency: true,
                _count: {
                    select: {
                        tradesAsBuyer: true,
                        tradesAsVendor: true,
                        ads: true,
                        withdrawals: true,
                        transactions: true,
                        notifications: true,
                    }
                }
            }
        });

        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        // Fetch related data in parallel
        const [recentTrades, recentWithdrawals, recentTransactions, recentDisputes, activeAds] = await Promise.all([
            readPrisma.trade.findMany({
                where: { OR: [{ buyerId: userId }, { vendorId: userId }] },
                orderBy: { createdAt: "desc" },
                take: 10,
                select: { id: true, status: true, amountUsdc: true, feeUsdc: true, createdAt: true, adTitle: true, buyerId: true, vendorId: true }
            }),
            readPrisma.withdrawal.findMany({
                where: { userId },
                orderBy: { createdAt: "desc" },
                take: 10,
                select: { id: true, amountUsdc: true, feeUsdc: true, status: true, method: true, createdAt: true, destinationLabel: true }
            }),
            readPrisma.transactionHistory.findMany({
                where: { userId },
                orderBy: { createdAt: "desc" },
                take: 15,
                select: { id: true, type: true, amountUsdc: true, feeUsdc: true, status: true, createdAt: true, txHash: true }
            }),
            readPrisma.disputeResolution.findMany({
                where: { OR: [{ buyerId: userId }, { vendorId: userId }] },
                orderBy: { createdAt: "desc" },
                take: 5,
                select: { id: true, status: true, reason: true, createdAt: true, resolution: true, tradeId: true }
            }),
            readPrisma.ad.findMany({
                where: { userId, status: "ACTIVE" },
                orderBy: { createdAt: "desc" },
                take: 5,
                select: { id: true, title: true, type: true, pricePerUsdc: true, status: true, createdAt: true }
            })
        ]);

        // Recent audit log entries for this user
        const recentActions = await readPrisma.adminSettingsAuditLog.findMany({
            where: { targetId: String(userId) },
            orderBy: { createdAt: "desc" },
            take: 10,
            select: { id: true, action: true, adminName: true, changes: true, createdAt: true }
        });

        return res.status(200).json({
            success: true,
            data: {
                user,
                recentTrades,
                recentWithdrawals,
                recentTransactions,
                recentDisputes,
                activeAds,
                recentActions
            }
        });
    } catch (error) {
        logger.error({ err: error }, "[userDetail] error");
        return res.status(500).json({ success: false, message: error.message });
    }
});
router.get('/audit-log',             requireEffectivePermission('audit.view'), adminSettingsController.getAuditLog);

// ─── TRADE ACCOUNT VERIFICATION ──────────────────────────────────────────────
router.get('/trade-accounts/pending', requireEffectivePermission('trades.view'), async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const accounts = await prisma.tradeAccount.findMany({
            where: { adminVerificationStatus: 'PENDING', archivedAt: null },
            include: { user: { select: { id: true, username: true, email: true, role: true } } },
            orderBy: { createdAt: 'desc' },
        });
        return res.status(200).json({ success: true, accounts });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/trade-accounts/:id/approve', requireEffectivePermission('trades.account_approve'), async (req, res) => {
    const prisma = req.app.get('prisma');
    const notificationService = req.app.get('notificationService');
    try {
        const { id } = req.params;
        const account = await prisma.tradeAccount.findUnique({
            where: { id },
            include: { user: { select: { id: true, username: true } } }
        });
        if (!account) return res.status(404).json({ success: false, message: 'Trade account not found.' });

        await prisma.tradeAccount.update({
            where: { id },
            data: { adminVerificationStatus: 'APPROVED' },
        });

        // Notify the vendor
        if (notificationService) {
            await notificationService.sendNotification({
                userId: account.userId,
                title: '✅ Trade Account Approved',
                body: `Your ${account.methodType} trade account has been verified and is ready to use.`,
                category: 'VENDOR_PRIORITY',
                actionPayload: { route: '/settings', action: 'OPEN_TRADE_ACCOUNTS' },
            });
        }

        return res.status(200).json({ success: true, message: 'Trade account approved.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/trade-accounts/:id/reject', requireEffectivePermission('trades.account_approve'), async (req, res) => {
    const prisma = req.app.get('prisma');
    const notificationService = req.app.get('notificationService');
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const account = await prisma.tradeAccount.findUnique({
            where: { id },
            include: { user: { select: { id: true, username: true } } }
        });
        if (!account) return res.status(404).json({ success: false, message: 'Trade account not found.' });

        await prisma.tradeAccount.update({
            where: { id },
            data: { adminVerificationStatus: 'REJECTED' },
        });

        if (notificationService) {
            await notificationService.sendNotification({
                userId: account.userId,
                title: '❌ Trade Account Rejected',
                body: `Your ${account.methodType} account was not approved. ${reason || 'Please resubmit with valid details.'}`,
                category: 'VENDOR_PRIORITY',
                actionPayload: { route: '/settings', action: 'OPEN_TRADE_ACCOUNTS' },
            });
        }

        return res.status(200).json({ success: true, message: 'Trade account rejected.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ─── ADMIN CREDIT (Demo: give users test USDC) ──────────────────────────────
// r42 final-audit catch: this was the LAST financial mutation mounted with NO
// durable exactly-once identity (timestamp txHash + per-attempt history.id
// ledger key — a re-clicked admin credit double-credited). It now runs under
// the shared idempotency authority with a REQUIRED client key; the txHash is
// derived from the key so the TransactionHistory identity is replay-scoped.
// §r42 P0 (review): this route is now genuinely TRANSACTION-WIRED. The
// handler builds the accepted response and transitions its claim IN_PROGRESS
// → COMMITTED inside the credit's own prisma.$transaction, requiring
// count === 1 (else the whole credit rolls back). So:
//   FinancialOperation COMMITTED ↔ the credit economics committed —
// a post-response IN_PROGRESS claim is durable proof of rollback on BOTH
// 4xx (all validation happens pre-economics) and 5xx (RELEASE policy), and
// a COMMITTED claim replays the exact stored response bytes. Non-economic
// post-commit work (emitBalanceUpdate) runs AFTER the wire in a res-silent
// phase, so a push failure can never release a committed credit.
router.post('/users/:id/credit', requireEffectivePermission('fees.manage'), idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true }), adminController.creditUserBalance);

// ─── AUTONOMOUS PAYOUTS (Phase Q8) ──────────────────────────────────────────
router.post('/payouts/batch-process',   requireEffectivePermission('withdrawals.approve'), adminController.batchProcessPayouts);
router.get('/payouts/settings',         requireEffectivePermission('withdrawals.review'), adminController.getPayoutSettings);
router.put('/payouts/settings',         requireEffectivePermission('withdrawals.approve'), adminController.updatePayoutSettings);
router.get('/payouts/needs-review',     requireEffectivePermission('withdrawals.review'), adminController.getNeedsManualReview);

// ─── APP VERSION GATE (Phase Q15) ────────────────────────────────────────────
router.get('/version-gate', requireEffectivePermission('platform.settings'), async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const settings = await prisma.globalSettings.findUnique({
            where: { id: 1 },
            select: { minAppVersion: true, forceUpdateUrl: true, updateMessage: true },
        });
        return res.status(200).json({ success: true, data: settings });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.put('/version-gate', requireEffectivePermission('platform.settings'), async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { minAppVersion, forceUpdateUrl, updateMessage } = req.body;

        // Validate semver format (basic check)
        if (minAppVersion && !/^\d+\.\d+\.\d+$/.test(minAppVersion)) {
            return res.status(400).json({ success: false, message: 'minAppVersion must be semver (e.g., 1.2.3)' });
        }

        const updateData = {};
        if (minAppVersion) updateData.minAppVersion = minAppVersion;
        if (forceUpdateUrl) updateData.forceUpdateUrl = forceUpdateUrl;
        if (updateMessage) updateData.updateMessage = updateMessage;

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update' });
        }

        const settings = await prisma.globalSettings.update({
            where: { id: 1 },
            data: updateData,
            select: { minAppVersion: true, forceUpdateUrl: true, updateMessage: true },
        });

        logger.info(`[Admin] Version gate updated: minAppVersion=${settings.minAppVersion}`);
        return res.status(200).json({ success: true, data: settings });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Phase Q14: Dispute Resolution
router.post('/disputes/:tradeId/resolve', requireEffectivePermission('disputes.resolve'), async (req, res) => {
    const DisputeResolutionService = require('../services/disputeResolutionService');
    const prisma = req.app.get('prisma');
    const notificationService = req.app.get('notificationService');
    const service = new DisputeResolutionService(prisma, notificationService);

    try {
        const tradeId = parseInt(req.params.tradeId, 10);
        if (isNaN(tradeId)) {
            return res.status(400).json({ success: false, message: 'Invalid trade ID' });
        }

        const { ruling, reason, buyerPercent } = req.body;
        const adminId = req.user.id;

        // --- Phase ADMIN-CONTROL-2 FIX 6A: Dispute buyerPercent validation ---
        if (ruling === 'SPLIT') {
            const buyerPct = parseInt(buyerPercent, 10);
            if (isNaN(buyerPct) || buyerPct < 0 || buyerPct > 100) {
                return res.status(400).json({
                    success: false,
                    message: 'buyerPercent must be an integer between 0 and 100.'
                });
            }
            const isExtremeRuling = buyerPct < 5 || buyerPct > 95;
            if (isExtremeRuling && req.body.override !== true) {
                return res.status(422).json({
                    success: false,
                    code: 'EXTREME_RULING_REQUIRES_OVERRIDE',
                    message: `buyerPercent of ${buyerPct}% is an extreme ruling. If you are certain, resend with override: true in the request body.`,
                    requiresOverride: true
                });
            }
        }

        const resolution = await service.resolveDispute({
            tradeId,
            adminId,
            ruling,
            reason,
            buyerPercent: buyerPercent != null ? parseFloat(buyerPercent) : undefined,
        });

        return res.status(200).json({ success: true, data: resolution });

    } catch (error) {
        logger.error({ err: error }, '[admin.resolveDispute] error');
        const status = error.message.includes('not found') ? 404 :
                       error.message.includes('Invalid') || error.message.includes('required') ? 400 :
                       error.message.includes('already') ? 409 : 500;
        return res.status(status).json({ success: false, message: error.message });
    }
});

router.get('/disputes/resolutions', requireEffectivePermission('disputes.view'), async (req, res) => {
    const DisputeResolutionService = require('../services/disputeResolutionService');
    const prisma = req.app.get('prisma');
    const notificationService = req.app.get('notificationService');
    const service = new DisputeResolutionService(prisma, notificationService);

    try {
        const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
        const cursor = req.query.cursor || undefined;

        const resolutions = await service.getResolutionHistory({ limit, cursor });

        return res.status(200).json({ success: true, data: resolutions });
    } catch (error) {
        logger.error({ err: error }, '[admin.disputeResolutions] error');
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ─── SMART ESCROW DISPUTES (2026-06-14) ──────────────────────────────────────
// protect + adminOnly are already applied globally via router.use at the top.
router.get('/escrow-disputes', requireEffectivePermission('disputes.view'), adminController.getEscrowDisputes);
router.post('/escrow-disputes/:id/assign', requireEffectivePermission('disputes.resolve'), adminController.assignEscrowDispute);
router.post('/escrow-disputes/:id/resolve', requireEffectivePermission('disputes.resolve'), adminController.resolveEscrowDispute);

// BUSINESS KYB REVIEW (2026-06-16)
// protect + adminOnly are already applied globally via router.use at the top.
const businessKybCtrl = require('../controllers/businessKybController');
router.get('/business-kyb',                            requireEffectivePermission('users.view'), businessKybCtrl.getKybQueue);
router.post('/business-kyb/:documentId/review',        requireEffectivePermission('users.kyc_approve'), businessKybCtrl.reviewKybDocument);
router.post('/business-kyb/:bizId/approve',            requireEffectivePermission('users.kyc_approve'), businessKybCtrl.approveBusinessKyb);
router.post('/business-kyb/:bizId/reject',             requireEffectivePermission('users.kyc_reject'), businessKybCtrl.rejectBusinessKyb);

// ─── BUSINESS MANAGEMENT (WS4, 2026-06-18) ───────────────────────────────────
// List all businesses + suspend/unsuspend. protect + adminOnly applied globally.
const businessAdminCtrl = require('../controllers/businessAdminController');
router.get('/businesses',                    businessAdminCtrl.getBusinesses);
router.post('/businesses/:bizId/suspend',    requireEffectivePermission('business.manage'), businessAdminCtrl.suspendBusiness);
router.post('/businesses/:bizId/unsuspend',  requireEffectivePermission('business.manage'), businessAdminCtrl.unsuspendBusiness);
router.delete('/businesses/:bizId',          requireEffectivePermission('business.manage'), businessAdminCtrl.deleteBusiness);
router.delete('/ad-posts/:id',               requireEffectivePermission('business.manage'), businessAdminCtrl.deleteAdPost);

// ─── GENERAL AUDIT LOG (append-only ledger of privileged actions) ────────────
// NOTE: the bare GET /audit-log path above maps to the settings-change log
// (adminSettingsController.getAuditLog). This distinct path serves the general
// AuditLog model written by utils/audit.js. protect + adminOnly applied globally.
// GET /api/admin/audit-log/general?page=1&limit=50&action=APPROVE_KYC&targetType=USER
router.get('/audit-log/general', requireEffectivePermission('audit.view'), adminController.getAuditLog);

// ─── MARKETPLACE OVERSIGHT (Admin View-All Mode) ─────────────────────────────
router.get('/marketplace-businesses', async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { category, kybStatus, search } = req.query;
        // Exclude test/seed businesses from the admin portal list (same list
        // as the public searchBusinesses exclusion in businessService.js).
        const EXCLUDED_NAMES = ['test portal biz', 'azaman', 'test chop bar', 'az-qa transit test co'];
        const where = {
            NOT: {
                businessName: {
                    in: EXCLUDED_NAMES,
                    mode: 'insensitive',
                },
            },
        };
        if (category) where.category = category;
        if (kybStatus) where.kybStatus = kybStatus;
        if (search) {
            where.OR = [
                { businessName: { contains: search, mode: 'insensitive' } },
                { azamanId: { contains: search, mode: 'insensitive' } },
            ];
        }

        const businesses = await prisma.businessProfile.findMany({
            where,
            include: {
                user: { select: { id: true, username: true, email: true, role: true } },
                locations: { select: { id: true, label: true, city: true } },
                _count: {
                    select: {
                        followers: true,
                        adPosts: true,
                        dineInTabs: true,
                        reservations: true,
                        transitTrips: true,
                        showcase: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        return res.status(200).json({ success: true, businesses });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/marketplace-businesses/:bizId', async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const business = await prisma.businessProfile.findUnique({
            where: { id: req.params.bizId },
            include: {
                user: { select: { id: true, username: true, email: true, role: true } },
                locations: true,
                products: { take: 10, orderBy: { createdAt: 'desc' } },
                penaltyPolicy: true,
                _count: {
                    select: {
                        followers: true,
                        adPosts: true,
                        dineInTabs: true,
                        reservations: true,
                        transitTrips: true,
                        showcase: true,
                        reviews: true,
                    },
                },
            },
        });

        if (!business) return res.status(404).json({ success: false, message: 'Business not found.' });

        return res.status(200).json({ success: true, business });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});



// ─── ADMIN 2FA (Phase 3) ─────────────────────────────────────────────────────
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

// POST /api/admin/2fa/setup — generate TOTP secret + QR code
router.post('/2fa/setup', async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const userId = req.user.id;

        // Generate new secret
        const secret = speakeasy.generateSecret({
            name: `AZAMAN Admin (${req.user.email || userId})`,
            length: 32,
        });

        // Generate QR code data URL
        const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);

        // Temporarily store in user record (not verified yet)
        await prisma.user.update({
            where: { id: userId },
            data: { twoFactorSecret: secret.base32 },
        });

        res.json({
            success: true,
            secret: secret.base32,
            qrCode: qrDataUrl,
            otpauthUrl: secret.otpauth_url,
        });
    } catch (err) {
        logger.error('[AdminRoutes] 2FA setup error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/admin/2fa/verify — verify TOTP token and enable 2FA
router.post('/2fa/verify', async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const userId = req.user.id;
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ success: false, message: 'Token is required.' });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { twoFactorSecret: true, twoFactorEnabled: true },
        });

        if (!user?.twoFactorSecret) {
            return res.status(400).json({ success: false, message: '2FA not set up. Call /2fa/setup first.' });
        }

        if (user.twoFactorEnabled) {
            return res.status(400).json({ success: false, message: '2FA is already enabled.' });
        }

        const verified = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token,
            window: 1,
        });

        if (!verified) {
            return res.status(400).json({ success: false, message: 'Invalid token. Please try again.' });
        }

        await prisma.user.update({
            where: { id: userId },
            data: { twoFactorEnabled: true },
        });

        res.json({ success: true, message: '2FA enabled successfully.' });
    } catch (err) {
        logger.error('[AdminRoutes] 2FA verify error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/admin/2fa/disable — disable 2FA (requires current token)
router.post('/2fa/disable', async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const userId = req.user.id;
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ success: false, message: 'Token is required to disable 2FA.' });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { twoFactorSecret: true, twoFactorEnabled: true },
        });

        if (!user?.twoFactorEnabled) {
            return res.status(400).json({ success: false, message: '2FA is not enabled.' });
        }

        const verified = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token,
            window: 1,
        });

        if (!verified) {
            return res.status(400).json({ success: false, message: 'Invalid token.' });
        }

        await prisma.user.update({
            where: { id: userId },
            data: { twoFactorEnabled: false, twoFactorSecret: null },
        });

        res.json({ success: true, message: '2FA disabled.' });
    } catch (err) {
        logger.error('[AdminRoutes] 2FA disable error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/admin/2fa/status — check 2FA status
router.get('/2fa/status', async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { twoFactorEnabled: true, twoFactorSecret: true },
        });

        res.json({
            success: true,
            enabled: user?.twoFactorEnabled || false,
            hasSecret: !!user?.twoFactorSecret,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;

// ── Payment Provider Health (Phase 2: Failover) ─────────────────────────────
router.get('/payment-providers/health', async (req, res) => {
    try {
        const failoverService = req.app.get('paymentFailoverService');
        if (!failoverService) {
            return res.json({ success: true, data: { message: 'Failover service not initialized (using single provider)' } });
        }
        const health = await failoverService.getHealthStatus();
        res.json({ success: true, data: health });
    } catch (err) {
        logger.error({ err }, '[admin] Payment provider health check failed');
        res.status(500).json({ success: false, message: 'Failed to get provider health' });
    }
});
