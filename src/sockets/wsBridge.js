// src/sockets/wsBridge.js
// =============================================================================
// Raw WebSocket Bridge Server
//
// Sits alongside the existing Socket.IO server and provides a raw WebSocket
// endpoint (/ws) for native clients (Android/KMP) that use Ktor's WebSocket
// client instead of Socket.IO.
//
// The bridge:
// 1. Authenticates via JWT in the query string (?token=...)
// 2. Translates the Android client's kebab-case event format to the existing
//    Socket.IO service calls (same prisma models, same persistence)
// 3. Emits events back in the Android client's expected format
//
// Event mapping (Android → Backend):
//   authenticate         → (auth already done via query param)
//   message:send        → send_personal_message / send_group_message
//   message:read        → mark_messages_read
//   typing:start        → typing_personal { isTyping: true }
//   typing:stop         → typing_personal { isTyping: false }
//   presence:heartbeat  → user_heartbeat
//
// Event mapping (Backend → Android):
//   new_personal_message → message:new
//   message_ack          → message:ack
//   message_delivered    → message:delivered
//   message_read         → message:read
//   user_typing_personal → typing:start / typing:stop
//   user_online          → presence:online
//   user_offline         → presence:offline
// =============================================================================

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const logger = require('../config/logger');

function createWsBridge(server, deps) {
    const { prisma, JWT_SECRET, chatSocketService, groupChatSocketService } = deps;

    const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 1024 * 1024 });

    // Track all connected raw-WS clients: userId → Set<WebSocket>
    const wsClients = new Map();

    function getClients(userId) {
        return wsClients.get(String(userId)) || new Set();
    }

    function addClient(userId, ws) {
        const key = String(userId);
        if (!wsClients.has(key)) wsClients.set(key, new Set());
        wsClients.get(key).add(ws);
    }

    function removeClient(userId, ws) {
        const key = String(userId);
        const set = wsClients.get(key);
        if (set) {
            set.delete(ws);
            if (set.size === 0) wsClients.delete(key);
        }
    }

    // ── Send a typed event to a specific user's raw-WS clients ──
    function sendToUser(userId, type, payload) {
        const clients = getClients(userId);
        const msg = JSON.stringify({ type, payload });
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        }
    }

    // ── Generate personal room hash (same algorithm as ChatSocketService) ──
    function generatePersonalRoomHash(u1, u2) {
        return crypto.createHash('sha256')
            .update([String(u1), String(u2)].sort().join('_'))
            .digest('hex').slice(0, 32);
    }

    // ── Get or create a personal conversation ──
    async function getOrCreatePersonalConversation(u1, u2) {
        let conv = await prisma.conversation.findFirst({
            where: {
                type: 'PERSONAL',
                participants: { every: { id: { in: [parseInt(u1), parseInt(u2)] } } }
            },
            include: { participants: true }
        });
        if (!conv) {
            conv = await prisma.conversation.create({
                data: {
                    type: 'PERSONAL',
                    participants: { connect: [{ id: parseInt(u1) }, { id: parseInt(u2) }] }
                },
                include: { participants: true }
            });
        }
        return conv;
    }

    wss.on('connection', (ws, req) => {
        // ── Authenticate via query param ──
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token');

        if (!token) {
            ws.send(JSON.stringify({ type: 'error', payload: { message: 'No token provided' } }));
            ws.close(4001, 'Authentication required');
            return;
        }

        let user;
        try {
            user = jwt.verify(token, JWT_SECRET);
            if (!user || !user.id) {
                ws.close(4001, 'Invalid token');
                return;
            }
        } catch (err) {
            ws.close(4001, err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
            return;
        }

        const userId = String(user.id);
        addClient(userId, ws);

        logger.info({ userId }, '[wsBridge] Client connected');

        // ── Emit presence:online ──
        sendToUser(userId, 'presence:online', { userId, lastSeen: new Date().toISOString() });

        // Update DB presence
        prisma.user.update({
            where: { id: parseInt(userId) },
            data: { isOnline: true, lastSeenAt: new Date() }
        }).catch(() => {});

        // Broadcast to Socket.IO that this user is online (so Socket.IO clients see it too)
        deps.io?.sockets?.emit?.('user_online', { userId, lastSeenAt: new Date().toISOString() });

        // ── Message routing ──
        ws.on('message', async (raw) => {
            let event;
            try {
                event = JSON.parse(raw.toString());
            } catch {
                ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid JSON' } }));
                return;
            }

            const { type, payload } = event;

            try {
                switch (type) {
                    // ── message:send → persist + broadcast ──
                    case 'message:send': {
                        const { conversationId, text, messageType, replyTo, tempId } = payload || {};
                        if (!conversationId || !text) return;

                        // Resolve the conversation to find the other participant
                        const conv = await prisma.conversation.findUnique({
                            where: { id: conversationId },
                            include: { participants: true }
                        });
                        if (!conv) {
                            ws.send(JSON.stringify({ type: 'error', payload: { message: 'Conversation not found', tempId } }));
                            return;
                        }

                        // Verify sender is a participant
                        const isParticipant = conv.participants.some(p => p.id === parseInt(userId));
                        if (!isParticipant) {
                            ws.send(JSON.stringify({ type: 'error', payload: { message: 'Not a participant', tempId } }));
                            return;
                        }

                        const message = await prisma.message.create({
                            data: {
                                conversationId,
                                senderId: parseInt(userId),
                                messageType: messageType || 'TEXT',
                                content: text,
                                localId: tempId || crypto.randomUUID(),
                                status: 'sent',
                                replyToId: replyTo || null,
                            },
                            include: { sender: { select: { id: true, username: true } } }
                        });

                        // ACK the sender
                        ws.send(JSON.stringify({
                            type: 'message:ack',
                            payload: {
                                localId: tempId,
                                id: message.id,
                                conversationId,
                                createdAt: message.createdAt,
                                status: 'sent'
                            }
                        }));

                        // Build the message payload for the other participant(s)
                        const msgPayload = {
                            id: message.id,
                            localId: message.localId,
                            conversationId,
                            senderId: message.sender?.id || parseInt(userId),
                            senderName: message.sender?.username || 'Unknown',
                            text: message.content,
                            type: message.messageType,
                            status: 'sent',
                            createdAt: message.createdAt
                        };

                        if (conv.type === 'PERSONAL') {
                            // Send to the other participant via raw WS
                            const otherUser = conv.participants.find(p => p.id !== parseInt(userId));
                            if (otherUser) {
                                sendToUser(String(otherUser.id), 'message:new', msgPayload);
                                // Also emit via Socket.IO for web clients
                                const hash = generatePersonalRoomHash(userId, otherUser.id);
                                deps.io?.to(`personal_${hash}`).emit('new_personal_message', msgPayload);
                            }
                        } else if (conv.type === 'GROUP' || conv.type === 'TRADE') {
                            // Broadcast to all other participants via raw WS
                            for (const p of conv.participants) {
                                if (String(p.id) !== userId) {
                                    sendToUser(String(p.id), 'message:new', msgPayload);
                                }
                            }
                            // Also via Socket.IO
                            if (conv.type === 'GROUP') {
                                deps.io?.to(`group_${conv.id}`).emit('new_group_message', msgPayload);
                            }
                        }
                        break;
                    }

                    // ── message:read → mark messages as read ──
                    case 'message:read': {
                        const { conversationId, messageIds } = payload || {};
                        if (!conversationId || !messageIds?.length) return;

                        // Update message statuses in DB
                        await prisma.message.updateMany({
                            where: { id: { in: messageIds }, conversationId },
                            data: { status: 'read' }
                        });

                        // Notify the original sender(s) that their messages were read
                        const messages = await prisma.message.findMany({
                            where: { id: { in: messageIds } },
                            select: { id: true, senderId: true }
                        });

                        for (const msg of messages) {
                            if (String(msg.senderId) !== userId) {
                                sendToUser(String(msg.senderId), 'message:read', {
                                    id: msg.id,
                                    readerUserId: userId,
                                    conversationId,
                                    status: 'read'
                                });
                                // Also via Socket.IO
                                deps.io?.to(`user_${msg.senderId}`).emit('message_read', {
                                    id: msg.id, readerUserId: userId, context: 'personal', status: 'read'
                                });
                            }
                        }
                        break;
                    }

                    // ── typing:start / typing:stop ──
                    case 'typing:start':
                    case 'typing:stop': {
                        const { conversationId } = payload || {};
                        if (!conversationId) return;

                        const conv = await prisma.conversation.findUnique({
                            where: { id: conversationId },
                            include: { participants: true }
                        });
                        if (!conv) return;

                        const isTyping = type === 'typing:start';

                        if (conv.type === 'PERSONAL') {
                            const otherUser = conv.participants.find(p => p.id !== parseInt(userId));
                            if (otherUser) {
                                sendToUser(String(otherUser.id), isTyping ? 'typing:start' : 'typing:stop', {
                                    conversationId,
                                    userId,
                                    isTyping
                                });
                                // Also via Socket.IO
                                const hash = generatePersonalRoomHash(userId, otherUser.id);
                                deps.io?.to(`personal_${hash}`).emit('user_typing_personal', { userId, isTyping });
                            }
                        } else if (conv.type === 'GROUP') {
                            for (const p of conv.participants) {
                                if (String(p.id) !== userId) {
                                    sendToUser(String(p.id), isTyping ? 'typing:start' : 'typing:stop', {
                                        conversationId, userId, isTyping
                                    });
                                }
                            }
                            deps.io?.to(`group_${conv.id}`).emit('group_typing', {
                                userId, isTyping, groupId: conv.id
                            });
                        }
                        break;
                    }

                    // ── presence:heartbeat ──
                    case 'presence:heartbeat': {
                        prisma.user.update({
                            where: { id: parseInt(userId) },
                            data: { lastSeenAt: new Date() }
                        }).catch(() => {});
                        break;
                    }

                    default:
                        // Unknown event — silently ignore (forward-compatible)
                        break;
                }
            } catch (err) {
                logger.error({ err, type }, '[wsBridge] Error handling event');
                ws.send(JSON.stringify({ type: 'error', payload: { message: 'Server error', type } }));
            }
        });

        // ── On close: update presence ──
        ws.on('close', () => {
            removeClient(userId, ws);
            const remaining = getClients(userId);
            if (remaining.size === 0) {
                // No more raw-WS clients — check if Socket.IO clients are also gone
                const ioSockets = deps.io?.sockets?.adapter?.rooms?.get?.(`user_${userId}`);
                if (!ioSockets || ioSockets.size === 0) {
                    prisma.user.update({
                        where: { id: parseInt(userId) },
                        data: { isOnline: false, lastSeenAt: new Date() }
                    }).catch(() => {});
                    deps.io?.sockets?.emit?.('user_offline', { userId, lastSeenAt: new Date().toISOString() });
                }
            }
            logger.info({ userId }, '[wsBridge] Client disconnected');
        });

        ws.on('error', (err) => {
            logger.error({ err, userId }, '[wsBridge] WebSocket error');
        });
    });

    logger.info('[wsBridge] Raw WebSocket bridge listening on /ws');

    return { wss, sendToUser, wsClients };
}

module.exports = { createWsBridge };
