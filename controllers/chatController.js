// controllers/chatController.js
// =============================================================================
// AZAMAN V2 — TRADE CHAT CONTROLLER
//
// All Message rows are written via the V2 schema:
//   { conversationId, senderId, tradeId, messageType, content }
// The trade conversation is lazily created on first write so callers never
// have to create it explicitly.
// =============================================================================

const { parsePagination, buildPageEnvelope } = require('../utils/pagination');

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Lazy-fetch (or create) the V2 Conversation row for a trade.
 * Both buyer and vendor are connected as participants.
 *
 * Accepts either a `prisma` client or a `tx` transactional client.
 */
const _getOrCreateTradeConversation = async (client, trade) => {
    const tradeIdStr = String(trade.id);
    let conv = await client.conversation.findUnique({ where: { tradeId: tradeIdStr } });
    if (conv) return conv;

    return client.conversation.create({
        data: {
            type:    'TRADE',
            tradeId: tradeIdStr,
            participants: {
                connect: [{ id: trade.userId }, { id: trade.vendorId }]
            }
        }
    });
};

// =============================================================================
// 1. SEND TEXT MESSAGE
// =============================================================================
exports.sendMessage = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io     = req.app.get('socketio');

    try {
        const { tradeId, text } = req.body;
        const senderId = req.user.id;

        const tradeIdInt = parseInt(tradeId, 10);
        if (isNaN(tradeIdInt)) {
            return res.status(400).json({ success: false, message: 'Invalid tradeId.' });
        }
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ success: false, message: 'Message text is required.' });
        }

        const trade = await prisma.trade.findUnique({
            where:  { id: tradeIdInt },
            select: { id: true, userId: true, vendorId: true }
        });
        if (!trade) return res.status(404).json({ success: false, message: 'Trade not found.' });

        // Authorization: only buyer or vendor of this trade can write.
        if (senderId !== trade.userId && senderId !== trade.vendorId) {
            return res.status(403).json({ success: false, message: 'You are not a party to this trade.' });
        }

        const conversation = await _getOrCreateTradeConversation(prisma, trade);

        const message = await prisma.message.create({
            data: {
                conversationId: conversation.id,
                senderId,
                tradeId:        trade.id,
                messageType:    'TEXT',
                content:        text.trim()
            },
            include: { sender: { select: { id: true, username: true, role: true } } }
        });

        io.to(`trade_${trade.id}`).emit('new_message', {
            id:          message.id,
            sender:      message.sender,
            content:     message.content,
            messageType: message.messageType,
            createdAt:   message.createdAt
        });

        return res.status(201).json({ success: true, message });
    } catch (error) {
        console.error('chat.sendMessage error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
};

// =============================================================================
// 2. SEND IMAGE MESSAGE  (payment proofs / screenshots)
// =============================================================================
exports.sendImageMessage = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io     = req.app.get('socketio');

    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image uploaded.' });
        }

        const { tradeId } = req.body;
        const senderId    = req.user.id;
        const tradeIdInt  = parseInt(tradeId, 10);

        if (isNaN(tradeIdInt)) {
            return res.status(400).json({ success: false, message: 'Invalid tradeId.' });
        }

        const trade = await prisma.trade.findUnique({
            where:  { id: tradeIdInt },
            select: { id: true, userId: true, vendorId: true }
        });
        if (!trade) return res.status(404).json({ success: false, message: 'Trade not found.' });
        if (senderId !== trade.userId && senderId !== trade.vendorId) {
            return res.status(403).json({ success: false, message: 'You are not a party to this trade.' });
        }

        // Persist the screenshot to Cloudinary so its URL survives redeploys
        // (Render's local disk is ephemeral). Multer now buffers the file in
        // memory; the shared service streams the buffer up and returns a
        // permanent secure_url.
        const { uploadToCloudinary } = require('../services/cloudinaryService');
        const { url: imageUrl } = await uploadToCloudinary(req.file, 'chat/images');

        const conversation = await _getOrCreateTradeConversation(prisma, trade);

        const message = await prisma.message.create({
            data: {
                conversationId: conversation.id,
                senderId,
                tradeId:        trade.id,
                messageType:    'IMAGE_PROOF',
                content:        imageUrl
            },
            include: { sender: { select: { id: true, username: true, role: true } } }
        });

        io.to(`trade_${trade.id}`).emit('new_message', {
            id:          message.id,
            sender:      message.sender,
            content:     imageUrl,
            messageType: message.messageType,
            createdAt:   message.createdAt
        });

        return res.status(201).json({ success: true, message });
    } catch (error) {
        console.error('chat.sendImageMessage error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
};

// =============================================================================
// 3. GET CHAT HISTORY  (V2: pulls from Conversation → Message)
//
// Phase I: cursor pagination.
//   - Legacy callers (no cursor/limit/page params) get the full conversation
//     in ASCending createdAt order — the pre-Phase-I contract — so existing
//     FE code that renders directly without reversing keeps working.
//   - Opted-in callers (any pagination param) get DESCending order with a
//     `nextCursor` envelope; client reverses for display, walks backwards
//     through history with `?cursor=<lastMessageId>`.
//   - Secondary `id` sort tiebreakers prevent skip/repeat on same-millisecond
//     messages (rare but real on notification-driven SYSTEM messages).
// =============================================================================
exports.getChatHistory = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { tradeId } = req.params;
        const tradeIdStr  = String(tradeId).replace(/^#/, '');
        const tradeIdInt  = parseInt(tradeIdStr, 10);

        if (isNaN(tradeIdInt)) {
            return res.status(400).json({ success: false, message: 'Invalid tradeId.' });
        }

        const optedIn = ('cursor' in req.query) || ('limit' in req.query) || ('page' in req.query);
        const { take, cursor, mode, page } = parsePagination({
            ...req.query,
            limit: req.query.limit || 50
        });

        const conversation = await prisma.conversation.findUnique({
            where:  { tradeId: tradeIdStr },
            select: { id: true }
        });

        if (!conversation) {
            if (optedIn) {
                return res.status(200).json({
                    success: true,
                    messages: [],
                    nextCursor: null,
                    hasMore: false,
                    limit: take
                });
            }
            return res.status(200).json({ success: true, messages: [] });
        }

        if (!optedIn) {
            // Legacy contract — full conversation, ASC order, no envelope.
            const messages = await prisma.message.findMany({
                where:   { conversationId: conversation.id },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                include: { sender: { select: { id: true, username: true, role: true } } }
            });
            return res.status(200).json({ success: true, messages });
        }

        // Cursor mode — newest-first window.
        const messages = await prisma.message.findMany({
            where:   { conversationId: conversation.id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            include: { sender: { select: { id: true, username: true, role: true } } },
            ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {})
        });

        const envelope = buildPageEnvelope(messages, take, mode, page);

        return res.status(200).json({
            success: true,
            messages,
            ...envelope
        });
    } catch (error) {
        console.error('chat.getChatHistory error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
};
