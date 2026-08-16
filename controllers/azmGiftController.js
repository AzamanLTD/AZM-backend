// controllers/azmGiftController.js
// =============================================================================
// AZAMAN V3 — AZM Gifting & Tipping (Phase 5)
//
// Users can send AZM loyalty points to other users as gifts or tips.
// This is a P2P transfer within the platform ledger (no on-chain movement).
//
// Flow:
//   1. Sender's AZM is debited via AzmSpendService.debitAzm (source: GIFT_TIP)
//   2. Receiver's AZM is credited via AzmRewardService.creditAzm (source: GIFT_TIP_RECEIVED)
//   3. An AzmGift record captures the transfer metadata (message, type, context)
//   4. Real-time socket notification to the receiver
//
// Gift types:
//   - GIFT: Generic AZM gift with optional message
//   - TIP: AZM tip attached to a trade, chat, or marketplace interaction
//   - REWARD: User-initiated reward (community contribution, helpful answer, etc.)
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');
const { AzmSpendService, AZM_SPEND_SOURCES } = require('../services/azmSpendService');
const { AzmRewardService } = require('../services/azmRewardService');

const spendService = new AzmSpendService(prisma);
const rewardService = new AzmRewardService(prisma);

// Gift type enum
const GIFT_TYPES = ['GIFT', 'TIP', 'REWARD'];

// Context types for tips (what the tip is attached to)
const TIP_CONTEXTS = ['TRADE', 'CHAT', 'MARKETPLACE', 'SUSU', 'BUSINESS', 'GENERAL'];

// ── POST /api/azm-gifts/send ─────────────────────────────────────────────────
async function sendGift(req, res) {
  try {
    const senderId = req.user.id;
    const { receiverId, amount, type = 'GIFT', message, contextType, contextId } = req.body;

    // Validation
    if (!receiverId) return res.status(400).json({ success: false, message: 'Receiver is required.' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ success: false, message: 'Amount must be positive.' });
    if (senderId === parseInt(receiverId, 10)) return res.status(400).json({ success: false, message: 'Cannot send AZM to yourself.' });
    if (!GIFT_TYPES.includes(type)) return res.status(400).json({ success: false, message: 'Invalid gift type.' });
    if (contextType && !TIP_CONTEXTS.includes(contextType)) {
      return res.status(400).json({ success: false, message: 'Invalid tip context.' });
    }

    const giftAmount = parseFloat(amount);

    // Verify receiver exists
    const receiver = await prisma.user.findUnique({
      where: { id: parseInt(receiverId, 10) },
      select: { id: true, username: true, isDeleted: true },
    });

    if (!receiver || receiver.isDeleted) {
      return res.status(404).json({ success: false, message: 'Receiver not found.' });
    }

    // Debit sender
    const dedupKey = `gift_${senderId}_${receiverId}_${Date.now()}`;
    let debitResult;
    try {
      debitResult = await spendService.debitAzm({
        userId: senderId,
        amount: giftAmount,
        source: AZM_SPEND_SOURCES.GIFT_TIP || 'GIFT_TIP',
        reason: `${type === 'TIP' ? 'Tip' : 'Gift'} to @${receiver.username}`,
        metadata: { receiverId: parseInt(receiverId, 10), type, contextType, contextId },
        dedupKey,
      });
    } catch (err) {
      if (err.message.includes('Insufficient')) {
        return res.status(400).json({ success: false, message: 'Insufficient AZM balance.' });
      }
      throw err;
    }

    // Credit receiver
    const creditResult = await rewardService.creditAzm({
      userId: parseInt(receiverId, 10),
      amount: giftAmount,
      source: 'GIFT_TIP_RECEIVED',
      reason: `${type === 'TIP' ? 'Tip' : 'Gift'} from user #${senderId}`,
      metadata: { senderId, type, contextType, contextId, message: message || null },
      dedupKey: `gift_received_${debitResult.logId}`,
    });

    // Create gift record
    const gift = await prisma.azmGift.create({
      data: {
        senderId,
        receiverId: parseInt(receiverId, 10),
        amount: giftAmount,
        type,
        message: message || null,
        contextType: contextType || null,
        contextId: contextId || null,
      },
      include: {
        sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
        receiver: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
      },
    });

    // Socket notification
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${receiverId}`).emit('azm_gift_received', {
        giftId: gift.id,
        sender: gift.sender,
        amount: giftAmount,
        type,
        message: message || null,
        newBalance: creditResult.newBalance,
      });
    }

    return res.json({
      success: true,
      message: `${type === 'TIP' ? 'Tip' : 'Gift'} sent successfully.`,
      gift,
      newBalance: debitResult.newBalance,
    });
  } catch (err) {
    logger.error({ err: err }, '[azmGift] send error');
    return res.status(500).json({ success: false, message: 'Failed to send gift.' });
  }
}

// ── GET /api/azm-gifts/received ──────────────────────────────────────────────
async function getReceivedGifts(req, res) {
  try {
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
    return res.status(500).json({ success: false, message: 'Failed to load sent gifts.' });
  }
}

// ── GET /api/azm-gifts/stats ────────────────────────────────────────────────
async function getGiftStats(req, res) {
  try {
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
