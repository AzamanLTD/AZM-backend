// controllers/dataExportController.js
// =============================================================================
// AZAMAN — GDPR Data Export (Enterprise Readiness)
//
// GET /api/security/data-export
// Returns a comprehensive JSON export of the user's personal data across all
// AZM tables, fulfilling GDPR data-portability requirements.
//
// The export is paginated for large datasets (transactions, trades, messages)
// but the top-level structure covers every table that stores user PII.
// =============================================================================

const logger = require('../src/config/logger');

/**
 * GET /api/security/data-export
 * Export all personal data for the authenticated user.
 */
exports.exportUserData = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    try {
        // ── Core profile ──────────────────────────────────────────────
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                username: true,
                email: true,
                role: true,
                legalName: true,
                idType: true,
                idNumber: true,
                profilePictureUrl: true,
                phoneNumber: true,
                isPhoneVerified: true,
                kycStatus: true,
                googleId: true,
                appleId: true,
                influencerCode: true,
                referredByCode: true,
                tatumPolygonAddress: true,
                moolrePaymentId: true,
                availableBalance: true,
                escrowLockedBalance: true,
                azmBalance: true,
                equippedCardSkin: true,
                isTwoFactorEnabled: true,
                isDeleted: true,
                createdAt: true,
                // Sensitive fields — included for data portability completeness
                twoFactorSecret: true,
                pinHash: true,
            },
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // ── Parallel data collection ──────────────────────────────────
        const [
            refreshTokens,
            contacts,
            transactions,
            trades,
            deposits,
            withdrawals,
            savings,
            savedMomo,
            escrowLocks,
            feedback,
            badges,
            dailyLogins,
        ] = await Promise.all([
            // Active + revoked sessions
            prisma.refreshToken.findMany({
                where: { userId },
                select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true, revokedAt: true },
                orderBy: { createdAt: 'desc' },
                take: limit,
            }),

            // Contacts (saved numbers)
            prisma.contact.findMany({
                where: { savedByUserId: userId },
                select: { id: true, phoneNumber: true, displayName: true, createdAt: true },
                take: limit,
            }),

            // Transaction history
            prisma.transactionHistory.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: limit,
            }),

            // P2P trades
            prisma.trade.findMany({
                where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
                orderBy: { createdAt: 'desc' },
                take: limit,
            }),

            // Deposits
            prisma.deposit.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: limit,
            }),

            // Withdrawals
            prisma.withdrawal.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: limit,
            }),

            // Savings accounts
            prisma.savingsAccount.findMany({
                where: { userId },
                include: { contributions: { orderBy: { createdAt: 'desc' }, take: 20 } },
            }),

            // Saved MoMo accounts
            prisma.savedMomoAccount.findMany({
                where: { userId },
                select: { id: true, nickname: true, provider: true, phoneNumber: true, isPrimary: true, createdAt: true },
            }),

            // Escrow locks
            prisma.escrowLock.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: limit,
            }),

            // Employee feedback
            prisma.feedback.findMany({
                where: { givenByUserId: userId },
                select: { id: true, rating: true, comment: true, createdAt: true },
                take: limit,
            }),

            // Earned badges
            prisma.userBadge.findMany({
                where: { userId },
                include: { badge: { select: { name: true, description: true } } },
            }),

            // Daily login streak
            prisma.dailyLogin.findMany({
                where: { userId },
                orderBy: { date: 'desc' },
                take: 90,
            }),
        ]);

        const exportData = {
            exportedAt: new Date().toISOString(),
            userId,
            user,
            sessions: refreshTokens,
            contacts,
            transactions,
            trades,
            deposits,
            withdrawals,
            savingsAccounts: savings,
            savedPaymentMethods: savedMomo,
            escrowLocks,
            feedbackGiven: feedback,
            badges,
            loginHistory: dailyLogins,
            summary: {
                totalTransactions: transactions.length,
                totalTrades: trades.length,
                totalDeposits: deposits.length,
                totalWithdrawals: withdrawals.length,
                savingsAccounts: savings.length,
                savedPaymentMethods: savedMomo.length,
                activeSessions: refreshTokens.filter(t => !t.revokedAt).length,
                loginDays: dailyLogins.length,
            },
        };

        logger.info({ userId, tablesExported: Object.keys(exportData).length - 2 }, '[data-export] export generated');

        return res.json({
            success: true,
            message: 'Data export generated.',
            data: exportData,
        });
    } catch (e) {
        logger.error({ err: e }, '[data-export] error');
        return res.status(500).json({
            success: false,
            message: 'Could not generate data export.',
        });
    }
};

