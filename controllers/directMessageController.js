// controllers/directMessageController.js
// =============================================================================
// AZAMAN V3 — DIRECT MESSAGING CONTROLLER
//
// Handles sending/receiving messages between friends. Messages are stored in
// the DirectMessage model (separate from the trade chat Conversation/Message
// system). Real-time delivery via Socket.IO + FCM for offline users.
// =============================================================================

const { sendPushNotification } = require('../utils/firebaseService');

// Phase UI-3 helper: render a one-line preview body for FCM pushes when the
// message is a media artifact (no text content).
const _previewBodyForMedia = (type) => {
    switch (type) {
        case 'IMAGE': return '📷 Photo';
        case 'VIDEO': return '🎥 Video';
        case 'AUDIO': return '🎙️ Voice message';
        case 'DOCUMENT': return '📄 Document';
        case 'LINK': return '🔗 Shared a link';
        case 'TICKET_LINK': return '🎟️ Created a ticket';
        default: return 'New message';
    }
};

// =============================================================================
// 1. GET MESSAGES — Paginated message history for a friendship
//
// GET /api/friends/chat/:friendshipId/messages?page=1&limit=50
// =============================================================================
exports.getMessages = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { friendshipId } = req.params;
        const userId = req.user.id;
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 50;
        const skip = (page - 1) * limit;

        // Verify the user is part of this friendship
        const friendship = await prisma.friendship.findUnique({
            where: { id: friendshipId },
            select: { requesterId: true, addresseeId: true, status: true }
        });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Conversation not found.' });
        }

        if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this conversation.' });
        }

        if (friendship.status !== 'ACCEPTED') {
            return res.status(403).json({ success: false, message: 'You can only chat with accepted friends.' });
        }

        const [messages, total] = await Promise.all([
            prisma.directMessage.findMany({
                where: { friendshipId },
                include: {
                    sender: {
                        select: { id: true, username: true, profilePictureUrl: true }
                    }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.directMessage.count({ where: { friendshipId } })
        ]);

        // Reverse so messages are in chronological order for the client
        const chronological = messages.reverse();

        return res.status(200).json({
            success: true,
            messages: chronological,
            total,
            page,
            limit,
            hasMore: skip + limit < total
        });

    } catch (error) {
        console.error('[getMessages] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch messages.' });
    }
};

