// controllers/azmGiftController.js
// =============================================================================
// AZAMAN V3 — AZM Gifting & Tipping (Phase 5)
//
// Users can send AZM loyalty points to other users as gifts or tips.
// This is a P2P transfer within the platform ledger (no on-chain movement).
//
// Economic atomicity (2026-09-17): the transfer core lives in
// services/azmGiftService.sendGiftTransfer — ONE database transaction
// (debit + credit + gift record) with a deterministic Idempotency-Key-derived
// operation identity, DB-uniqueness-enforced exactly-once semantics, and
// post-commit socket emission. This controller is a thin HTTP adapter: it
// enforces the required Idempotency-Key, maps service errors to HTTP status
// codes, and emits nothing itself — the service owns post-commit delivery.
//
// Gift types:
//   - GIFT: Generic AZM gift with optional message
//   - TIP: AZM tip attached to a trade, chat, or marketplace interaction
//   - REWARD: User-initiated reward (community contribution, helpful answer, etc.)
// =============================================================================

const logger = require('../src/config/logger');
const {
    sendGiftTransfer,
    GiftValidationError,
    ReceiverNotFoundError,
} = require('../services/azmGiftService');

// ── POST /api/azm-gifts/send ─────────────────────────────────────────────────
async function sendGift(req, res) {
    try {
        const prisma = req.app.get('prisma');
        const io = req.app.get('io');

        const result = await sendGiftTransfer(prisma, io, {
            senderId: req.user.id,
            receiverId: req.body.receiverId,
            amount: req.body.amount,
            type: req.body.type,
            message: req.body.message,
            contextType: req.body.contextType,
            contextId: req.body.contextId,
            // REQUIRED for this economic endpoint — rejected before any
            // mutation if missing/invalid (enforced in the service).
            idempotencyKey: req.headers['idempotency-key'],
        });

        return res.json({
            success: true,
            message: `${result.gift.type === 'TIP' ? 'Tip' : 'Gift'} sent successfully.`,
            gift: result.gift,
            newBalance: result.senderNewBalance,
        });
    } catch (err) {
        if (err instanceof GiftValidationError) {
            return res.status(400).json({ success: false, message: err.message });
        }
        if (err instanceof ReceiverNotFoundError) {
            return res.status(404).json({ success: false, message: err.message });
        }
        if (err.message && err.message.includes('Insufficient')) {
            return res.status(400).json({ success: false, message: 'Insufficient AZM balance.' });
        }
        logger.error({ err: err }, '[azmGift] send error');
        return res.status(500).json({ success: false, message: 'Failed to send gift.' });
    }
}

// ── GET /api/azm-gifts/received ──────────────────────────────────────────────
async function getReceivedGifts(req, res) {
    try {
        const prisma = req.app.get('prisma');
        const gifts = await prisma.azmGift.findMany({
            where: { receiverId: req.user.id },
            include: {
                sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        return res.json({ success: true, gifts });
    } catch (err) {
        logger.error({ err: err }, '[azmGift] received error');
        return res.status(500).json({ success: false, message: 'Failed to load gifts.' });
    }
}

// ── GET /api/azm-gifts/sent ─────────────────────────────────────────────────
async function getSentGifts(req, res) {
    try {
        const prisma = req.app.get('prisma');
        const gifts = await prisma.azmGift.findMany({
            where: { senderId: req.user.id },
            include: {
                receiver: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        return res.json({ success: true, gifts });
    } catch (err) {
        logger.error({ err: err }, '[azmGift] sent error');
        return res.status(500).json({ success: false, message: 'Failed to load gifts.' });
    }
}

// ── GET /api/azm-gifts/stats ────────────────────────────────────────────────
async function getGiftStats(req, res) {
    try {
        const prisma = req.app.get('prisma');
        const userId = req.user.id;
        const [received, sent, totalReceived, totalSent] = await Promise.all([
            prisma.azmGift.count({ where: { receiverId: userId } }),
            prisma.azmGift.count({ where: { senderId: userId } }),
            prisma.azmGift.aggregate({ where: { receiverId: userId }, _sum: { amount: true } }),
            prisma.azmGift.aggregate({ where: { senderId: userId }, _sum: { amount: true } }),
        ]);

        return res.json({
            success: true,
            stats: {
                receivedCount: received,
                sentCount: sent,
                totalReceived: parseFloat(totalReceived._sum.amount?.toString() || '0'),
                totalSent: parseFloat(totalSent._sum.amount?.toString() || '0'),
            },
        });
    } catch (err) {
        logger.error({ err: err }, '[azmGift] stats error');
        return res.status(500).json({ success: false, message: 'Failed to load gift stats.' });
    }
}

module.exports = {
    sendGift,
    getReceivedGifts,
    getSentGifts,
    getGiftStats,
};
