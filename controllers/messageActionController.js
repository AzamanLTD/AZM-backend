// =============================================================================
// AZAMAN — Message Actions Controller (Phase 3.3.4)
//
// Handles: search, pin/unpin, star/unstar, forward, get starred messages
//
// Works across all three message types:
//   - DirectMessage (friend chat)
//   - GroupMessage (group chat)
//   - Message (trade chat)
//
// Reference: WhatsApp (pin, star, search), Telegram (forward, search)
// =============================================================================

// Prisma is accessed via req.app.get('prisma') — injected in each handler

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the correct Prisma model delegate based on the message context.
 * @param {string} context - 'direct' | 'group' | 'trade'
 */
function getModel(context, prisma) {
    switch (context) {
        case 'direct': return prisma.directMessage;
        case 'group':  return prisma.groupMessage;
        case 'trade':  return prisma.message;
        default:       throw new Error(`Invalid message context: ${context}`);
    }
}

/**
 * Authorization: verify the user is a participant in the conversation.
 */
async function authorizeDirect(prisma, messageId, userId) {
    const msg = await prisma.directMessage.findUnique({ where: { id: messageId } });
    if (!msg) return null;
    if (msg.senderId !== userId && msg.receiverId !== userId) return null;
    return msg;
}

async function authorizeGroup(prisma, messageId, userId) {
    const msg = await prisma.groupMessage.findUnique({ where: { id: messageId } });
    if (!msg) return null;
    const member = await prisma.groupMember.findFirst({
        where: { groupId: msg.groupId, userId },
    });
    if (!member) return null;
    return msg;
}

async function authorizeTrade(prisma, messageId, userId) {
    const msg = await prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return null;
    // Check via trade participation
    if (msg.tradeId) {
        const trade = await prisma.trade.findUnique({ where: { id: msg.tradeId } });
        if (!trade) return null;
        if (trade.userId !== userId && trade.vendorId !== userId) return null;
    }
    return msg;
}

// ── SEARCH ───────────────────────────────────────────────────────────────

/**
 * POST /api/messages/search
 * Body: { query, context, conversationId }
 *   - query: search string
 *   - context: 'direct' | 'group' | 'trade' | 'all'
 *   - conversationId: optional (friendshipId / groupId / conversationId)
 *
 * Returns matching messages with sender info.
 */
exports.searchMessages = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { query, context = 'all', conversationId } = req.body;
        const userId = req.user.id;

        if (!query || query.trim().length < 1) {
            return res.json({ success: true, data: [] });
        }

        const searchQuery = query.trim();
        const results = [];

        // Helper to format results
        const formatMsg = (msg, ctx, senderName, senderAvatar) => ({
            id: msg.id,
            context: ctx,
            content: msg.deletedAt ? null : (msg.editedContent || msg.content),
            messageType: msg.messageType || msg.type,
            createdAt: msg.createdAt,
            senderId: msg.senderId,
            senderName,
            senderAvatar,
            conversationId: msg.friendshipId || msg.groupId || msg.conversationId,
            isStarred: msg.isStarred,
            isPinned: msg.isPinned,
            mediaUrl: msg.mediaUrl,
            deletedAt: msg.deletedAt,
        });

        // Search DirectMessages (where user is sender or receiver)
        if (context === 'all' || context === 'direct') {
            const where = {
                AND: [
                    { OR: [{ senderId: userId }, { receiverId: userId }] },
                    { content: { contains: searchQuery, mode: 'insensitive' } },
                    { deletedAt: null },
                ],
            };
            if (conversationId && context === 'direct') {
                where.AND.push({ friendshipId: conversationId });
            }

            const dmResults = await prisma.directMessage.findMany({
                where,
                include: {
                    sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
                },
                orderBy: { createdAt: 'desc' },
                take: 50,
            });

            for (const msg of dmResults) {
                results.push(formatMsg(msg, 'direct',
                    msg.sender?.displayName || msg.sender?.username || 'Unknown',
                    msg.sender?.profilePictureUrl));
            }
        }

        // Search GroupMessages (where user is a member)
        if (context === 'all' || context === 'group') {
            const groupIds = [];
            if (conversationId && context === 'group') {
                groupIds.push(conversationId);
            } else {
                const memberships = await prisma.groupMember.findMany({
                    where: { userId },
                    select: { groupId: true },
                });
                groupIds.push(...memberships.map(m => m.groupId));
            }

            if (groupIds.length > 0) {
                const gmResults = await prisma.groupMessage.findMany({
                    where: {
                        AND: [
                            { groupId: { in: groupIds } },
                            { OR: [
                                { content: { contains: searchQuery, mode: 'insensitive' } },
                            ]},
                            { deletedAt: null },
                        ],
                    },
                    include: {
                        sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
                    },
                    orderBy: { createdAt: 'desc' },
                    take: 50,
                });

                for (const msg of gmResults) {
                    results.push(formatMsg(msg, 'group',
                        msg.sender?.displayName || msg.sender?.username || 'Unknown',
                        msg.sender?.profilePictureUrl));
                }
            }
        }

        // Sort all results by date desc
        results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        // Limit total results
        return res.json({ success: true, data: results.slice(0, 100) });
    } catch (err) {
        console.error('[messageActionController.searchMessages]', err);
        return res.status(500).json({ success: false, message: 'Search failed' });
    }
};

