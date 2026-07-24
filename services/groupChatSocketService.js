// services/groupChatSocketService.js
// AZAMAN PREMIUM GROUP CHAT SOCKET SERVICE

const logger = require('../src/config/logger');
const crypto = require('crypto');

class GroupChatSocketService {
  constructor(io, prisma) {
    this.io = io;
    this.prisma = prisma;
  }

  registerHandlers(socket) {

    // ── JOIN GROUP ──────────────────────────────────────────────────────
    socket.on('join_group', async (data) => {
      try {
        const { groupId, userId } = data;
        if (!groupId || !userId) return;
        const member = await this.prisma.groupMember.findFirst({
          where: { groupId, userId: parseInt(userId), removedAt: null }
        });
        if (!member) return socket.emit('group_error', { reason: 'not_member' });
        socket.join(`group_${groupId}`);
        socket.join(`user_${userId}`);
        socket.emit('group_joined', { groupId });
        // Notify others that this member is online
        socket.to(`group_${groupId}`).emit('group_member_online', {
          groupId, userId: parseInt(userId)
        });
      } catch (e) { socket.emit('group_error', { reason: 'server_error' }); }
    });

    // ── LEAVE GROUP ─────────────────────────────────────────────────────
    socket.on('leave_group', (data) => {
      const { groupId, userId } = data || {};
      if (!groupId) return;
      socket.leave(`group_${groupId}`);
      socket.to(`group_${groupId}`).emit('group_member_offline', {
        groupId, userId: parseInt(userId)
      });
    });

    // ── SEND GROUP MESSAGE ───────────────────────────────────────────────
    socket.on('send_group_message', async (data) => {
      try {
        const { groupId, senderId, content, type, localId,
                replyToId, replyToText, replyToSenderName,
                mediaUrl, mediaType, mediaMimeType, mediaSize,
                mediaDuration, mediaWaveformPeaks, linkPreview,
                metadata } = data;
        if (!groupId || !senderId || (!content && !mediaUrl && !metadata)) return;

        const member = await this.prisma.groupMember.findFirst({
          where: { groupId, userId: parseInt(senderId), removedAt: null }
        });
        if (!member) return socket.emit('group_error', { reason: 'not_member' });

        const message = await this.prisma.groupMessage.create({
          data: {
            groupId, senderId: parseInt(senderId),
            type: type || 'TEXT',
            content: content || '',
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

        // Optimistic ACK to sender
        socket.emit('message_ack', {
          localId, id: message.id, status: 'sent', createdAt: message.createdAt
        });

        const payload = {
          id: message.id, localId: message.localId,
          groupId, senderId: parseInt(senderId),
          senderUsername: message.sender?.username,
          senderAvatar: message.sender?.profilePictureUrl,
          type: message.type, content: message.content,
          createdAt: message.createdAt, status: 'sent',
          replyToId, replyToText, replyToSenderName,
          mediaUrl, mediaType, mediaMimeType, mediaSize,
          mediaDuration, mediaWaveformPeaks, linkPreview, metadata,
        };

        this.io.to(`group_${groupId}`).emit('new_group_message', payload);

        // Update GroupChat.updatedAt for hub sorting
        await this.prisma.groupChat.update({
          where: { id: groupId }, data: { updatedAt: new Date() }
        });

        // FCM for offline members
        const members = await this.prisma.groupMember.findMany({
          where: { groupId, removedAt: null, userId: { not: parseInt(senderId) } },
          include: { user: { select: { id: true, fcmToken: true } } }
        });
        const { sendPushNotification } = require('../utils/firebaseService');
        for (const m of members) {
          const onlineSockets = await this.io.in(`user_${m.userId}`).allSockets();
          if (onlineSockets.size === 0 && m.user.fcmToken) {
            await sendPushNotification(
              m.user.fcmToken,
              `Group message`,
              (content || '📎 Media').substring(0, 100),
              { type: 'GROUP_CHAT', groupId, route: `/group/${groupId}` }
            ).catch(() => {});
          }
        }
      } catch (e) {
        logger.error("SOCKET ERROR:", e); socket.emit('message_error', { reason: 'server_error', localId: data.localId });
      }
    });

    // ── GROUP TYPING ────────────────────────────────────────────────────
    socket.on('group_typing', (data) => {
      const { groupId, userId, isTyping } = data;
      if (!groupId || !userId) return;
      socket.to(`group_${groupId}`).emit(
        isTyping ? 'group_typing_started' : 'group_typing_stopped',
        { groupId, userId: parseInt(userId) }
      );
    });

    // ── GROUP READ CURSOR ───────────────────────────────────────────────
    socket.on('group_mark_read', async (data) => {
      try {
        const { groupId, userId, lastMessageId } = data;
        if (!groupId || !userId) return;
        await this.prisma.groupReadCursor.upsert({
          where: { groupId_userId: { groupId, userId: parseInt(userId) } },
          create: {
            groupId, userId: parseInt(userId),
            lastReadMsgId: lastMessageId, lastReadAt: new Date()
          },
          update: { lastReadMsgId: lastMessageId, lastReadAt: new Date() }
        });
        this.io.to(`group_${groupId}`).emit('group_read_cursor_updated', {
          groupId, userId: parseInt(userId),
          lastMessageId, readAt: new Date()
        });
      } catch (e) {}
    });

    // ── SUSU EVENT CARD ─────────────────────────────────────────────────
    // Emitted by the susu service when a cycle completes, contribution
    // is confirmed, or a payout is sent. Displays a special card bubble.
    socket.on('susu_event_card', async (data) => {
      try {
        const { groupId, type, metadata, senderId } = data;
        if (!groupId || !type) return;
        // type: SUSU_CONTRIBUTION | SUSU_PAYOUT | SUSU_CYCLE_COMPLETE
        const msg = await this.prisma.groupMessage.create({
          data: {
            groupId, senderId: senderId ? parseInt(senderId) : null,
            type: 'SUSU_EVENT', content: '',
            metadata, localId: crypto.randomUUID(), status: 'sent'
          }
        });
        this.io.to(`group_${groupId}`).emit('new_group_message', {
          id: msg.id, groupId, type: 'SUSU_EVENT',
          metadata, createdAt: msg.createdAt
        });
      } catch (e) {}
    });
  }
}

module.exports = GroupChatSocketService;
