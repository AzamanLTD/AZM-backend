// routes/tradeRoutes.js
// =============================================================================
// AZAMAN V2 — TRADE ROUTES
//
// Trade completion is now ONLY available via POST /api/p2p/complete (see
// p2pRoutes.js → p2p.controller.completeTrade → services/p2p.service).
// The legacy POST /api/trades/release route has been removed.
// =============================================================================

const logger = require('../src/config/logger');
const express             = require('express');
const router              = express.Router();
const tradeController     = require('../controllers/tradeController');
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { protectActive }   = require('../middleware/banGuardMiddleware');
const upload              = require('../middleware/uploadMiddleware');

const {
    initiateTrade,
    acceptTrade,
    declineTrade,
    getTradeDetails,
    markAsPaid,
    getTradeHistory,
    disputeTrade,
    submitReview
} = tradeController;

// B-1: Active trades count for nav badge
router.get('/active', protect, tradeController.getActiveTrades);

// ── Read endpoints (banned users retain read-only access) ────────────────────
router.get('/history', protect, getTradeHistory);
router.get('/:id',     protect, getTradeDetails);

// ── Buyer actions ────────────────────────────────────────────────────────────
router.post('/initiate', protectActive, initiateTrade);

// ── Vendor approval actions ──────────────────────────────────────────────────
router.post('/accept',  protectActive, acceptTrade);
router.post('/decline', protectActive, declineTrade);