// ── PIN / UNPIN ──────────────────────────────────────────────────────────

/**
 * PATCH /api/messages/:context/:id/pin
 * Toggles pin status on a message.
 */
exports.togglePin = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { context, id } = req.params;
        const userId = req.user.id;

        let msg;
        if (context === 'direct') {
            msg = await authorizeDirect(prisma, id, userId);
        } else if (context === 'group') {
            msg = await authorizeGroup(prisma, id, userId);
        } else if (context === 'trade') {
            msg = await authorizeTrade(prisma, id, userId);
        } else {
            return res.status(400).json({ success: false, message: 'Invalid context' });
        }

        if (!msg) {
            return res.status(404).json({ success: false, message: 'Message not found or unauthorized' });
        }

        const model = getModel(context, prisma);
        const newPinState = !msg.isPinned;

        const updated = await model.update({
            where: { id },
            data: {
                isPinned: newPinState,
                pinnedAt: newPinState ? new Date() : null,
            },
        });

        return res.json({
            success: true,
            data: { id: updated.id, isPinned: updated.isPinned, pinnedAt: updated.pinnedAt },
        });
    } catch (err) {
        console.error('[messageActionController.togglePin]', err);
        return res.status(500).json({ success: false, message: 'Failed to toggle pin' });
    }
};

// ── STAR / UNSTAR ─────────────────────────────────────────────────────────

/**
 * PATCH /api/messages/:context/:id/star
 * Toggles star status on a message.
 */
exports.toggleStar = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { context, id } = req.params;
        const userId = req.user.id;

        let msg;
        if (context === 'direct') {
            msg = await authorizeDirect(prisma, id, userId);
        } else if (context === 'group') {
            msg = await authorizeGroup(prisma, id, userId);
        } else if (context === 'trade') {
            msg = await authorizeTrade(prisma, id, userId);
        } else {
            return res.status(400).json({ success: false, message: 'Invalid context' });
        }

        if (!msg) {
            return res.status(404).json({ success: false, message: 'Message not found or unauthorized' });
        }

        const model = getModel(context, prisma);
        const newStarState = !msg.isStarred;

        const updated = await model.update({
            where: { id },
            data: { isStarred: newStarState },
        });

        return res.json({
            success: true,
            data: { id: updated.id, isStarred: updated.isStarred },
        });
    } catch (err) {
        console.error('[messageActionController.toggleStar]', err);
        return res.status(500).json({ success: false, message: 'Failed to toggle star' });
    }
};

