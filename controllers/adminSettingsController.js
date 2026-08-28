// controllers/adminSettingsController.js
// =============================================================================
// AZAMAN — ADMIN GLOBAL SETTINGS CONTROLLER
//
// GET  /api/admin/settings       — Fetch all financial parameters
// PUT  /api/admin/settings       — Update financial parameters (partial update)
// POST /api/admin/users/:id/risk-tier — Assign withdrawal risk tier to a user
// GET  /api/admin/audit-log      — Fetch settings change history
//
// Every mutation writes an AdminSettingsAuditLog row for full traceability.
const logger = require('../src/config/logger');
// Changes apply IMMEDIATELY to the next transaction — no caching.
// =============================================================================

/**
 * GET /api/admin/settings
 * Returns all admin-configurable financial parameters from GlobalSettings.
 */
exports.getSettings = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        let settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });

        // Auto-create if missing (first boot)
        if (!settings) {
            settings = await prisma.globalSettings.create({ data: { id: 1 } });
        }

        // Return only the admin-configurable financial fields
        return res.status(200).json({
            success: true,
            settings: {
                // P2P fees
                p2pFeePct: Number(settings.p2pFeePct),
                bankMargin: Number(settings.bankMargin),
                thirdPartyMargin: Number(settings.thirdPartyMargin),

                // Revenue split
                vendorShareUnder1k: Number(settings.vendorShareUnder1k),
                vendorShareOver1k: Number(settings.vendorShareOver1k),
                tierThreshold: Number(settings.tierThreshold),
                vendorMinCollateral: Number(settings.vendorMinCollateral),

                // Withdrawal & exit fees
                baseExitFeePct: Number(settings.baseExitFeePct),
                fiatWithdrawalFeePct: Number(settings.fiatWithdrawalFeePct),
                cryptoWithdrawalFeePct: Number(settings.cryptoWithdrawalFeePct),
                cryptoPlatformFeePct: Number(settings.cryptoPlatformFeePct),

                // Risk-tier fee map
                withdrawalFeeByRiskTier: settings.withdrawalFeeByRiskTier,

                // Per-payment-method P2P fee rates
                feeByPaymentMethod: settings.feeByPaymentMethod,

                // Supported payment methods (definitions + required fields)
                supportedPaymentMethods: settings.supportedPaymentMethods,

                // Gas fee estimates
                gasFeeTrc20: Number(settings.gasFeeTrc20),
                gasFeeErc20: Number(settings.gasFeeErc20),
                gasFeeBep20: Number(settings.gasFeeBep20),

                // Payout config
                autoPayoutEnabled: settings.autoPayoutEnabled,
                autoPayoutThresholdUsdc: Number(settings.autoPayoutThresholdUsdc),
                autoPayoutMaxAmountUsdc: Number(settings.autoPayoutMaxAmountUsdc),
                autoPayoutIntervalMs: settings.autoPayoutIntervalMs,

                // Oracle rates (read-only display)
                liveUsdToGhs: Number(settings.liveUsdToGhs),
                liveRetailRate: Number(settings.liveRetailRate),
                liveCorporateRate: Number(settings.liveCorporateRate),
                liveRateSource: settings.liveRateSource,
                lastRateSync: settings.lastRateSync,

                // Version gate
                minAppVersion: settings.minAppVersion,
                forceUpdateUrl: settings.forceUpdateUrl,
                updateMessage: settings.updateMessage,

                // Phase 5: Susu profit percentage
                susuProfitPct: Number(settings.susuProfitPct),

                // Smart Escrow platform policy
                smartEscrowFeePct: Number(settings.smartEscrowFeePct),
                escrowDraftExpiryHours: Number(settings.escrowDraftExpiryHours),
                escrowFundedExpiryDays: Number(settings.escrowFundedExpiryDays),
            }
        });
    } catch (error) {
        logger.error({ err: error }, '[adminSettings.get] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * PUT /api/admin/settings
 * Partial update — only provided fields are changed.
 * Writes an audit log entry with old→new diffs.
 */
exports.updateSettings = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const adminId = req.user.id;
        const adminName = req.user.username;

        // Fetch current values for diff
        let current = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        if (!current) {
            current = await prisma.globalSettings.create({ data: { id: 1 } });
        }

        // Whitelist of updatable fields
        const ALLOWED_FIELDS = [
            'p2pFeePct', 'bankMargin', 'thirdPartyMargin',
            'vendorShareUnder1k', 'vendorShareOver1k', 'tierThreshold', 'vendorMinCollateral',
            'baseExitFeePct', 'fiatWithdrawalFeePct', 'cryptoWithdrawalFeePct', 'cryptoPlatformFeePct',
            'withdrawalFeeByRiskTier', 'feeByPaymentMethod', 'supportedPaymentMethods',
            'gasFeeTrc20', 'gasFeeErc20', 'gasFeeBep20',
            'autoPayoutEnabled', 'autoPayoutThresholdUsdc', 'autoPayoutMaxAmountUsdc', 'autoPayoutIntervalMs',
            'minAppVersion', 'forceUpdateUrl', 'updateMessage',
            'susuProfitPct',
            'smartEscrowFeePct', 'escrowDraftExpiryHours', 'escrowFundedExpiryDays',
        ];

        const updateData = {};
        const changes = {};

        for (const field of ALLOWED_FIELDS) {
            if (req.body[field] === undefined) continue;

            let newValue = req.body[field];
            const oldValue = current[field];

            // Type coercion for Decimal fields. Preserve integer expiry settings.
            if (typeof newValue === 'number' || (typeof newValue === 'string' && !isNaN(parseFloat(newValue)))) {
                if (field !== 'autoPayoutEnabled' && field !== 'autoPayoutIntervalMs'
                    && field !== 'minAppVersion' && field !== 'forceUpdateUrl' && field !== 'updateMessage'
                    && field !== 'withdrawalFeeByRiskTier'
                    && field !== 'escrowDraftExpiryHours' && field !== 'escrowFundedExpiryDays') {
                    newValue = parseFloat(newValue);
                } else if (field === 'escrowDraftExpiryHours' || field === 'escrowFundedExpiryDays') {
                    newValue = parseInt(newValue, 10);
                }
            }

            // Validation: percentage fields must be 0..1
            const pctFields = [
                'p2pFeePct', 'bankMargin', 'thirdPartyMargin',
                'vendorShareUnder1k', 'vendorShareOver1k',
                'baseExitFeePct', 'fiatWithdrawalFeePct', 'cryptoWithdrawalFeePct', 'cryptoPlatformFeePct',
                'susuProfitPct', 'smartEscrowFeePct',
            ];
            if (pctFields.includes(field)) {
                if (typeof newValue !== 'number' || newValue < 0 || newValue > 1) {
                    return res.status(400).json({
                        success: false,
                        message: `${field} must be a number between 0 and 1 (got ${newValue}).`
                    });
                }
            }

            // Validation: tierThreshold must be positive
            if (field === 'tierThreshold' && (typeof newValue !== 'number' || newValue < 0)) {
                return res.status(400).json({
                    success: false,
                    message: 'tierThreshold must be a non-negative number.'
                });
            }

            // Smart Escrow policy bounds prevent accidental zero/negative expiry
            // or unbounded operational windows. These are platform policy values,
            // not per-merchant settings.
            if (field === 'escrowDraftExpiryHours' && (!Number.isInteger(newValue) || newValue < 1 || newValue > 720)) {
                return res.status(400).json({
                    success: false,
                    message: 'escrowDraftExpiryHours must be an integer between 1 and 720.'
                });
            }
            if (field === 'escrowFundedExpiryDays' && (!Number.isInteger(newValue) || newValue < 1 || newValue > 3650)) {
                return res.status(400).json({
                    success: false,
                    message: 'escrowFundedExpiryDays must be an integer between 1 and 3650.'
                });
            }

            updateData[field] = newValue;
            changes[field] = { old: oldValue, new: newValue };
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ success: false, message: 'No valid fields to update.' });
        }

        // Atomic: update settings + write audit log
        const [updated] = await prisma.$transaction([
            prisma.globalSettings.update({
                where: { id: 1 },
                data: updateData,
            }),
            prisma.adminSettingsAuditLog.create({
                data: {
                    adminId,
                    adminName,
                    action: 'UPDATE_SETTINGS',
                    targetType: 'GLOBAL_SETTINGS',
                    targetId: '1',
                    changes,
                }
            }),
        ]);

        return res.status(200).json({
            success: true,
            message: 'Settings updated. Changes apply to the next transaction immediately.',
            settings: updateData,
        });
    } catch (error) {
        logger.error({ err: error }, '[adminSettings.update] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/admin/users/:id/risk-tier
 * Assign a withdrawal risk tier to a specific user.
 * Body: { tier: 'STANDARD' | 'TRUSTED' | 'HIGH_RISK' }
 */
exports.setUserRiskTier = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = parseInt(req.params.id, 10);
        const { tier } = req.body;
        const adminId = req.user.id;
        const adminName = req.user.username;

        if (isNaN(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid user ID.' });
        }

        const validTiers = ['STANDARD', 'TRUSTED', 'HIGH_RISK'];
        if (!tier || !validTiers.includes(tier)) {
            return res.status(400).json({
                success: false,
                message: `tier must be one of: ${validTiers.join(', ')}`
            });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, username: true, withdrawalRiskTier: true }
        });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        const oldTier = user.withdrawalRiskTier;
        if (oldTier === tier) {
            return res.status(200).json({
                success: true,
                message: `User already has risk tier ${tier}.`,
                user: { id: userId, withdrawalRiskTier: tier }
            });
        }

        await prisma.$transaction([
            prisma.user.update({
                where: { id: userId },
                data: { withdrawalRiskTier: tier },
            }),
            prisma.adminSettingsAuditLog.create({
                data: {
                    adminId,
                    adminName,
                    action: 'SET_USER_RISK_TIER',
                    targetType: 'USER_RISK_TIER',
                    targetId: String(userId),
                    changes: { withdrawalRiskTier: { old: oldTier, new: tier } },
                }
            }),
        ]);

        return res.status(200).json({
            success: true,
            message: `User ${user.username} risk tier changed: ${oldTier} → ${tier}`,
            user: { id: userId, username: user.username, withdrawalRiskTier: tier }
        });
    } catch (error) {
        logger.error({ err: error }, '[adminSettings.setUserRiskTier] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/audit-log
 * Paginated list of all admin settings changes.
 * Query: ?page=1&limit=50&action=UPDATE_SETTINGS
 */
exports.getAuditLog = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
        const skip = (page - 1) * limit;

        const where = {};
        if (req.query.action) where.action = req.query.action;
        if (req.query.targetType) where.targetType = req.query.targetType;
        if (req.query.adminId) where.adminId = parseInt(req.query.adminId, 10);

        const [logs, total] = await Promise.all([
            prisma.adminSettingsAuditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.adminSettingsAuditLog.count({ where }),
        ]);

        return res.status(200).json({
            success: true,
            logs,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        logger.error({ err: error }, '[adminSettings.getAuditLog] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};
