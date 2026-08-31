// src/sockets/socketServices.js
// =============================================================================
// Instantiates all socket-bound services: trade, chat, group chat, friend,
// ticket, and notification. These wrap the Socket.IO server instance to
// provide real-time event handling for their respective domains.
//
// Exports: { tradeSocketService, chatSocketService, groupChatService,
//           friendSocketService, ticketSocketService, notificationService,
//           vendorStatus }
// =============================================================================

const TradeSocketService = require('../../services/tradeSocketService');
const ChatSocketService = require('../../services/chatSocketService');
const GroupChatSocketService = require('../../services/groupChatSocketService');
const FriendSocketService = require('../../services/friendSocketService');
const TicketSocketService = require('../../services/ticketSocketService');
const NotificationService = require('../../services/notificationService');
const WebRTCSocketService = require('../../services/webrtcSocketService');
const { setSocketIO: setBusinessNotificationSocketIO } = require('../../services/bizNotificationService');
const { setSocketIO: setEscrowSocketIO } = require('../../services/escrowService');

const vendorStatus = new Map();

function createSocketServices(io, prisma, app) {
    // BusinessNotification is persisted by a service used from financial
    // workflows, so wire the already-authoritative Socket.IO instance into
    // that chokepoint once at server bootstrap. No second transport is created.
    setBusinessNotificationSocketIO(io);
    // Refund convergence is emitted by the canonical escrow financial service
    // after its atomic transaction commits.
    setEscrowSocketIO(io);

    const tradeSocketService = new TradeSocketService(io, prisma);
    const chatSocketService = new ChatSocketService(io, prisma);
    const groupChatSocketService = new GroupChatSocketService(io, prisma);
    const friendSocketService = new FriendSocketService(io, prisma);
    const ticketSocketService = new TicketSocketService(io, prisma);
    const notificationService = new NotificationService(prisma, io);
    const webrtcSocketService = new WebRTCSocketService(io, prisma);

    app.set('notificationService', notificationService);
    app.set('webrtcSocketService', webrtcSocketService);

    return {
        tradeSocketService,
        chatSocketService,
        groupChatSocketService,
        friendSocketService,
        ticketSocketService,
        notificationService,
        webrtcSocketService,
        vendorStatus,
    };
}

module.exports = { createSocketServices };