// ── GET STARRED MESSAGES ─────────────────────────────────────────────────

/**
 * GET /api/messages/starred
 * Returns all starred messages for the authenticated user across all conversations.
 */
exports.getStarredMessages = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const userId = req.user.id;
        const results = [];

        // Starred DirectMessages
        const dmStarred = await prisma.directMessage.findMany({
            where: {
                AND: [
                    { isStarred: true },
                    { OR: [{ senderId: userId }, { receiverId: userId }] },
                    { deletedAt: null },
                ],
            },
            include: {
                sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });

        for (const msg of dmStarred) {
            results.push({
                id: msg.id,
                context: 'direct',
                content: msg.editedContent || msg.content,
                messageType: msg.messageType,
                createdAt: msg.createdAt,
                senderId: msg.senderId,
                senderName: msg.sender?.displayName || msg.sender?.username || 'Unknown',
                senderAvatar: msg.sender?.profilePictureUrl,
                conversationId: msg.friendshipId,
                mediaUrl: msg.mediaUrl,
            });
        }

        // Starred GroupMessages
        const memberships = await prisma.groupMember.findMany({
            where: { userId },
            select: { groupId: true },
        });
        const groupIds = memberships.map(m => m.groupId);

        if (groupIds.length > 0) {
            const gmStarred = await prisma.groupMessage.findMany({
                where: {
                    AND: [
                        { isStarred: true },
                        { groupId: { in: groupIds } },
                        { deletedAt: null },
                    ],
                },
                include: {
                    sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
                    group: { select: { id: true, name: true } },
                },
                orderBy: { createdAt: 'desc' },
                take: 100,
            });

            for (const msg of gmStarred) {
                results.push({
                    id: msg.id,
                    context: 'group',
                    content: msg.editedContent || msg.content,
                    messageType: msg.type,
                    createdAt: msg.createdAt,
                    senderId: msg.senderId,
                    senderName: msg.sender?.displayName || msg.sender?.username || 'Unknown',
                    senderAvatar: msg.sender?.profilePictureUrl,
                    conversationId: msg.groupId,
                    groupName: msg.group?.name,
                    mediaUrl: msg.mediaUrl,
                });
            }
        }

        // Sort by date desc
        results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        return res.json({ success: true, data: results });
    } catch (err) {
        console.error('[messageActionController.getStarredMessages]', err);
        return res.status(500).json({ success: false, message: 'Failed to get starred messages' });
    }
};

// ── FORWARD MESSAGE ───────────────────────────────────────────────────────

/**
 * POST /api/messages/forward
 * Body: { messageId, fromContext, toContext, toConversationId }
 *
 * Forwards a message to another conversation.
 * Works across: direct, group, trade.
 */
