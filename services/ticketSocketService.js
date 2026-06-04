// services/ticketSocketService.js
// =============================================================================
// AZAMAN — TICKET SOCKET SERVICE (Phase UI-4, 2026-05-26)
//
// Real-time socket events for the Tickets Engine. Mirrors the friend-chat
// pattern (`friendSocketService.js`) but scoped to a ticket workspace.
//
// Room naming contract:
//   Ticket workspace room: ticket_${ticketId}
//   User inbox:            user_${userId}  (shared with the rest of the app)
//
// Handled events:
//   • join_ticket            — join a ticket workspace room
//   • leave_ticket           — leave a ticket workspace room
//   • ticket_typing          — typing indicator inside the workspace
//   • ticket_presence        — alternate path for the REST presence ping;
//                               useful for offline detection on rapid
//                               foreground/background flips
//
// Authoritative writes still flow through the REST controller
// (`controllers/ticketController.js`) — this service is purely the
// real-time fanout layer.
// =============================================================================

class TicketSocketService {
    constructor(io, prisma) {
        this.io = io;
        this.prisma = prisma;
    }

    registerHandlers(socket) {
        const userId = socket.user?.id;

        // ── 1. JOIN TICKET ROOM ─────────────────────────────────────────────
        socket.on('join_ticket', async (data) => {
            try {
                const ticketId = (data && data.ticketId) || data;
                if (!ticketId || !userId) return;

                const ticket = await this.prisma.ticket.findUnique({
                    where: { id: ticketId },
                    select: {
                        id: true,
                        creatorId: true,
                        counterpartyId: true,
                        friendshipId: true,
                        status: true
                    }
                });

                if (!ticket) {
                    socket.emit('ticket_error', { reason: 'ticket_not_found' });
                    return;
                }
                if (ticket.creatorId !== userId && ticket.counterpartyId !== userId) {
                    socket.emit('ticket_error', { reason: 'not_participant' });
                    return;
                }

                const room = `ticket_${ticket.id}`;
                socket.join(room);
                console.log(`🎟️ ${socket.id} → ${room}`);

                socket.emit('ticket_joined', { ticketId: ticket.id, room });

                // Broadcast presence to the friendship room so the parent
                // chat surface can render the "currently viewing ticket" banner.
                this.io.to(`friend_chat_${ticket.friendshipId}`).emit('ticket_presence_update', {
                    ticketId: ticket.id,
                    friendshipId: ticket.friendshipId,
                    userId,
                    viewing: true
                });
            } catch (err) {
                console.error('join_ticket error:', err.message);
                socket.emit('ticket_error', { reason: 'server_error' });
            }
        });

        // ── 2. LEAVE TICKET ROOM ────────────────────────────────────────────
        socket.on('leave_ticket', async (data) => {
            try {
                const ticketId = (data && data.ticketId) || data;
                if (!ticketId || !userId) return;

                const room = `ticket_${ticketId}`;
                socket.leave(room);

                const ticket = await this.prisma.ticket.findUnique({
                    where: { id: ticketId },
                    select: { friendshipId: true }
                });

                if (ticket) {
                    this.io.to(`friend_chat_${ticket.friendshipId}`).emit('ticket_presence_update', {
                        ticketId,
                        friendshipId: ticket.friendshipId,
                        userId,
                        viewing: false
                    });
                }
            } catch (err) {
                console.error('leave_ticket error:', err.message);
            }
        });

        // ── 3. TYPING INDICATOR ─────────────────────────────────────────────
        socket.on('ticket_typing', (data) => {
            const { ticketId, isTyping } = data || {};
            if (!ticketId || !userId) return;
            socket.to(`ticket_${ticketId}`).emit('ticket_typing_update', {
                ticketId,
                userId,
                isTyping: !!isTyping
            });
        });
    }
}

module.exports = TicketSocketService;