// =============================================================================
// 2. SEND MESSAGE — Send a text or rich-media message to a friend
//
// POST /api/friends/chat/:friendshipId/messages
// Body: {
//   content,                      // optional for media-only messages
//   messageType?,                 // TEXT | IMAGE | VIDEO | DOCUMENT | AUDIO | LINK | STICKER | TICKET_LINK | TRANSFER_*
//   metadata?,                    // transfer details, ticket id, etc.
//   // Phase UI-3 (2026-05-26) media fields — required when messageType is media-typed
//   mediaUrl?, mediaType?, mediaMimeType?, mediaSize?,
//   mediaDuration?, mediaWaveformPeaks?, linkPreview?
//   // B-4 (2026-06-28) reply-to + sticker fields
//   replyToId?, replyToText?, replyToSenderName?
//   stickerAssetPath?, stickerIsAnimated?
// }
// =============================================================================
exports.sendMessage = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    const linkPreviewService = req.app.get('linkPreviewService');

    try {
        const { friendshipId } = req.params;
        const userId = req.user.id;
        const {
            content,
            messageType,
            metadata,
            mediaUrl,
            mediaType,
            mediaMimeType,
            mediaSize,
            mediaDuration,
            mediaWaveformPeaks,
            linkPreview,
            // B-4 reply-to + sticker
            replyToId,
            replyToText,
            replyToSenderName,
            stickerAssetPath,
            stickerIsAnimated
        } = req.body;

        const finalType = (messageType || 'TEXT').toString().toUpperCase();
        const isMedia = ['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO', 'LINK'].includes(finalType);
        const isSticker = finalType === 'STICKER';
        const isTicketLink = finalType === 'TICKET_LINK';

        // Validation: text messages need content; media messages need a mediaUrl;
        // sticker needs stickerAssetPath; ticket links need metadata.ticketId.
        if (!isMedia && !isSticker && !isTicketLink && (!content || content.trim().length === 0)) {
            return res.status(400).json({ success: false, message: 'Message content is required.' });
        }
        if (isMedia && !mediaUrl) {
            return res.status(400).json({ success: false, message: 'mediaUrl required for media messages.' });
        }
        if (isSticker && !stickerAssetPath) {
            return res.status(400).json({ success: false, message: 'stickerAssetPath required for sticker messages.' });
        }
        if (isTicketLink && (!metadata || !metadata.ticketId)) {
            return res.status(400).json({ success: false, message: 'metadata.ticketId required for ticket-link messages.' });
        }

        // Verify friendship exists and user is a participant
        const friendship = await prisma.friendship.findUnique({
            where: { id: friendshipId },
            select: { requesterId: true, addresseeId: true, status: true }
        });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Conversation not found.' });
        }

        if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        if (friendship.status !== 'ACCEPTED') {
            return res.status(403).json({ success: false, message: 'You can only chat with accepted friends.' });
        }

        const receiverId = friendship.requesterId === userId
            ? friendship.addresseeId
            : friendship.requesterId;

        // For LINK type, opportunistically fetch the OG metadata server-side
        // if the client didn't supply it. Best-effort — failure leaves
        // linkPreview null and the bubble renders as a plain link.
        let resolvedLinkPreview = linkPreview || null;
        if (finalType === 'LINK' && !resolvedLinkPreview && content && linkPreviewService) {
            try {
                resolvedLinkPreview = await linkPreviewService.fetch(content.trim());
            } catch (_) { /* swallow — preview is non-fatal */ }
        }

        // Create the message
        const message = await prisma.directMessage.create({
            data: {
                friendshipId,
                senderId: userId,
                receiverId,
                content: (content || '').trim(),
                messageType: finalType,
                metadata: metadata || null,
                mediaUrl: mediaUrl || null,
                mediaType: mediaType || null,
                mediaMimeType: mediaMimeType || null,
                mediaSize: typeof mediaSize === 'number' ? mediaSize : null,
                mediaDuration: typeof mediaDuration === 'number' ? mediaDuration : null,
                mediaWaveformPeaks: Array.isArray(mediaWaveformPeaks) ? mediaWaveformPeaks : null,
                linkPreview: resolvedLinkPreview,
                // B-4 reply-to + sticker
                replyToId: replyToId || null,
                replyToText: replyToText || null,
                replyToSenderName: replyToSenderName || null,
                stickerAssetPath: stickerAssetPath || null,
                stickerIsAnimated: stickerIsAnimated === true ? true : null
            },
            include: {
                sender: { select: { id: true, username: true, profilePictureUrl: true } }
            }
        });

        // Update friendship's updatedAt to bubble this chat to top
        await prisma.friendship.update({
            where: { id: friendshipId },
            data: { updatedAt: new Date() }
        });

        // Real-time delivery via Socket.IO
        const payload = {
            id: message.id,
            friendshipId,
            sender: message.sender,
            senderId: message.senderId,
            receiverId: message.receiverId,
            content: message.content,
            messageType: message.messageType,
            metadata: message.metadata,
            mediaUrl: message.mediaUrl,
            mediaType: message.mediaType,
            mediaMimeType: message.mediaMimeType,
            mediaSize: message.mediaSize,
            mediaDuration: message.mediaDuration,
            mediaWaveformPeaks: message.mediaWaveformPeaks,
            linkPreview: message.linkPreview,
            // B-4 reply-to + sticker
            replyToId: message.replyToId,
            replyToText: message.replyToText,
            replyToSenderName: message.replyToSenderName,
            stickerAssetPath: message.stickerAssetPath,
            stickerIsAnimated: message.stickerIsAnimated,
            isRead: false,
            createdAt: message.createdAt
        };

        if (io) {
            // Emit to receiver's user room
            io.to(`user_${receiverId}`).emit('friend_message', payload);
            // Also emit to the friendship-specific room (for both parties if both are viewing)
            io.to(`friend_chat_${friendshipId}`).emit('friend_message', payload);
        }

        // FCM push if receiver is offline
        try {
            if (io) {
                const receiverSockets = await io.in(`user_${receiverId}`).allSockets();
                if (receiverSockets.size === 0) {
                    const receiver = await prisma.user.findUnique({
                        where: { id: receiverId },
                        select: { fcmToken: true }
                    });
                    if (receiver?.fcmToken) {
                        const previewBody = isMedia
                            ? _previewBodyForMedia(finalType)
                            : (content || '').substring(0, 100);
                        await sendPushNotification(
                            receiver.fcmToken,
                            `Message from ${message.sender.username}`,
                            previewBody,
                            {
                                type: 'FRIEND_CHAT',
                                friendshipId,
                                senderId: String(userId),
                                route: `/friends/chat/${friendshipId}`
                            }
                        );
                    }
                }
            }
        } catch (pushErr) {
            console.error('[sendMessage] FCM push error (non-fatal):', pushErr.message);
        }

        return res.status(201).json({
            success: true,
            message: payload
        });

    } catch (error) {
        console.error('[sendMessage] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// Internal helper used by sendMessage to render a preview line for FCM
// pushes when the message itself is a media artifact (no text body).
// Exported as a property so callers can override / extend if needed.
exports._previewBodyForMedia = _previewBodyForMedia;

// =============================================================================
// 3. MARK MESSAGES AS READ — Mark all unread messages in a conversation as read
//
// PUT /api/friends/chat/:friendshipId/read
// =============================================================================
exports.markAsRead = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const { friendshipId } = req.params;
        const userId = req.user.id;

        // Verify participation
        const friendship = await prisma.friendship.findUnique({
            where: { id: friendshipId },
            select: { requesterId: true, addresseeId: true }
        });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Conversation not found.' });
        }

        if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        // Mark all messages sent TO the current user as read
        const updated = await prisma.directMessage.updateMany({
            where: {
                friendshipId,
                receiverId: userId,
                isRead: false
            },
            data: { isRead: true }
        });

        // Notify the other party that messages were read (read receipts)
        const otherUserId = friendship.requesterId === userId
            ? friendship.addresseeId
            : friendship.requesterId;

        if (io && updated.count > 0) {
            io.to(`user_${otherUserId}`).emit('friend_messages_read', {
                friendshipId,
                readBy: userId,
                count: updated.count
            });
        }

        return res.status(200).json({
            success: true,
            message: `${updated.count} messages marked as read.`,
            count: updated.count
        });

    } catch (error) {
        console.error('[markAsRead] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 4. GET UNREAD COUNT — Total unread messages across all friend chats
//
// GET /api/friends/chat/unread-count
// =============================================================================
exports.getUnreadCount = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const count = await prisma.directMessage.count({
            where: {
                receiverId: userId,
                isRead: false
            }
        });

        return res.status(200).json({
            success: true,
            unreadCount: count
        });

    } catch (error) {
        console.error('[getUnreadCount] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get unread count.' });
    }
};