exports.forwardMessage = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { messageId, fromContext, toContext, toConversationId } = req.body;
        const userId = req.user.id;

        if (!messageId || !fromContext || !toContext || !toConversationId) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // 1. Fetch the source message (with authorization)
        let sourceMsg;
        if (fromContext === 'direct') {
            sourceMsg = await authorizeDirect(prisma, messageId, userId);
        } else if (fromContext === 'group') {
            sourceMsg = await authorizeGroup(prisma, messageId, userId);
        } else if (fromContext === 'trade') {
            sourceMsg = await authorizeTrade(prisma, messageId, userId);
        } else {
            return res.status(400).json({ success: false, message: 'Invalid source context' });
        }

        if (!sourceMsg) {
            return res.status(404).json({ success: false, message: 'Source message not found or unauthorized' });
        }

        if (sourceMsg.deletedAt) {
            return res.status(400).json({ success: false, message: 'Cannot forward a deleted message' });
        }

        // 2. Authorize destination + create forwarded message
        const content = sourceMsg.editedContent || sourceMsg.content || '';
        const mediaUrl = sourceMsg.mediaUrl;
        const mediaType = sourceMsg.mediaType;
        const mediaMimeType = sourceMsg.mediaMimeType;
        const mediaSize = sourceMsg.mediaSize;
        const linkPreview = sourceMsg.linkPreview;

        let forwardedMessage;
        const senderName = req.user.displayName || req.user.username || 'Unknown';

        if (toContext === 'direct') {
            // Verify the user is part of this friendship
            const friendship = await prisma.friendship.findFirst({
                where: {
                    id: toConversationId,
                    OR: [{ requesterId: userId }, { addresseeId: userId }],
                    status: 'ACCEPTED',
                },
            });
            if (!friendship) {
                return res.status(403).json({ success: false, message: 'Not a participant in target conversation' });
            }

            const receiverId = friendship.requesterId === userId
                ? friendship.addresseeId
                : friendship.requesterId;

            forwardedMessage = await prisma.directMessage.create({
                data: {
                    friendshipId: toConversationId,
                    senderId: userId,
                    receiverId,
                    content,
                    messageType: sourceMsg.messageType || 'TEXT',
                    mediaUrl,
                    mediaType,
                    mediaMimeType,
                    mediaSize,
                    linkPreview,
                    forwardedFromId: messageId,
                    forwardedFromUser: senderName,
                    status: 'sent',
                },
            });

            // Emit via socket
            const io = req.app.get('io');
            if (io) {
                io.to(`user:${receiverId}`).emit('dm:new', forwardedMessage);
                io.to(`friendship:${toConversationId}`).emit('dm:new', forwardedMessage);
            }
        } else if (toContext === 'group') {
            // Verify membership
            const membership = await prisma.groupMember.findFirst({
                where: { groupId: toConversationId, userId },
            });
            if (!membership) {
                return res.status(403).json({ success: false, message: 'Not a member of target group' });
            }

            forwardedMessage = await prisma.groupMessage.create({
                data: {
                    groupId: toConversationId,
                    senderId: userId,
                    type: sourceMsg.type || sourceMsg.messageType || 'TEXT',
                    content,
                    mediaUrl,
                    mediaType,
                    mediaMimeType,
                    mediaSize,
                    linkPreview,
                    metadata: { forwarded: true, forwardedFromId: messageId, forwardedFromUser: senderName },
                    status: 'sent',
                },
            });

            const io = req.app.get('io');
            if (io) {
                io.to(`group:${toConversationId}`).emit('group:message', forwardedMessage);
            }
        } else if (toContext === 'trade') {
            // Verify trade participation
            const conversation = await prisma.conversation.findUnique({
                where: { id: toConversationId },
                include: { trade: true },
            });
            if (!conversation) {
                return res.status(404).json({ success: false, message: 'Target conversation not found' });
            }

            if (conversation.trade) {
                if (conversation.trade.userId !== userId && conversation.trade.vendorId !== userId) {
                    return res.status(403).json({ success: false, message: 'Not a participant in target trade' });
                }
            }

            forwardedMessage = await prisma.message.create({
                data: {
                    conversationId: toConversationId,
                    senderId: userId,
                    tradeId: conversation.tradeId || null,
                    content,
                    messageType: sourceMsg.messageType || sourceMsg.type || 'TEXT',
                    mediaUrl,
                    mediaType,
                    mediaMimeType,
                    mediaSize,
                    linkPreview,
                    status: 'sent',
                },
            });

            const io = req.app.get('io');
            if (io) {
                io.to(`conversation:${toConversationId}`).emit('message:new', forwardedMessage);
            }
        } else {
            return res.status(400).json({ success: false, message: 'Invalid destination context' });
        }

        return res.json({ success: true, data: forwardedMessage });
    } catch (err) {
        console.error('[messageActionController.forwardMessage]', err);
        return res.status(500).json({ success: false, message: 'Failed to forward message' });
    }
};
