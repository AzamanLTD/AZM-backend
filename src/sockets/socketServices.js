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

const vendorStatus = new Map();

function createSocketServices(io, prisma, app) {
    const tradeSocketService = new TradeSocketService(io, prisma);
    const chatSocketService = new ChatSocketService(io, prisma);
    const groupChatSocketService = new GroupChatSocketService(io, prisma);
    const friendSocketService = new FriendSocketService(io, prisma);
    const ticketSocketService = new TicketSocketService(io, prisma);
    const notificationService = new NotificationService(prisma, io);

    app.set('notificationService', notificationService);

    return {
        tradeSocketService,
        chatSocketService,
        groupChatSocketService,
        friendSocketService,
        ticketSocketService,
        notificationService,
        vendorStatus,
    };
}

module.exports = { createSocketServices };