// =============================================================================
// 5. GET CONVERSATION INFO — Metadata about a specific friendship chat
//
// GET /api/friends/chat/:friendshipId/info
// =============================================================================
exports.getConversationInfo = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { friendshipId } = req.params;
        const userId = req.user.id;

        const friendship = await prisma.friendship.findUnique({
            where: { id: friendshipId },
            include: {
                requester: {
                    select: {
                        id: true,
                        username: true,
                        profilePictureUrl: true,
                        tradesCompleted: true,
                        completionRate: true,
                        kycStatus: true,
                        loyaltyTier: true
                    }
                },
                addressee: {
                    select: {
                        id: true,
                        username: true,
                        profilePictureUrl: true,
                        tradesCompleted: true,
                        completionRate: true,
                        kycStatus: true,
                        loyaltyTier: true
                    }
                }
            }
        });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Conversation not found.' });
        }

        if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        const friend = friendship.requesterId === userId
            ? friendship.addressee
            : friendship.requester;

        // Get pending transfer requests in this conversation
        const pendingTransfers = await prisma.peerTransfer.findMany({
            where: {
                friendshipId,
                status: 'PENDING'
            },
            orderBy: { createdAt: 'desc' }
        });

        return res.status(200).json({
            success: true,
            conversation: {
                friendshipId: friendship.id,
                status: friendship.status,
                friendSince: friendship.createdAt,
                friend: {
                    ...friend,
                    isVerified: friend.kycStatus === 'VERIFIED'
                },
                pendingTransfers
            }
        });

    } catch (error) {
        console.error('[getConversationInfo] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get conversation info.' });
    }
};

// =============================================================================
// 6. EDIT MESSAGE (Premium)
// PUT /api/friends/chat/messages/:id/edit
// =============================================================================
exports.editMessage = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;
        const { newContent } = req.body;
        const userId = req.user.id;

        const msg = await prisma.directMessage.findUnique({ where: { id } });
        if (!msg || msg.senderId !== userId) return res.status(403).json({ error: 'Unauthorized' });

        // 15 minute limit
        const age = Date.now() - new Date(msg.createdAt).getTime();
        if (age > 15 * 60 * 1000) return res.status(400).json({ error: 'Time limit exceeded' });

        const updated = await prisma.directMessage.update({
            where: { id },
            data: { content: newContent.trim(), editedAt: new Date(), editedContent: msg.content }
        });
        res.json({ success: true, message: updated });
    } catch (error) { res.status(500).json({ error: 'Server error' }); }
};

// =============================================================================
// 7. DELETE MESSAGE (Premium - Soft Delete)
// DELETE /api/friends/chat/messages/:id
// =============================================================================
exports.deleteMessage = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const msg = await prisma.directMessage.findUnique({ where: { id } });
        if (!msg || msg.senderId !== userId) return res.status(403).json({ error: 'Unauthorized' });

        const updated = await prisma.directMessage.update({
            where: { id },
            data: { deletedAt: new Date() }
        });
        res.json({ success: true, message: updated });
    } catch (error) { res.status(500).json({ error: 'Server error' }); }
};

// =============================================================================
// 8. REACT TO MESSAGE (Premium)
// POST /api/friends/chat/messages/:id/react
// =============================================================================
exports.reactToMessage = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;
        const { emoji } = req.body;
        const userId = req.user.id;

        const msg = await prisma.directMessage.findUnique({ where: { id } });
        if (!msg) return res.status(404).json({ error: 'Not found' });

        const reactions = msg.reactions || {};
        const list = reactions[emoji] || [];

        if (list.includes(userId)) {
            reactions[emoji] = list.filter(uid => uid !== userId);
            if (reactions[emoji].length === 0) delete reactions[emoji];
        } else {
            reactions[emoji] = [...list, userId];
        }

        const updated = await prisma.directMessage.update({
            where: { id }, data: { reactions }
        });
        res.json({ success: true, reactions: updated.reactions });
    } catch (error) { res.status(500).json({ error: 'Server error' }); }
};