// ── Time extension ───────────────────────────────────────────────────────────
// POST /trades/extend — Vendor or user can extend (different rules)
router.post('/extend', protectActive, async (req, res) => {
    const prisma = req.app.get('prisma');
    const io     = req.app.get('socketio');
    const notificationService = req.app.get('notificationService');

    try {
        const { tradeId, addedMinutes, isRequest, requestMessageId } = req.body;
        const callerId = req.user.id;

        if (!tradeId || !addedMinutes || addedMinutes <= 0) {
            return res.status(400).json({ success: false, message: 'tradeId and addedMinutes required.' });
        }
        if (addedMinutes > 120) {
            return res.status(400).json({ success: false, message: 'Maximum 120 minutes per request.' });
        }

        const tradeIdInt = parseInt(tradeId, 10);
        const trade = await prisma.trade.findUnique({
            where: { id: tradeIdInt },
            include: {
                user: { select: { id: true, username: true } },
                vendor: { select: { id: true, username: true } }
            }
        });
        if (!trade) return res.status(404).json({ success: false, message: 'Trade not found.' });
        if (trade.status !== 'PENDING_PAYMENT' && trade.status !== 'PAID') {
            return res.status(400).json({ success: false, message: `Cannot extend trade in status ${trade.status}.` });
        }

        const isVendor = callerId === trade.vendorId;
        const isUser = callerId === trade.userId;
        if (!isVendor && !isUser) {
            return res.status(403).json({ success: false, message: 'Not a party to this trade.' });
        }

        // Get the trade conversation for messages
        const conversation = await prisma.conversation.findUnique({
            where: { tradeId: String(tradeIdInt) }
        });

        if (isRequest && isUser) {
            // User requests time extension — post a message card, vendor must approve
            if (!conversation) {
                return res.status(500).json({ success: false, message: 'Trade conversation not found.' });
            }
            const msg = await prisma.message.create({
                data: {
                    conversationId: conversation.id,
                    senderId: callerId,
                    tradeId: tradeIdInt,
                    messageType: 'TEXT',
                    content: JSON.stringify({
                        type: 'TIME_EXTENSION_REQUEST',
                        addedMinutes,
                        status: 'PENDING',
                        requestedBy: callerId,
                    })
                }
            });

            // Broadcast to room
            io.to(`trade_${tradeIdInt}`).emit('new_message', {
                id: msg.id,
                content: msg.content,
                messageType: msg.messageType,
                createdAt: msg.createdAt,
                sender: { id: callerId, username: trade.user.username }
            });

            // Notify vendor
            if (notificationService) {
                await notificationService.sendNotification({
                    userId: trade.vendorId,
                    title: '⏱ Time Extension Requested',
                    body: `${trade.user.username} requested ${addedMinutes} more minutes. Tap to respond.`,
                    category: 'VENDOR_PRIORITY',
                    actionPayload: {
                        route: `/trade/${tradeIdInt}`,
                        action: 'OPEN_TRADE',
                        tradeId: String(tradeIdInt),
                    },
                });
            }

            return res.status(200).json({ success: true, message: 'Time extension requested.', messageId: msg.id });
        }

        // Vendor extends directly OR responds to a request — apply immediately
        if (!isVendor) {
            return res.status(403).json({ success: false, message: 'Only the vendor can grant time extensions.' });
        }

        const currentExpires = trade.expiresAt;
        const newExpiresAt = new Date(currentExpires.getTime() + addedMinutes * 60_000);

        // BUGFIX (2026-05-31): when the vendor is responding to a chat
        // request card (requestMessageId provided), update the original
        // request message's content so its status becomes APPROVED.
        // Both clients listen for `message_updated` to flip the card
        // from "Grant / Decline" buttons → "✓ Granted +X minutes".
        //
        // Idempotency MUST happen BEFORE the timer mutation. The
        // previous order extended the timer first, then bailed out on
        // 409 — meaning every duplicate tap added more minutes despite
        // the user-facing "already responded" error. Now the check
        // happens before any state change.
        let parsedRequestContent = null;
        if (requestMessageId) {
            const reqMsgId = String(requestMessageId);
            const requestMsg = await prisma.message.findUnique({ where: { id: reqMsgId } });
            if (requestMsg && requestMsg.tradeId === tradeIdInt) {
                try { parsedRequestContent = JSON.parse(requestMsg.content || '{}'); } catch (_) { parsedRequestContent = {}; }
                if (parsedRequestContent.status && parsedRequestContent.status !== 'PENDING') {
                    return res.status(409).json({
                        success: false,
                        message: `Request already ${String(parsedRequestContent.status).toLowerCase()}.`
                    });
                }
            }
        }

        await prisma.trade.update({
            where: { id: tradeIdInt },
            data: { expiresAt: newExpiresAt },
        });

        let updatedRequestMessage = null;
        if (requestMessageId && parsedRequestContent !== null) {
            try {
                const reqMsgId = String(requestMessageId);
                parsedRequestContent.status = 'APPROVED';
                parsedRequestContent.respondedBy = callerId;
                parsedRequestContent.respondedAt = new Date().toISOString();
                parsedRequestContent.addedMinutes = parsedRequestContent.addedMinutes || addedMinutes;
                updatedRequestMessage = await prisma.message.update({
                    where: { id: reqMsgId },
                    data: { content: JSON.stringify(parsedRequestContent) }
                });
            } catch (e) {
                logger.warn('extend: failed to update request message:', e.message);
            }
        }

        if (updatedRequestMessage) {
            io.to(`trade_${tradeIdInt}`).emit('message_updated', {
                id: updatedRequestMessage.id,
                content: updatedRequestMessage.content,
                tradeId: tradeIdInt,
            });
        }

        // Post a granted message in the chat
        if (conversation) {
            const grantedMsg = await prisma.message.create({
                data: {
                    conversationId: conversation.id,
                    senderId: callerId,
                    tradeId: tradeIdInt,
                    messageType: 'TEXT',
                    content: JSON.stringify({
                        type: 'TIME_EXTENSION_GRANTED',
                        addedMinutes,
                        newExpiresAt,
                        grantedBy: callerId,
                    })
                }
            });

            io.to(`trade_${tradeIdInt}`).emit('new_message', {
                id: grantedMsg.id,
                content: grantedMsg.content,
                messageType: grantedMsg.messageType,
                createdAt: grantedMsg.createdAt,
                sender: { id: callerId, username: trade.vendor.username }
            });
        }

        // Broadcast trade update so both sides resync timer
        io.to(`trade_${tradeIdInt}`).emit('trade_update', {
            tradeId: tradeIdInt,
            status: trade.status,
            expiresAt: newExpiresAt,
            extendedBy: addedMinutes,
        });

        // Notify user
        if (notificationService && trade.userId !== callerId) {
            await notificationService.sendNotification({
                userId: trade.userId,
                title: '⏱ Time Extended',
                body: `Vendor added ${addedMinutes} minutes to your trade.`,
                category: 'GENERAL',
                actionPayload: {
                    route: `/trade/${tradeIdInt}`,
                    action: 'OPEN_TRADE',
                    tradeId: String(tradeIdInt),
                },
            });
        }

        return res.status(200).json({
            success: true,
            message: `Trade time extended by ${addedMinutes} minutes.`,
            newExpiresAt
        });
    } catch (error) {
        logger.error({ err: error }, 'extend trade error');
        return res.status(500).json({ success: false, message: error.message });
    }
});

