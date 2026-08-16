// routes/walletRoutes.js
// =============================================================================
// AZAMAN V2 — WALLET ROUTES
// Mounted at /api/wallet. Reads are JWT-only (banned users keep read-only
// access); writes go through the ban guard.
// =============================================================================

const logger = require('../src/config/logger');
const express                  = require('express');
const router                   = express.Router();
const walletController         = require('../controllers/walletController');
const { protect }              = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const { require2FA } = require('../middleware/require2FA');
const { protectActive }        = require('../middleware/banGuardMiddleware');

// Withdrawals
router.post('/withdraw',       protectActive, require2FA(), idempotency(), walletController.requestWithdrawal);

// Read-only history (banned users still need to see their own history)
router.get('/history',         protect,       walletController.getWithdrawalHistory);

// Saved wallets / payout whitelist
router.post('/saved',          protectActive, idempotency(), walletController.addSavedWallet);
router.get('/saved',           protect,       walletController.getSavedWallets);
router.delete('/saved/:id',    protectActive, walletController.deleteSavedWallet);

// Fiat deposit gateway (initialize)
router.post('/deposit/initialize', protectActive, idempotency(), walletController.initializeFiatDeposit);

// Polygon deposit address (Phase C: Tatum HD wallet derivation)
router.get('/deposit-address/polygon', protect, walletController.getPolygonDepositAddress);

// ─── VENDOR INTERNAL TRANSFER (Fund Trading Pool / Withdraw to Wallet) ───────
// GET /api/wallet/pool-withdrawal-preview?amount=X — preview which ads would be deactivated
router.get('/pool-withdrawal-preview', protect, async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const amount = parseFloat(req.query.amount || '0');

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { vendorUnallocatedBalance: true }
        });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        const newPoolBalance = Number(user.vendorUnallocatedBalance) - amount;

        const activeAds = await prisma.ad.findMany({
            where: { vendorId: userId, status: 'ACTIVE' },
            select: { id: true, maxLimit: true, minLimit: true, paymentMethod: true, type: true, createdAt: true },
            orderBy: { createdAt: 'desc' }
        });

        const adsAtRisk = activeAds.filter(a => Number(a.maxLimit) > newPoolBalance);
        const adsSafe = activeAds.filter(a => Number(a.maxLimit) <= newPoolBalance);

        return res.status(200).json({
            success: true,
            data: {
                currentPoolBalance: Number(user.vendorUnallocatedBalance),
                withdrawAmount: amount,
                newPoolBalance: Math.max(0, newPoolBalance),
                totalActiveAds: activeAds.length,
                adsAtRisk,
                adsSafe,
                willDeactivate: adsAtRisk.length,
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// POST /api/wallet/internal-transfer
// Body: { direction: 'TO_POOL' | 'FROM_POOL', amount: number }
router.post('/internal-transfer', protectActive, require2FA(), idempotency(), async (req, res) => {
    const prisma = req.app.get('prisma');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const userId = req.user.id;
        const { direction, amount } = req.body;

        if (!direction || !['TO_POOL', 'FROM_POOL'].includes(direction)) {
            return res.status(400).json({
                success: false,
                message: 'direction must be "TO_POOL" or "FROM_POOL".'
            });
        }
        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
            return res.status(400).json({
                success: false,
                message: 'amount must be a positive number.'
            });
        }

        const amountFloat = parseFloat(amount);

        // Verify user is a vendor
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { role: true, availableBalance: true, vendorUnallocatedBalance: true }
        });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        if (user.role !== 'VENDOR' && user.role !== 'ADMIN') {
            return res.status(403).json({ success: false, message: 'Only vendors can transfer to/from the trading pool.' });
        }

        if (direction === 'TO_POOL') {
            // Available → Vendor Unallocated (fund trading pool)
            if (user.availableBalance < amountFloat) {
                return res.status(400).json({
                    success: false,
                    message: `Insufficient available balance. You have ${user.availableBalance} USDC.`
                });
            }

            await prisma.user.update({
                where: { id: userId },
                data: {
                    availableBalance: { decrement: amountFloat },
                    vendorUnallocatedBalance: { increment: amountFloat },
                }
            });
        } else {
            // Vendor Unallocated → Available (withdraw from trading pool)
            if (user.vendorUnallocatedBalance < amountFloat) {
                return res.status(400).json({
                    success: false,
                    message: `Insufficient trading pool balance. You have ${user.vendorUnallocatedBalance} USDC.`
                });
            }

            await prisma.user.update({
                where: { id: userId },
                data: {
                    vendorUnallocatedBalance: { decrement: amountFloat },
                    availableBalance: { increment: amountFloat },
                }
            });

            // Auto-deactivate ads that exceed the new pool balance
            const newPoolBalance = Number(user.vendorUnallocatedBalance) - amountFloat;
            const overLimitAds = await prisma.ad.findMany({
                where: {
                    vendorId: userId,
                    status: 'ACTIVE',
                    maxLimit: { gt: newPoolBalance }
                },
                select: { id: true, maxLimit: true, paymentMethod: true }
            });

            if (overLimitAds.length > 0) {
                await prisma.ad.updateMany({
                    where: { id: { in: overLimitAds.map(a => a.id) } },
                    data: { status: 'INACTIVE' }
                });
            }

            // Include deactivated ads info in response
            if (overLimitAds.length > 0) {
                if (emitBalanceUpdate) await emitBalanceUpdate(userId);
                return res.status(200).json({
                    success: true,
                    message: `${amountFloat} USDC moved to Available Wallet. ${overLimitAds.length} ad(s) were deactivated because they exceed your new pool balance.`,
                    data: {
                        direction,
                        amount: amountFloat,
                        newPoolBalance,
                        deactivatedAds: overLimitAds,
                        deactivatedCount: overLimitAds.length,
                    }
                });
            }
        }

        if (emitBalanceUpdate) await emitBalanceUpdate(userId);

        const label = direction === 'TO_POOL' ? 'Trading Pool' : 'Available Wallet';
        return res.status(200).json({
            success: true,
            message: `${amountFloat} USDC moved to ${label}.`,
            data: { direction, amount: amountFloat }
        });
    } catch (error) {
        logger.error({ err: error }, '[wallet.internalTransfer] error');
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
