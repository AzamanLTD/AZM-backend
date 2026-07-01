// services/chatSocketService.js
// AZAMAN PREMIUM CHAT — Telegram-Inspired Socket Service
// Preserves all existing event names. Adds new premium events.

const crypto = require('crypto');

const ADMIN_SPY_ROOM = 'admin_spy_room';

class ChatSocketService {
  constructor(io, prisma) {
    this.io = io;
    this.prisma = prisma;
    // Track typing state per room to debounce broadcasts
    this._typingState = new Map(); // roomKey -> { userId, timer }
  }

  generatePersonalRoomHash(u1, u2) {
    return crypto.createHash('sha256')
      .update([String(u1), String(u2)].sort().join('_'))
      .digest('hex').slice(0, 32);
  }

  // ── OPTIMISTIC ACK: immediately tell sender their message was stored ──
  _ackMessage(socket, localId, serverId, roomHash, createdAt) {
    socket.emit('message_ack', {
      localId,         // client UUID — used to swap optimistic bubble
      id: serverId,    // server UUID — authoritative ID from here on
      roomHash,
      createdAt,
      status: 'sent',  // single tick
    });
  }

  // ── DELIVERY RECEIPT: emit to sender when recipient is online ──────────
  async _emitDelivery(senderId, messageId, context) {
    this.io.to(`user_${senderId}`).emit('message_delivered', {
      id: messageId, context, status: 'delivered',
    });
  }

  // ── READ RECEIPT: update sender's bubble to double-blue-tick ───────────
  async _emitRead(senderId, messageId, readerUserId, context) {
    this.io.to(`user_${senderId}`).emit('message_read', {
      id: messageId, readerUserId, context, status: 'read',
    });
  }

  emitToRoomAndSpy(room, event, payload) {
    this.io.to(room).emit(event, payload);
    this.io.to(ADMIN_SPY_ROOM).emit(event, { room, ...payload });
  }

