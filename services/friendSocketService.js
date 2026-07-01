// services/friendSocketService.js
// =============================================================================
// AZAMAN V3 — FRIEND SOCKET SERVICE
//
// Handles real-time socket events for the social friend system:
//   - join_friend_chat: Join a friendship-specific chat room
//   - send_friend_message: Real-time message in friend chat
//   - typing_friend: Typing indicators for friend chat
//   - friend_online_status: Track online presence for friends
//
// Room naming contract:
//   Friend chat room: friend_chat_${friendshipId}
//   User inbox:       user_${userId} (shared with existing system)
// =============================================================================

const { sendPushNotification } = require('../utils/firebaseService');
const crypto = require('crypto');

class FriendSocketService {
    constructor(io, prisma) {
        this.io = io;
        this.prisma = prisma;
    }

    registerHandlers(socket) {


        // ── 1. JOIN FRIEND CHAT ROOM ────────────────────────────────────────
        socket.on('join_friend_chat', async (data) => {
            try {
                const { friendshipId, userId } = data;
                if (!friendshipId || !userId) return;

                // Verify user is part of this friendship
                const friendship = await this.prisma.friendship.findUnique({
                    where: { id: friendshipId },
                    select: { requesterId: true, addresseeId: true, status: true }
                });

                if (!friendship) {
                    socket.emit('friend_chat_error', { reason: 'friendship_not_found' });
                    return;
                }

                const parsedUserId = parseInt(userId);
                if (friendship.requesterId !== parsedUserId && friendship.addresseeId !== parsedUserId) {
                    socket.emit('friend_chat_error', { reason: 'not_participant' });
                    return;
                }

                if (friendship.status !== 'ACCEPTED') {
                    socket.emit('friend_chat_error', { reason: 'not_accepted' });
                    return;
                }

                const room = `friend_chat_${friendshipId}`;
                socket.join(room);
                socket.join(`user_${userId}`);

                console.log(`👥 ${socket.id} → friend chat room ${room}`);

                socket.emit('friend_chat_joined', {
                    friendshipId,
                    room
                });

                // Notify the other person that this user is now in the chat
                const otherUserId = friendship.requesterId === parsedUserId
                    ? friendship.addresseeId
                    : friendship.requesterId;

                socket.to(room).emit('friend_online_in_chat', {
                    userId: parsedUserId,
                    friendshipId
                });

            } catch (err) {
                console.error('join_friend_chat error:', err.message);
                socket.emit('friend_chat_error', { reason: 'server_error' });
            }
        });


        // ── 2. LEAVE FRIEND CHAT ROOM ───────────────────────────────────────
        socket.on('leave_friend_chat', (data) => {
            const { friendshipId, userId } = data || {};
            if (!friendshipId) return;

            const room = `friend_chat_${friendshipId}`;
            socket.leave(room);
            console.log(`👥 ${socket.id} left friend chat room ${room}`);

            // Notify other party
            socket.to(room).emit('friend_offline_in_chat', {
                userId: parseInt(userId),
                friendshipId
            });
        });

        // ── 3. SEND FRIEND MESSAGE (Socket path) ───────────────────────────
        // The authoritative path is POST /api/friends/chat/:friendshipId/messages.
        // This socket handler provides real-time delivery for clients that want
        // immediate optimistic updates.
        socket.on('send_friend_message', async (data) => {
            try {
                const { friendshipId, senderId, content, messageType, metadata, tempId } = data;
                if (!friendshipId || !senderId || !content) return;

                const parsedSenderId = parseInt(senderId);

                // Verify friendship
                const friendship = await this.prisma.friendship.findUnique({
                    where: { id: friendshipId },
                    select: { requesterId: true, addresseeId: true, status: true }
                });

                if (!friendship || friendship.status !== 'ACCEPTED') {
                    socket.emit('friend_chat_error', { reason: 'invalid_friendship' });
                    return;
                }

                if (friendship.requesterId !== parsedSenderId && friendship.addresseeId !== parsedSenderId) {
                    socket.emit('friend_chat_error', { reason: 'not_participant' });
                    return;
                }

                const receiverId = friendship.requesterId === parsedSenderId
                    ? friendship.addresseeId
                    : friendship.requesterId;


                // Persist message
                const message = await this.prisma.directMessage.create({
                    data: {
                        friendshipId,
                        senderId: parsedSenderId,
                        receiverId,
                        content: content.trim(),
                        messageType: messageType || 'TEXT',
                        metadata: metadata || null
                    },
                    include: {
                        sender: { select: { id: true, username: true, profilePictureUrl: true } }
                    }
                });

                // Update friendship timestamp
                await this.prisma.friendship.update({
                    where: { id: friendshipId },
                    data: { updatedAt: new Date() }
                });

                const payload = {
                    id: message.id,
                    friendshipId,
                    sender: message.sender,
                    senderId: message.senderId,
                    receiverId: message.receiverId,
                    content: message.content,
                    messageType: message.messageType,
                    metadata: message.metadata,
                    isRead: false,
                    createdAt: message.createdAt,
                    tempId: tempId || null
                };

                // Broadcast to friend chat room
                const room = `friend_chat_${friendshipId}`;
                this.io.to(room).emit('friend_message', payload);

                // Also emit to user room (for notification badge updates)
                this.io.to(`user_${receiverId}`).emit('friend_message', payload);

                // Sender acknowledgment
                socket.emit('friend_message_saved', {
                    id: message.id,
                    tempId: tempId || null,
                    friendshipId,
                    createdAt: message.createdAt
                });


                // FCM push if offline
                try {
                    const receiverSockets = await this.io.in(`user_${receiverId}`).allSockets();
                    if (receiverSockets.size === 0) {
                        const receiver = await this.prisma.user.findUnique({
                            where: { id: receiverId },
                            select: { fcmToken: true }
                        });
                        if (receiver?.fcmToken) {
                            await sendPushNotification(
                                receiver.fcmToken,
                                `Message from ${message.sender.username}`,
                                content.substring(0, 100),
                                {
                                    type: 'FRIEND_CHAT',
                                    friendshipId,
                                    senderId: String(parsedSenderId),
                                    route: `/friends/chat/${friendshipId}`
                                }
                            );
                        }
                    }
                } catch (pushErr) {
                    console.error('[FriendSocket] FCM push error:', pushErr.message);
                }

            } catch (err) {
                console.error('send_friend_message error:', err.message);
                socket.emit('friend_message_error', {
                    reason: 'server_error',
                    detail: err.message,
                    tempId: data.tempId || null
                });
            }
        });

        // ── 3.5 SEND FRIEND MESSAGE V2 (Premium) ───────────────────────────
        socket.on('send_friend_message_v2', async (data) => {
            try {
                const {
                    friendshipId, senderId, content, type, localId,
                    replyToId, replyToText, replyToSenderName,
                    mediaUrl, mediaType, mediaMimeType, mediaSize,
                    mediaDuration, mediaWaveformPeaks, linkPreview,
                    metadata
                } = data;
                if (!friendshipId || !senderId || (!content && !mediaUrl && !metadata)) return;

                const friendship = await this.prisma.friendship.findUnique({
                    where: { id: friendshipId },
                    include: { requester: true, addressee: true }
                });
                if (!friendship) return socket.emit('friend_error', { reason: 'not_found' });
                if (friendship.status !== 'ACCEPTED') {
                    return socket.emit('friend_error', { reason: 'not_friends' });
                }

                const receiverId = friendship.requesterId === parseInt(senderId)
                    ? friendship.addresseeId : friendship.requesterId;

                const message = await this.prisma.directMessage.create({
                    data: {
                        friendshipId,
                        senderId: parseInt(senderId),
                        receiverId,
                        content: content || '',
                        messageType: type || 'TEXT',
                        localId: localId || crypto.randomUUID(),
                        status: 'sent',
                        replyToId: replyToId || null,
                        replyToText: replyToText || null,
                        replyToSenderName: replyToSenderName || null,
                        mediaUrl: mediaUrl || null, mediaType: mediaType || null,
                        mediaMimeType: mediaMimeType || null, mediaSize: mediaSize || null,
                        mediaDuration: mediaDuration || null,
                        mediaWaveformPeaks: mediaWaveformPeaks || null,
                        linkPreview: linkPreview ? linkPreview : null,
                        metadata: metadata || null,
                    },
                    include: { sender: { select: { id: true, username: true, profilePictureUrl: true } } }
                });

                socket.emit('message_ack', {
                    localId, id: message.id, status: 'sent', createdAt: message.createdAt
                });

                const payload = {
                    id: message.id, localId: message.localId,
                    friendshipId, senderId: parseInt(senderId),
                    senderUsername: message.sender?.username,
                    senderAvatar: message.sender?.profilePictureUrl,
                    messageType: message.messageType, content: message.content,
                    createdAt: message.createdAt, status: 'sent',
                    replyToId, replyToText, replyToSenderName,
                    mediaUrl, mediaType, mediaMimeType, mediaSize,
                    mediaDuration, mediaWaveformPeaks, linkPreview, metadata,
                };

                this.io.to(`friend_chat_${friendshipId}`).emit('new_friend_message', payload);

                // Update Friendship.updatedAt for cursor pagination sorting
                await this.prisma.friendship.update({
                    where: { id: friendshipId }, data: { updatedAt: new Date() }
                });

                const recipientSockets = await this.io.in(`user_${receiverId}`).allSockets();
                if (recipientSockets.size > 0) {
                    this.io.to(`user_${senderId}`).emit('message_delivered', {
                        id: message.id, context: 'friend', status: 'delivered',
                    });
                } else {
                    const receiver = friendship.requesterId === receiverId
                        ? friendship.requester : friendship.addressee;
                    if (receiver?.fcmToken) {
                        const { sendPushNotification } = require('../utils/firebaseService');
                        await sendPushNotification(
                            receiver.fcmToken,
                            `New message from ${message.sender?.username}`,
                            (content || '📎 Media').substring(0, 100),
                            { type: 'FRIEND_CHAT', friendshipId, route: `/friends/${friendshipId}` }
                        ).catch(() => {});
                    }
                }
            } catch (e) {
                socket.emit('message_error', { reason: 'server_error', localId: data.localId });
            }
        });

        // ── 4. TYPING INDICATORS ────────────────────────────────────────────
        socket.on('typing_friend', (data) => {
            const { friendshipId, userId, isTyping } = data || {};
            if (!friendshipId || !userId) return;

            const room = `friend_chat_${friendshipId}`;
            socket.to(room).emit('friend_typing', {
                userId: parseInt(userId),
                friendshipId,
                isTyping: !!isTyping
            });
        });

        // ── 5. MARK MESSAGES READ (socket path) ─────────────────────────────
        socket.on('mark_friend_messages_read', async (data) => {
            try {
                const { friendshipId, userId } = data || {};
                if (!friendshipId || !userId) return;

                const parsedUserId = parseInt(userId);

                const updated = await this.prisma.directMessage.updateMany({
                    where: {
                        friendshipId,
                        receiverId: parsedUserId,
                        isRead: false
                    },
                    data: { isRead: true }
                });

                if (updated.count > 0) {
                    // Determine the other party
                    const friendship = await this.prisma.friendship.findUnique({
                        where: { id: friendshipId },
                        select: { requesterId: true, addresseeId: true }
                    });

                    if (friendship) {
                        const otherUserId = friendship.requesterId === parsedUserId
                            ? friendship.addresseeId
                            : friendship.requesterId;

                        this.io.to(`user_${otherUserId}`).emit('friend_messages_read', {
                            friendshipId,
                            readBy: parsedUserId,
                            count: updated.count
                        });
                    }
                }
            } catch (err) {
                console.error('mark_friend_messages_read error:', err.message);
            }
        });
    }
}

module.exports = FriendSocketService;
