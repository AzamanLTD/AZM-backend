// controllers/tradeAccountController.js
// =============================================================================
// AZAMAN V2 — TRADE ACCOUNT CONTROLLER
// Phase F2: Type-specific validation for vendor payment accounts.
// Phase Q2: Soft-delete archive pattern — accounts are NEVER hard-deleted.
// =============================================================================

const logger = require('../src/config/logger');
const { validateAccountDetails, getSupportedMethods } = require('../services/tradeAccountValidation');

/**
 * POST /api/trade-accounts
 * Add a new trade account (vendor registers a payment method).
 * Validates accountDetails against the method type's schema.
 */
exports.addTradeAccount = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { methodType, accountDetails, verificationScreenshot, riskLevel } = req.body;
        const userId = req.user.id;

        if (!methodType || !accountDetails || !verificationScreenshot) {
            return res.status(400).json({
                success: false,
                message: "methodType, accountDetails, and verificationScreenshot are required."
            });
        }

        // Phase UI Sprint (2026-05-26): the legacy add-form sent the literal
        // string `'pending_upload'` as a placeholder URL. That always
        // resulted in an account that admins could not actually verify
        // because there was no screenshot to look at. Reject any URL that
        // doesn't start with a real path or http(s) prefix so the FE is
        // forced to upload a real screenshot via
        // `POST /api/trade-accounts/upload-screenshot` first.
        const screenshot = String(verificationScreenshot).trim();
        const isAbsoluteHttp = /^https?:\/\//i.test(screenshot);
        const isUploadsPath  = screenshot.startsWith('/uploads/');
        if (!isAbsoluteHttp && !isUploadsPath) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_SCREENSHOT_URL',
                message: 'verificationScreenshot must be the URL returned by /api/trade-accounts/upload-screenshot.',
            });
        }

        const parsedDetails = typeof accountDetails === "string"
            ? JSON.parse(accountDetails)
            : accountDetails;

        // Phase F2: Validate details against type-specific schema
        const validation = validateAccountDetails(methodType, parsedDetails);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_ACCOUNT_DETAILS',
                message: validation.error,
                supportedMethods: getSupportedMethods()
            });
        }

        const newTradeAccount = await prisma.tradeAccount.create({
            data: {
                userId,
                methodType: methodType.toUpperCase(),
                accountDetails: parsedDetails,
                verificationScreenshot,
                adminVerificationStatus: "PENDING",
                riskLevel: riskLevel || "MEDIUM"
            }
        });

        res.status(201).json({
            success: true,
            message: "Trade account submitted for admin verification.",
            tradeAccount: newTradeAccount
        });
    } catch (error) {
        logger.error("Add Trade Account Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/trade-accounts
 * List all of the caller's ACTIVE trade accounts (excludes archived).
 * Pass ?includeArchived=true to see archived ones too (for history view).
 */
exports.getTradeAccounts = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const includeArchived = req.query.includeArchived === 'true';

        const whereClause = { userId };
        if (!includeArchived) {
            whereClause.archivedAt = null; // Only active (non-archived) accounts
        }

        const accounts = await prisma.tradeAccount.findMany({
            where: whereClause,
            orderBy: { createdAt: "desc" }
        });

        res.status(200).json({ success: true, accounts });
    } catch (error) {
        logger.error("Get Trade Accounts Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/trade-accounts/approved
 * List only APPROVED + non-archived trade accounts (for ad creation dropdown).
 */
exports.getApprovedTradeAccounts = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const accounts = await prisma.tradeAccount.findMany({
            where: {
                userId,
                adminVerificationStatus: "APPROVED",
                archivedAt: null // Phase Q2: exclude archived
            },
            orderBy: { createdAt: "desc" }
        });

        res.status(200).json({ success: true, accounts });
    } catch (error) {
        logger.error("Get Approved Trade Accounts Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/trade-accounts/supported-methods
 * Returns the list of supported payment method types + their required fields.
 */
exports.getSupportedMethods = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        // Try to read from GlobalSettings (admin-configurable)
        const settings = await prisma.globalSettings.findUnique({
            where: { id: 1 },
            select: { supportedPaymentMethods: true }
        });

        if (settings?.supportedPaymentMethods) {
            const methods = typeof settings.supportedPaymentMethods === 'string'
                ? JSON.parse(settings.supportedPaymentMethods)
                : settings.supportedPaymentMethods;
            return res.status(200).json({ success: true, methods });
        }

        // Fallback to hardcoded list
        res.status(200).json({
            success: true,
            methods: getSupportedMethods()
        });
    } catch (error) {
        // Fallback on any error
        res.status(200).json({
            success: true,
            methods: getSupportedMethods()
        });
    }
};

/**
 * DELETE /api/trade-accounts/:id
 * SOFT-DELETE (archive) a trade account.
 *
 * Phase Q2: Trade accounts are NEVER permanently deleted from the system.
 * This is a security and compliance requirement. The record remains in the
 * database with archivedAt set, hidden from the user's UI and ad-creation
 * picker. Admin can view archived accounts for audit/fraud investigation.
 *
 * Rules:
 *   - Cannot archive if any ACTIVE ads reference this account.
 *   - Sets archivedAt + archiveReason = 'USER_DELETED'.
 */
exports.deleteTradeAccount = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { id } = req.params;
        const userId = req.user.id;

        const account = await prisma.tradeAccount.findUnique({ where: { id } });
        if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });
        if (account.userId !== userId) return res.status(403).json({ success: false, message: 'Unauthorized.' });

        // Already archived
        if (account.archivedAt) {
            return res.status(400).json({ success: false, message: 'Account is already archived.' });
        }

        // Check if any active ads reference this account
        const activeAds = await prisma.ad.count({
            where: { tradeAccountId: id, status: 'ACTIVE' }
        });
        if (activeAds > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot remove: ${activeAds} active ad(s) reference this account. Deactivate them first.`
            });
        }

        // Phase Q2: Soft-delete — set archive timestamp, never hard-delete
        await prisma.tradeAccount.update({
            where: { id },
            data: {
                archivedAt: new Date(),
                archiveReason: 'USER_DELETED'
            }
        });

        res.status(200).json({
            success: true,
            message: 'Trade account removed. It has been archived for security purposes.'
        });
    } catch (error) {
        logger.error("Delete Trade Account Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};
