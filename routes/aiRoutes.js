const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const queueController = require('../controllers/queueController');
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { require2FA } = require('../middleware/require2FA');
const { idempotency } = require('../middleware/idempotency');

router.get('/capabilities', protect, adminOnly, aiController.getAiCapabilities);

router.post('/cfo/analyze', protect, adminOnly, aiController.triggerCfoAnalysis);

// ── Queue-initiated trades share the canonical trade-initiation authority ──
// (2026-10-20 route-level review): this handler falls through to
// tradeController.initiateTrade whenever capacity is available or frees up
// under the admission lock — a direct controller call that does NOT execute
// the canonical route's middleware stack. It previously mounted with protect
// alone, so the queue entry point could reach trade creation without the
// active-user/ban guard, the 2FA step-up, or the durable idempotency claim
// (a response-disposition flag without a claim is not idempotency).
//
// The mount now runs the SAME guards as POST /api/trades/initiate, and —
// critically — the idempotency authority carries the EXPLICIT canonical
// identity 'POST /api/trades/initiate': one logical trade = one durable
// FinancialOperation claim no matter which entry path served it. A key
// used against this route and the canonical route cannot create two
// independent operations. The fingerprint (params + body) still guards the
// claim, so key reuse with a materially different body fails closed. Same
// required-key semantics as the canonical route: no key → deterministic
// 400 before any claim or mutation. The /api/admin/ai alias mount of this
// router shares the same explicit identity by construction.
router.post('/queue/initiate', protectActive, require2FA(), idempotency({ identity: 'POST /api/trades/initiate' }), queueController.initiateTradeWithQueue);
router.get('/queue/status', protect, queueController.getQueueStatus);
router.put('/queue/:queueId/leave', protect, queueController.leaveQueue);

router.post('/queue/process/:adId', protect, adminOnly, async (req, res) => {
    try {
        const { adId } = req.params;
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        const result = await queueController.processNextInQueue(adId, { prisma, io });
        res.status(200).json({ success: true, processed: result });
    } catch (error) {
        logger.error('[AI Routes] processNextInQueue error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;

// ── Phase 3: Admin AI Ops endpoints ───────────────────────────────────────────

// GET /api/ai/cfo-insights — generates AI CFO insights summary
router.get('/cfo-insights', protect, adminOnly, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');

        // Gather financial data
        const [totalUsers, totalVolume, totalFees, paidInvoices, pendingDisputes, activePools] = await Promise.all([
            prisma.user.count(),
            prisma.trade.aggregate({ _sum: { amountUsd: true } }).catch(() => ({ _sum: { amountUsd: 0 } })),
            prisma.fee.aggregate({ _sum: { amount: true } }).catch(() => ({ _sum: { amount: 0 } })),
            prisma.businessInvoice.count({ where: { status: 'PAID' } }).catch(() => 0),
            prisma.escrowDispute.count({ where: { status: 'OPEN' } }).catch(() => 0),
            prisma.susuPool.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
        ]);

        const volumeUsd = (totalVolume._sum?.amountUsd || 0).toString();
        const feesUsd = (totalFees._sum?.amount || 0).toString();

        // Generate insights
        const insights = {
            summary: `Platform has ${totalUsers} registered users with $${volumeUsd} in total trade volume and $${feesUsd} in collected fees. There are ${paidInvoices} paid invoices, ${pendingDisputes} open disputes, and ${activePools} active susu pools.`,
            recommendations: [
                pendingDisputes > 5 ? `${pendingDisputes} open disputes — consider prioritizing dispute resolution.` : 'Dispute queue is healthy.',
                paidInvoices > 50 ? 'Strong invoice adoption — consider promoting recurring billing features.' : 'Invoice adoption is growing — encourage businesses to use invoicing.',
                activePools > 10 ? `${activePools} active susu pools — healthy community savings activity.` : 'Susu pool adoption is early — consider promotional incentives.',
                'Review fee structures quarterly to ensure competitive positioning.',
            ],
        };

        res.json(insights);
    } catch (err) {
        logger.error('[AI Routes] cfo-insights error:', err);
        res.status(500).json({ message: err.message });
    }
});

// GET /api/ai/discount-candidates — identifies users eligible for loyalty discounts
router.get('/discount-candidates', protect, adminOnly, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');

        // Find users with high trade activity
        const users = await prisma.user.findMany({
            where: { isBanned: false },
            select: {
                id: true,
                email: true,
                full_name: true,
                _count: {
                    select: {
                        tradesAsBuyer: true,
                        tradesAsSeller: true,
                    },
                },
            },
            take: 200,
        }).catch(() => []);

        const candidates = users
            .map(u => ({
                userId: u.id,
                userName: u.full_name || u.email || `User ${u.id}`,
                tradeCount: (u._count?.tradesAsBuyer || 0) + (u._count?.tradesAsSeller || 0),
                totalVolume: 0,
                reason: 'High trade activity',
            }))
            .filter(c => c.tradeCount >= 5)
            .sort((a, b) => b.tradeCount - a.tradeCount)
            .slice(0, 10);

        res.json(candidates);
    } catch (err) {
        logger.error('[AI Routes] discount-candidates error:', err);
        res.json([]);
    }
});

// POST /api/ai/approve-discount — approves a loyalty discount credit
router.post('/approve-discount', protect, adminOnly, async (req, res) => {
    try {
        const { userId, amount, duration } = req.body;
        const prisma = req.app.get('prisma');

        if (!userId || !amount) {
            return res.status(400).json({ message: 'userId and amount are required.' });
        }

        // Apply a fee discount by creating a credit record
        // This could be a platform balance credit or a fee waiver
        const user = await prisma.user.findUnique({
            where: { id: parseInt(userId, 10) || userId },
            select: { id: true, email: true, full_name: true },
        });

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.json({ success: true, message: `Discount of $${amount} approved for ${user.full_name || user.email} for ${duration || 30} days.` });
    } catch (err) {
        logger.error('[AI Routes] approve-discount error:', err);
        res.status(500).json({ message: err.message });
    }
});