// POST /trades/extend/respond — Vendor responds to a time extension request.
// Currently used for explicit DECLINE (the APPROVE path is folded into
// /extend with `requestMessageId` so the timer mutation and the chat
// status flip happen atomically). Splitting decline out keeps the
// approve-path simple: the vendor's tap sends `addedMinutes`, and the
// decline path doesn't need that field at all.
router.post('/extend/respond', protectActive, async (req, res) => {
    const prisma = req.app.get('prisma');
    const io     = req.app.get('socketio');
    const notificationService = req.app.get('notificationService');

    try {
        const { tradeId, requestMessageId, action } = req.body;
        const callerId = req.user.id;

        if (!tradeId || !requestMessageId || !action) {
            return res.status(400).json({ success: false, message: 'tradeId, requestMessageId, and action required.' });
        }
        if (action !== 'decline') {
            return res.status(400).json({ success: false, message: 'Only decline is supported here. Use /extend with requestMessageId for approval.' });
        }

        const tradeIdInt = parseInt(tradeId, 10);
        const trade = await prisma.trade.findUnique({
            where: { id: tradeIdInt },
            include: {
                user: { select: { id: true, username: true } },
                vendor: { select: { id: true, username: true } }
            }
        });
        if (!trade) return res.status(404).json({ success: false, message: 'Trade not found.' });
        if (callerId !== trade.vendorId) {
            return res.status(403).json({ success: false, message: 'Only the vendor can respond to time extension requests.' });
        }

        const requestMsgIdStr = String(requestMessageId);
        const requestMsg = await prisma.message.findUnique({ where: { id: requestMsgIdStr } });
        if (!requestMsg || requestMsg.tradeId !== tradeIdInt) {
            return res.status(404).json({ success: false, message: 'Request message not found.' });
        }

        let parsed = {};
        try { parsed = JSON.parse(requestMsg.content || '{}'); } catch (_) {}

        // Idempotent: if already resolved, just echo back so the FE can
        // sync without erroring out.
        if (parsed.status && parsed.status !== 'PENDING') {
            return res.status(409).json({
                success: false,
                message: `Request already ${String(parsed.status).toLowerCase()}.`
            });
        }

        parsed.status = 'DECLINED';
        parsed.respondedBy = callerId;
        parsed.respondedAt = new Date().toISOString();

        const updated = await prisma.message.update({
            where: { id: requestMsgIdStr },
            data: { content: JSON.stringify(parsed) }
        });

        io.to(`trade_${tradeIdInt}`).emit('message_updated', {
            id: updated.id,
            content: updated.content,
            tradeId: tradeIdInt,
        });

        // Notify the requester
        if (notificationService && trade.userId !== callerId) {
            await notificationService.sendNotification({
                userId: trade.userId,
                title: '⏱ Time Extension Declined',
                body: `Vendor declined your request for more time on trade #${tradeIdInt}.`,
                category: 'GENERAL',
                actionPayload: {
                    route: `/trade/${tradeIdInt}`,
                    action: 'OPEN_TRADE',
                    tradeId: String(tradeIdInt),
                },
            });
        }

        return res.status(200).json({ success: true, message: 'Request declined.' });
    } catch (error) {
        logger.error({ err: error }, 'extend/respond error');
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Mark as paid (with proof upload). Multer errors are converted to 400 JSON.
router.post(
    '/upload-proof',
    protectActive,
    (req, res, next) => {
        const uploadSingle = upload.single('proof');
        uploadSingle(req, res, (err) => {
            if (err) {
                logger.error({ err: err }, 'MULTER REJECTED UPLOAD');
                return res.status(400).json({ success: false, message: 'Upload failed: ' + err.message });
            }
            next();
        });
    },
    markAsPaid
);

// Either party can dispute a trade.
router.post('/dispute', protectActive, disputeTrade);

// ── Post-trade actions ───────────────────────────────────────────────────────
router.post('/review', protectActive, submitReview);

module.exports = router;