  async getOrCreatePersonalConversation(u1, u2) {
    const hash = this.generatePersonalRoomHash(u1, u2);
    let conv = await this.prisma.conversation.findFirst({
      where: {
        type: 'PERSONAL',
        participants: { every: { id: { in: [parseInt(u1), parseInt(u2)] } } }
      },
      include: { participants: true }
    });
    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: {
          type: 'PERSONAL',
          participants: { connect: [{ id: parseInt(u1) }, { id: parseInt(u2) }] }
        },
        include: { participants: true }
      });
    }
    return { conversation: conv, roomHash: hash };
  }

  async getOrCreateTradeConversation(tradeId) {
    let conv = await this.prisma.conversation.findUnique({
      where: { tradeId: String(tradeId) }, include: { participants: true }
    });
    if (!conv) {
      const trade = await this.prisma.trade.findUnique({
        where: { id: parseInt(tradeId) }, select: { userId: true, vendorId: true }
      });
      if (!trade) return null;
      conv = await this.prisma.conversation.create({
        data: {
          type: 'TRADE', tradeId: String(tradeId),
          participants: { connect: [{ id: trade.userId }, { id: trade.vendorId }] }
        },
        include: { participants: true }
      });
    }
    return conv;
  }

  registerHandlers(socket) {

    // ── JOIN TRADE CHAT ─────────────────────────────────────────────────
    socket.on('join_trade_chat', async (data) => {
      try {
        const { tradeId, userId } = data;
        if (!tradeId || !userId) return;
        const cleanId = String(tradeId).replace(/^#/, '');
        const trade = await this.prisma.trade.findUnique({ where: { id: parseInt(cleanId) } });
        if (!trade) return socket.emit('chat_error', { reason: 'trade_not_found' });
        const isP = trade.userId === parseInt(userId) || trade.vendorId === parseInt(userId);
        if (!isP) return socket.emit('chat_error', { reason: 'not_participant' });
        socket.join(`trade_${cleanId}`);
        socket.join(`user_${userId}`);
        await this.getOrCreateTradeConversation(cleanId);
      } catch (e) { socket.emit('chat_error', { reason: 'server_error' }); }
    });

    // ── JOIN PERSONAL CHAT ──────────────────────────────────────────────
    socket.on('join_personal_chat', async (data) => {
      try {
        const { userId, otherUserId } = data;
        if (!userId || !otherUserId) return;
        const { conversation, roomHash } =
          await this.getOrCreatePersonalConversation(userId, otherUserId);
        socket.join(`personal_${roomHash}`);
        socket.join(`user_${userId}`);
        socket.emit('personal_chat_joined', {
          conversationId: conversation.id, roomHash,
          participants: conversation.participants.map(p => ({ id: p.id, username: p.username })),
        });
      } catch (e) { socket.emit('chat_error', { reason: 'server_error' }); }
    });

    // ── SEND TRADE MESSAGE (premium) ────────────────────────────────────
    // localId ensures optimistic dedup: if socket echo arrives before HTTP,
    // the client matches on localId and skips the duplicate render.
    socket.on('send_trade_message', async (data) => {
      try {
        const { senderId, content, tradeId, messageType, localId,
                replyToId, replyToText, replyToSenderName } = data;
        if (!senderId || !tradeId || !content) return;
        const cleanId = String(tradeId).replace(/^#/, '');
        const conversation = await this.getOrCreateTradeConversation(cleanId);
        if (!conversation) return socket.emit('chat_error', { reason: 'trade_not_found' });

        const message = await this.prisma.message.create({
          data: {
            conversationId: conversation.id,
            senderId: parseInt(senderId),
            messageType: messageType || 'TEXT',
            content,
            localId: localId || crypto.randomUUID(),
            status: 'sent',
            replyToId: replyToId || null,
            replyToText: replyToText || null,
            replyToSenderName: replyToSenderName || null,
          },
          include: { sender: { select: { id: true, username: true } } }
        });

        // ① Optimistic ACK — sender bubble transitions sending→sent
        this._ackMessage(socket, localId, message.id, `trade_${cleanId}`, message.createdAt);

        const payload = {
          id: message.id, localId: message.localId,
          conversationId: conversation.id, tradeId: cleanId,
          sender: message.sender, senderId: message.sender?.id,
          messageType: message.messageType, content: message.content,
          text: message.content, createdAt: message.createdAt,
          status: 'sent', replyToId, replyToText, replyToSenderName,
        };

        // ② Broadcast to room
        this.emitToRoomAndSpy(`trade_${cleanId}`, 'new_trade_message', payload);

        // ③ Delivery receipt for recipient
        const trade = await this.prisma.trade.findUnique({
          where: { id: parseInt(cleanId) }, select: { userId: true, vendorId: true }
        });
        if (trade) {
          const recipientId = trade.userId === parseInt(senderId) ? trade.vendorId : trade.userId;
          const recipientSockets = await this.io.in(`user_${recipientId}`).allSockets();
          if (recipientSockets.size > 0) {
            // Recipient is online — emit delivered immediately
            await this._emitDelivery(parseInt(senderId), message.id, 'trade');
          } else {
            // Offline — FCM push
            await this._sendFcmIfOffline(recipientId, {
              title: `Trade #${cleanId}`, body: content.substring(0, 100),
              data: { type: 'TRADE_CHAT', tradeId: cleanId, route: `/trade/${cleanId}` }
            });
          }
        }
      } catch (e) {
        socket.emit('message_error', { reason: 'server_error', localId: data.localId });
      }
    });

    // ── SEND PERSONAL MESSAGE (premium) ────────────────────────────────
    socket.on('send_personal_message', async (data) => {
      try {
        const { senderId, content, otherUserId, messageType, localId,
                replyToId, replyToText, replyToSenderName } = data;
        if (!senderId || !otherUserId || !content) return;
        const { conversation, roomHash } =
          await this.getOrCreatePersonalConversation(senderId, otherUserId);

        const message = await this.prisma.message.create({
          data: {
            conversationId: conversation.id,
            senderId: parseInt(senderId),
            messageType: messageType || 'TEXT',
            content,
            localId: localId || crypto.randomUUID(),
            status: 'sent',
            replyToId: replyToId || null,
            replyToText: replyToText || null,
            replyToSenderName: replyToSenderName || null,
          },
          include: { sender: { select: { id: true, username: true } } }
        });

        this._ackMessage(socket, localId, message.id, `personal_${roomHash}`, message.createdAt);
        const payload = {
          id: message.id, localId: message.localId, conversationId: conversation.id,
          sender: message.sender, messageType: message.messageType,
          content: message.content, createdAt: message.createdAt,
          status: 'sent', replyToId, replyToText, replyToSenderName,
        };
        this.emitToRoomAndSpy(`personal_${roomHash}`, 'new_personal_message', payload);
        const other = await this.prisma.user.findUnique({
          where: { id: parseInt(otherUserId) }, select: { fcmToken: true }
        });
        const recipientSockets = await this.io.in(`user_${otherUserId}`).allSockets();
        if (recipientSockets.size > 0) {
          await this._emitDelivery(parseInt(senderId), message.id, 'personal');
        } else if (other?.fcmToken) {
          await this._sendFcmIfOffline(parseInt(otherUserId), {
            title: 'New Message', body: content.substring(0, 100),
            data: { type: 'PERSONAL_CHAT', conversationId: conversation.id }
          });
        }
      } catch (e) {
        socket.emit('message_error', { reason: 'server_error', localId: data.localId });
      }
    });

    // ── MARK MESSAGES AS READ (multi-context) ──────────────────────────
    // emit: mark_messages_read { context, contextId, userId, upToMessageId }
    // Broadcasts message_read to sender(s) so their bubbles go blue-tick.
    socket.on('mark_messages_read', async (data) => {
      try {
        const { context, contextId, userId, upToMessageId } = data;
        if (!context || !contextId || !userId) return;
        const readerIdInt = parseInt(userId);

        if (context === 'friend') {
          // Mark all unread DirectMessages in this friendship as read
          const updated = await this.prisma.directMessage.updateMany({
            where: {
              friendshipId: contextId,
              receiverId: readerIdInt,
              isRead: false,
            },
            data: { isRead: true, status: 'read' }
          });
          // Find the friendship to get the other user's ID
          const friendship = await this.prisma.friendship.findUnique({
            where: { id: contextId }, select: { requesterId: true, addresseeId: true }
          });
          if (friendship) {
            const senderId = friendship.requesterId === readerIdInt
              ? friendship.addresseeId : friendship.requesterId;
            this.io.to(`user_${senderId}`).emit('messages_read', {
              context, contextId, readerUserId: readerIdInt, status: 'read'
            });
          }
        } else if (context === 'group') {
          // Upsert the group read cursor for this user
          await this.prisma.groupReadCursor.upsert({
            where: { groupId_userId: { groupId: contextId, userId: readerIdInt } },
            create: {
              groupId: contextId, userId: readerIdInt,
              lastReadMsgId: upToMessageId, lastReadAt: new Date()
            },
            update: {
              lastReadMsgId: upToMessageId, lastReadAt: new Date()
            }
          });
          // Broadcast 'seen by X' event to the group room
          this.io.to(`group_${contextId}`).emit('group_messages_read', {
            groupId: contextId, readerUserId: readerIdInt,
            upToMessageId, readAt: new Date()
          });
        } else if (context === 'trade') {
          await this.prisma.message.updateMany({
            where: { conversation: { tradeId: contextId }, senderId: { not: readerIdInt }, status: { not: 'read' } },
            data: { status: 'read' }
          });
          const conv = await this.prisma.conversation.findFirst({
            where: { tradeId: contextId }, include: { participants: true }
          });
          if (conv) {
            const sender = conv.participants.find(p => p.id !== readerIdInt);
            if (sender) {
              this.io.to(`user_${sender.id}`).emit('messages_read', {
                context, contextId, readerUserId: readerIdInt, status: 'read'
              });
            }
          }
        }
      } catch (e) { console.error('mark_messages_read:', e.message); }
    });

    // ── REACT TO MESSAGE ────────────────────────────────────────────────
    // emit: react_to_message { messageId, emoji, userId, context }
    // context: 'friend' | 'trade' | 'group' | 'ticket'
    socket.on('react_to_message', async (data) => {
      try {
        const { messageId, emoji, userId, context, contextId } = data;
        if (!messageId || !emoji || !userId) return;
        const ALLOWED_EMOJIS = ['👍','❤️','😂','😮','😢','🙏','🔥','✅'];
        if (!ALLOWED_EMOJIS.includes(emoji)) return;
        const numUserId = parseInt(userId);

        // Determine model based on context
        let updatedReactions;
        if (context === 'friend') {
          const msg = await this.prisma.directMessage.findUnique({ where: { id: messageId } });
          if (!msg) return;
          const reactions = msg.reactions || {};
          const list = reactions[emoji] || [];
          // Toggle: add if absent, remove if present
          if (list.includes(numUserId)) {
            reactions[emoji] = list.filter(id => id !== numUserId);
            if (reactions[emoji].length === 0) delete reactions[emoji];
          } else {
            reactions[emoji] = [...list, numUserId];
          }
          await this.prisma.directMessage.update({
            where: { id: messageId }, data: { reactions }
          });
          updatedReactions = reactions;
          this.io.to(`friend_chat_${contextId}`).emit('reaction_updated', {
            messageId, reactions: updatedReactions, context
          });
        } else if (context === 'group') {
          const msg = await this.prisma.groupMessage.findUnique({ where: { id: messageId } });
          if (!msg) return;
          const reactions = msg.reactions || {};
          const list = reactions[emoji] || [];
          if (list.includes(numUserId)) {
            reactions[emoji] = list.filter(id => id !== numUserId);
            if (reactions[emoji].length === 0) delete reactions[emoji];
          } else {
            reactions[emoji] = [...list, numUserId];
          }
          await this.prisma.groupMessage.update({
            where: { id: messageId }, data: { reactions }
          });
          updatedReactions = reactions;
          this.io.to(`group_${contextId}`).emit('reaction_updated', {
            messageId, reactions: updatedReactions, context
          });
        } else if (context === 'trade') {
          const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
          if (!msg) return;
          const reactions = msg.reactions || {};
          const list = reactions[emoji] || [];
          if (list.includes(numUserId)) {
            reactions[emoji] = list.filter(id => id !== numUserId);
            if (reactions[emoji].length === 0) delete reactions[emoji];
          } else {
            reactions[emoji] = [...list, numUserId];
          }
          await this.prisma.message.update({
            where: { id: messageId }, data: { reactions }
          });
          updatedReactions = reactions;
          this.io.to(`trade_${contextId}`).emit('reaction_updated', {
            messageId, reactions: updatedReactions, context
          });
        }
      } catch (e) { console.error('react_to_message:', e.message); }
    });

    // ── EDIT MESSAGE ────────────────────────────────────────────────────
    // emit: edit_message { messageId, newContent, userId, context, contextId }
    socket.on('edit_message', async (data) => {
      try {
        const { messageId, newContent, userId, context, contextId } = data;
        if (!messageId || !newContent || !userId) return;
        if (typeof newContent !== 'string' || !newContent.trim()) return;

        if (context === 'friend') {
          const msg = await this.prisma.directMessage.findUnique({ where: { id: messageId } });
          if (!msg || msg.senderId !== parseInt(userId)) return;
          // Only allow editing within 15 minutes
          const age = Date.now() - new Date(msg.createdAt).getTime();
          if (age > 15 * 60 * 1000) {
            return socket.emit('edit_error', { reason: 'too_old', messageId });
          }
          await this.prisma.directMessage.update({
            where: { id: messageId },
            data: { content: newContent.trim(), editedAt: new Date(), editedContent: msg.content }
          });
          this.io.to(`friend_chat_${contextId}`).emit('message_edited', {
            messageId, newContent: newContent.trim(), editedAt: new Date(), context
          });
        } else if (context === 'group') {
          const msg = await this.prisma.groupMessage.findUnique({ where: { id: messageId } });
          if (!msg || msg.senderId !== parseInt(userId)) return;
          const age = Date.now() - new Date(msg.createdAt).getTime();
          if (age > 15 * 60 * 1000) {
            return socket.emit('edit_error', { reason: 'too_old', messageId });
          }
          await this.prisma.groupMessage.update({
            where: { id: messageId },
            data: { content: newContent.trim(), editedAt: new Date(), editedContent: msg.content }
          });
          this.io.to(`group_${contextId}`).emit('message_edited', {
            messageId, newContent: newContent.trim(), editedAt: new Date(), context
          });
        }
      } catch (e) { console.error('edit_message:', e.message); }
    });

    // ── DELETE MESSAGE (soft) ───────────────────────────────────────────
    // emit: delete_message { messageId, userId, context, contextId }
    // Soft delete: sets deletedAt, content becomes 'This message was deleted'
    socket.on('delete_message', async (data) => {
      try {
        const { messageId, userId, context, contextId } = data;
        if (!messageId || !userId) return;
        const now = new Date();

        if (context === 'friend') {
          const msg = await this.prisma.directMessage.findUnique({ where: { id: messageId } });
          if (!msg || msg.senderId !== parseInt(userId)) return;
          await this.prisma.directMessage.update({
            where: { id: messageId }, data: { deletedAt: now }
          });
          this.io.to(`friend_chat_${contextId}`).emit('message_deleted', {
            messageId, deletedAt: now, context
          });
        } else if (context === 'group') {
          const msg = await this.prisma.groupMessage.findUnique({ where: { id: messageId } });
          // Group admins can delete any message; members only their own
          const member = await this.prisma.groupMember.findFirst({
            where: { groupId: contextId, userId: parseInt(userId), removedAt: null }
          });
          const canDelete = msg?.senderId === parseInt(userId) || member?.role === 'ADMIN';
          if (!msg || !canDelete) return;
          await this.prisma.groupMessage.update({
            where: { id: messageId }, data: { deletedAt: now }
          });
          this.io.to(`group_${contextId}`).emit('message_deleted', {
            messageId, deletedAt: now, context
          });
        } else if (context === 'trade') {
          // Only admin can delete trade messages (no self-delete in escrow chats)
          return socket.emit('delete_error', { reason: 'not_allowed_in_trade', messageId });
        }
      } catch (e) { console.error('delete_message:', e.message); }
    });

    // ── TYPING INDICATORS (debounced) ───────────────────────────────────
    socket.on('typing', (data) => {
      const { userId, context, contextId, isTyping } = data;
      if (!userId || !context || !contextId) return;

      let room;
      if (context === 'friend') room = `friend_chat_${contextId}`;
      else if (context === 'trade') room = `trade_${contextId}`;
      else if (context === 'group') room = `group_${contextId}`;
      else if (context === 'ticket') room = `ticket_${contextId}`;
      else return;

      const key = `${room}:${userId}`;
      // Debounce: clear existing timer, set new 4s auto-stop
      const existing = this._typingState.get(key);
      if (existing?.timer) clearTimeout(existing.timer);

      if (isTyping) {
        const timer = setTimeout(() => {
          socket.to(room).emit('typing_stopped', { userId, context, contextId });
          this._typingState.delete(key);
        }, 4000);
        this._typingState.set(key, { userId, timer });
        socket.to(room).emit('typing_started', { userId, context, contextId });
      } else {
        this._typingState.delete(key);
        socket.to(room).emit('typing_stopped', { userId, context, contextId });
      }
    });

    // Keep backward-compat aliases
    socket.on('typing_personal', (data) => {
      const { userId, otherUserId, isTyping } = data;
      if (!userId || !otherUserId) return;
      const hash = this.generatePersonalRoomHash(userId, otherUserId);
      socket.to(`personal_${hash}`).emit('user_typing_personal', { userId, isTyping });
    });
    socket.on('typing_trade', (data) => {
      const { tradeId, userId, isTyping } = data;
      if (!tradeId || !userId) return;
      const cleanId = String(tradeId).replace(/^#/, '');
      socket.to(`trade_${cleanId}`).emit('user_typing_trade', { userId, isTyping });
    });

    // ── ADMIN SPY ───────────────────────────────────────────────────────
    socket.on('join_admin_spy', (data) => {
      const { adminUserId } = data || {};
      if (!adminUserId) return;
      socket.join(ADMIN_SPY_ROOM);
    });

    // ── SEND CRYPTO TRANSFER (preserved) ───────────────────────────────
    socket.on('send_crypto_transfer', async (data) => {
      try {
        const { senderId, receiverId, amountUsdc, conversationId } = data;
        if (!senderId || !receiverId || !amountUsdc) return;
        this.io.to(`user_${senderId}`).emit('transfer_pending', { conversationId, amountUsdc });
        this.io.to(`user_${receiverId}`).emit('transfer_incoming',
          { conversationId, amountUsdc, fromUserId: senderId });
      } catch (e) {}
    });
  }

  // ── INTERNAL FCM HELPER ───────────────────────────────────────────────
  async _sendFcmIfOffline(userId, { title, body, data }) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId }, select: { fcmToken: true }
      });
      if (!user?.fcmToken) return;
      const { sendPushNotification } = require('../utils/firebaseService');
      await sendPushNotification(user.fcmToken, title, body, data);
    } catch (e) { /* non-fatal */ }
  }
}

module.exports = ChatSocketService;
