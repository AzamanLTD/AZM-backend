// =============================================================================
// TICKETS CONTROLLER — Phase UI-4 (2026-05-26)
//
// Handles isolated chat workspaces ("Tickets") created inside an existing
// peer-to-peer friendship to track a specific business deal, transaction, or
// agreement. Tickets are NOT escrow-backed P2P trades — they are lightweight
// social-transactional records.
//
// Endpoints (all `protect`):
//   • POST   /api/tickets                  — create
//   • GET    /api/tickets                  — list (paginated)
//   • GET    /api/tickets/:id              — detail + last 50 messages
//   • POST   /api/tickets/:id/messages     — send message in workspace
//   • PATCH  /api/tickets/:id/status       — close / cancel / reopen
//   • POST   /api/tickets/:id/presence     — emit presence ping
//
// Socket events:
//   • ticket_created        — room friendship_${id}, both parties refresh
//   • ticket_message        — room ticket_${id}, both parties' workspace updates
//   • ticket_presence_update — room friendship_${id}, banner toggle
//   • ticket_status_changed — room friendship_${id}, dashboard refresh
// =============================================================================

const VALID_TYPES = new Set(['BUY', 'SELL', 'ESCROW', 'SERVICE_SWAP']);
const VALID_STATUSES = new Set(['OPEN', 'CLOSED', 'CANCELLED']);
const VALID_MESSAGE_TYPES = new Set([
    'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO', 'LINK', 'TRANSFER', 'SYSTEM'
]);

// Smart Escrow & Business Accounts (2026-06-14): ESCROW-type tickets auto-create
// a SmartEscrow record; business-mode tickets bypass the friendship requirement.
const escrowService = require('../services/escrowService');

// ── helpers ─────────────────────────────────────────────────────────────────

async function _verifyFriendshipParticipant(prisma, friendshipId, userId) {
    const friendship = await prisma.friendship.findUnique({
        where: { id: friendshipId },
        select: {
            id: true,
            requesterId: true,
            addresseeId: true,
            status: true
        }
    });
    if (!friendship) {
        return { ok: false, code: 404, message: 'Friendship not found.' };
    }
    if (friendship.status !== 'ACCEPTED') {
        return { ok: false, code: 403, message: 'Tickets require an accepted friendship.' };
    }
    if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
        return { ok: false, code: 403, message: 'Not a participant in this friendship.' };
    }
    const counterpartyId = friendship.requesterId === userId
        ? friendship.addresseeId
        : friendship.requesterId;
    return { ok: true, friendship, counterpartyId };
}

async function _verifyTicketParticipant(prisma, ticketId, userId) {
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) return { ok: false, code: 404, message: 'Ticket not found.' };
    if (ticket.creatorId !== userId && ticket.counterpartyId !== userId) {
        return { ok: false, code: 403, message: 'Not a participant in this ticket.' };
    }
    return { ok: true, ticket };
}

function _eventCardContent(ticket, eventType) {
    switch (eventType) {
        case 'CREATED':   return `Created ticket "${ticket.name}" — ${ticket.type} ${ticket.targetAmount} ${ticket.targetCurrency}`;
        case 'CLOSED':    return `Closed ticket "${ticket.name}"`;
        case 'CANCELLED': return `Cancelled ticket "${ticket.name}"`;
        case 'REOPENED':  return `Reopened ticket "${ticket.name}"`;
        default:          return `Ticket "${ticket.name}" updated`;
    }
}

// =============================================================================
// 1. CREATE TICKET
//
// POST /api/tickets
// Body: { friendshipId, name, type, targetAmount, targetCurrency, memo? }
// =============================================================================
exports.createTicket = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const userId = req.user.id;
        const {
            friendshipId, businessProfileId, name, type, targetAmount,
            targetCurrency, memo, escrowAmount, deliveryTerms, dueDate
        } = req.body;

        // ── Validation ──────────────────────────────────────────────────────
        // Either friendshipId (friendship mode) or businessProfileId (business
        // mode) must be present, but not neither.
        if (!friendshipId && !businessProfileId) {
            return res.status(400).json({
                success: false,
                message: 'Either friendshipId or businessProfileId is required.'
            });
        }
        if (!name || !type || targetAmount == null || !targetCurrency) {
            return res.status(400).json({
                success: false,
                message: 'name, type, targetAmount, targetCurrency are required.'
            });
        }
        const cleanName = String(name).trim();
        if (cleanName.length === 0 || cleanName.length > 80) {
            return res.status(400).json({ success: false, message: 'name must be 1–80 chars.' });
        }
        if (!VALID_TYPES.has(type)) {
            return res.status(400).json({ success: false, message: `type must be one of: ${[...VALID_TYPES].join(', ')}` });
        }
        const amt = Number(targetAmount);
        if (!Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ success: false, message: 'targetAmount must be a positive number.' });
        }
        const currency = String(targetCurrency).trim().toUpperCase();
        if (currency.length === 0 || currency.length > 8) {
            return res.status(400).json({ success: false, message: 'targetCurrency must be 1–8 chars.' });
        }
        const cleanMemo = memo ? String(memo).trim().slice(0, 500) : null;

        // ── Authorization + mode resolution ──────────────────────────────────
        // friendship mode: counterparty derived from the friendship.
        // business  mode: counterparty = the business owner.
        let counterpartyId;
        let resolvedFriendshipId = null;
        let resolvedBusinessProfileId = null;
        let friendshipAuth = null;

        if (friendshipId) {
            const auth = await _verifyFriendshipParticipant(prisma, friendshipId, userId);
            if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });
            counterpartyId = auth.counterpartyId;
            resolvedFriendshipId = friendshipId;
            friendshipAuth = auth;
        } else {
            // Business-mode ticket (bypasses friendship requirement).
            const bizProfile = await prisma.businessProfile.findUnique({
                where: { id: businessProfileId },
                select: { id: true, userId: true, businessName: true }
            });
            if (!bizProfile) {
                return res.status(404).json({ success: false, message: 'Business not found.' });
            }
            if (bizProfile.userId === userId) {
                return res.status(400).json({ success: false, message: 'Cannot open a ticket with your own business.' });
            }
            counterpartyId = bizProfile.userId;
            resolvedBusinessProfileId = bizProfile.id;
        }

        // ── ESCROW pre-validation (before creating the ticket) ────────────────
        if (type === 'ESCROW' && (!escrowAmount || Number(escrowAmount) <= 0)) {
            return res.status(400).json({
                success: false,
                message: 'escrowAmount is required for ESCROW-type tickets.'
            });
        }

        // ── Create ──────────────────────────────────────────────────────────
        const ticket = await prisma.ticket.create({
            data: {
                friendshipId: resolvedFriendshipId,
                businessProfileId: resolvedBusinessProfileId,
                creatorId: userId,
                counterpartyId,
                name: cleanName,
                type,
                targetAmount: amt,
                targetCurrency: currency,
                memo: cleanMemo
            }
        });

        // Inject TICKET_LINK event card into the parent friendship chat so
        // both parties see the deep-link tile in their main feed. Friendship
        // mode only — business-mode tickets have no friendship feed.
        let eventCard = null;
        if (resolvedFriendshipId) {
            eventCard = await prisma.directMessage.create({
                data: {
                    friendshipId: resolvedFriendshipId,
                    senderId: userId,
                    receiverId: counterpartyId,
                    content: _eventCardContent(ticket, 'CREATED'),
                    messageType: 'TICKET_LINK',
                    metadata: {
                        ticketId: ticket.id,
                        ticketName: ticket.name,
                        ticketType: ticket.type,
                        ticketStatus: ticket.status,
                        eventType: 'CREATED',
                        targetAmount: ticket.targetAmount.toString(),
                        targetCurrency: ticket.targetCurrency
                    }
                }
            });

            // Bubble friendship to top of chat list
            await prisma.friendship.update({
                where: { id: resolvedFriendshipId },
                data: { updatedAt: new Date() }
            });
        }

        // ── Auto-create SmartEscrow for ESCROW-type tickets ───────────────────
        // payer = ticket creator (pays); payee = counterparty (delivers).
        if (type === 'ESCROW') {
            let escrow;
            try {
                escrow = await escrowService.createEscrow(prisma, {
                    ticketId: ticket.id,
                    payerId: userId,
                    payeeId: counterpartyId,
                    amountUsdc: Number(escrowAmount),
                    deliveryTerms: deliveryTerms || null,
                    dueDate: dueDate ? new Date(dueDate) : null
                });
            } catch (escrowErr) {
                // Roll back the just-created ticket so we don't orphan it.
                await prisma.ticket.delete({ where: { id: ticket.id } }).catch(() => {});
                return res.status(400).json({ success: false, message: escrowErr.message });
            }

            // ── Sockets ──────────────────────────────────────────────────────
            if (io) {
                io.to(`user_${userId}`).emit('ticket_created', { ticket });
                io.to(`user_${counterpartyId}`).emit('ticket_created', { ticket });
                if (resolvedFriendshipId && eventCard) {
                    io.to(`friend_chat_${resolvedFriendshipId}`).emit('friend_message', {
                        ...eventCard,
                        eventCard: true
                    });
                }
            }

            return res.status(201).json({ success: true, ticket, escrow });
        }

        // ── Sockets (non-escrow) ─────────────────────────────────────────────
        if (io) {
            io.to(`user_${userId}`).emit('ticket_created', { ticket });
            io.to(`user_${counterpartyId}`).emit('ticket_created', { ticket });
            if (resolvedFriendshipId && eventCard) {
                io.to(`friend_chat_${resolvedFriendshipId}`).emit('friend_message', {
                    ...eventCard,
                    eventCard: true
                });
            }
        }

        return res.status(201).json({ success: true, ticket });
    } catch (err) {
        console.error('[createTicket] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 2. LIST TICKETS — paginated, three modes
//
// GET /api/tickets?friendshipId=&businessProfileId=&status=&cursor=&limit=
//
//   MODE 1 — friendshipId provided : tickets in that friendship (legacy).
//   MODE 2 — businessProfileId provided : tickets for that business (owner or
//            a ticket participant may view).
//   MODE 3 — neither provided : the caller's own tickets ("My Deals").
// =============================================================================
exports.listTickets = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { friendshipId, businessProfileId, status } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const cursor = req.query.cursor || null;

        let where;

        if (friendshipId) {
            // ── MODE 1 — friendship tickets (unchanged behavior) ──────────────
            const auth = await _verifyFriendshipParticipant(prisma, friendshipId, userId);
            if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });
            where = { friendshipId };
        } else if (businessProfileId) {
            // ── MODE 2 — business tickets ─────────────────────────────────────
            // Caller must be the business owner OR a participant on one of its
            // tickets (creatorId or counterpartyId).
            const bizProfile = await prisma.businessProfile.findUnique({
                where: { id: businessProfileId },
                select: { id: true, userId: true }
            });
            if (!bizProfile) {
                return res.status(404).json({ success: false, message: 'Business not found.' });
            }
            if (bizProfile.userId !== userId) {
                const participantTicket = await prisma.ticket.findFirst({
                    where: {
                        businessProfileId,
                        OR: [{ creatorId: userId }, { counterpartyId: userId }]
                    },
                    select: { id: true }
                });
                if (!participantTicket) {
                    return res.status(403).json({ success: false, message: 'Not authorized to view this business\'s tickets.' });
                }
            }
            where = { businessProfileId };
        } else {
            // ── MODE 3 — "My Deals": all tickets the caller participates in ───
            where = { OR: [{ creatorId: userId }, { counterpartyId: userId }] };
        }

        // Shared status filter (all three modes).
        if (status) {
            const upper = String(status).toUpperCase();
            if (!VALID_STATUSES.has(upper)) {
                return res.status(400).json({ success: false, message: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
            }
            where.status = upper;
        }

        const tickets = await prisma.ticket.findMany({
            where,
            orderBy: { lastActivityAt: 'desc' },
            take: limit + 1,
            include: {
                smartEscrow: { select: { id: true, status: true, amountUsdc: true, feeUsdc: true } }
            },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });

        const hasMore = tickets.length > limit;
        const slice = hasMore ? tickets.slice(0, limit) : tickets;
        const nextCursor = hasMore ? slice[slice.length - 1].id : null;

        return res.status(200).json({
            success: true,
            tickets: slice,
            hasMore,
            nextCursor
        });
    } catch (err) {
        console.error('[listTickets] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 3. TICKET DETAIL — full ticket + last 50 messages (chronological)
//
// GET /api/tickets/:id
// =============================================================================
exports.getTicket = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const auth = await _verifyTicketParticipant(prisma, id, userId);
        if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });

        const messages = await prisma.ticketMessage.findMany({
            where: { ticketId: id },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: {
                sender: { select: { id: true, username: true, profilePictureUrl: true } }
            }
        });

        return res.status(200).json({
            success: true,
            ticket: auth.ticket,
            messages: messages.reverse() // chronological for client
        });
    } catch (err) {
        console.error('[getTicket] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 4. SEND TICKET MESSAGE — text or rich-media (reuses Phase UI-3 fields)
//
// POST /api/tickets/:id/messages
// Body: {
//   content?, type?, metadata?,
//   mediaUrl?, mediaType?, mediaMimeType?, mediaSize?,
//   mediaDuration?, mediaWaveformPeaks?, linkPreview?
// }
// =============================================================================
exports.sendTicketMessage = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    const linkPreviewService = req.app.get('linkPreviewService');

    try {
        const userId = req.user.id;
        const { id } = req.params;
        const {
            content, type, metadata,
            mediaUrl, mediaType, mediaMimeType, mediaSize,
            mediaDuration, mediaWaveformPeaks, linkPreview
        } = req.body;

        const auth = await _verifyTicketParticipant(prisma, id, userId);
        if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });
        if (auth.ticket.status !== 'OPEN') {
            return res.status(409).json({
                success: false,
                message: `Cannot post to a ${auth.ticket.status.toLowerCase()} ticket.`
            });
        }

        const finalType = (type || 'TEXT').toString().toUpperCase();
        if (!VALID_MESSAGE_TYPES.has(finalType)) {
            return res.status(400).json({ success: false, message: `type must be one of: ${[...VALID_MESSAGE_TYPES].join(', ')}` });
        }
        const isMedia = ['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO', 'LINK'].includes(finalType);
        if (!isMedia && (!content || !content.trim())) {
            return res.status(400).json({ success: false, message: 'content required for text messages.' });
        }
        if (isMedia && !mediaUrl) {
            return res.status(400).json({ success: false, message: 'mediaUrl required for media messages.' });
        }

        let resolvedLinkPreview = linkPreview || null;
        if (finalType === 'LINK' && !resolvedLinkPreview && content && linkPreviewService) {
            try { resolvedLinkPreview = await linkPreviewService.fetch(content.trim()); }
            catch (_) { /* swallow — preview is non-fatal */ }
        }

        const message = await prisma.ticketMessage.create({
            data: {
                ticketId: id,
                senderId: userId,
                type: finalType,
                content: content ? String(content).trim() : null,
                metadata: metadata || null,
                mediaUrl: mediaUrl || null,
                mediaType: mediaType || null,
                mediaMimeType: mediaMimeType || null,
                mediaSize: typeof mediaSize === 'number' ? mediaSize : null,
                mediaDuration: typeof mediaDuration === 'number' ? mediaDuration : null,
                mediaWaveformPeaks: Array.isArray(mediaWaveformPeaks) ? mediaWaveformPeaks : null,
                linkPreview: resolvedLinkPreview
            },
            include: {
                sender: { select: { id: true, username: true, profilePictureUrl: true } }
            }
        });

        // Bump lastActivityAt so the dashboard re-sorts.
        await prisma.ticket.update({
            where: { id },
            data: { lastActivityAt: new Date() }
        });

        if (io) {
            const payload = { ...message, ticketId: id };
            io.to(`ticket_${id}`).emit('ticket_message', payload);
            // Also push to both users' personal rooms so they get a
            // notification badge even if neither has the workspace open.
            io.to(`user_${auth.ticket.creatorId}`).emit('ticket_message', payload);
            io.to(`user_${auth.ticket.counterpartyId}`).emit('ticket_message', payload);
        }

        return res.status(201).json({ success: true, message });
    } catch (err) {
        console.error('[sendTicketMessage] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 5. CHANGE TICKET STATUS — close / cancel / reopen
//
// PATCH /api/tickets/:id/status
// Body: { status: 'CLOSED' | 'CANCELLED' | 'OPEN' }
// =============================================================================
exports.changeTicketStatus = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { status } = req.body;

        const targetStatus = String(status || '').toUpperCase();
        if (!VALID_STATUSES.has(targetStatus)) {
            return res.status(400).json({ success: false, message: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
        }

        const auth = await _verifyTicketParticipant(prisma, id, userId);
        if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });

        // Forbid no-op transitions and explicit logical regressions:
        //   CLOSED  → only OPEN (reopen)
        //   CANCELLED → only OPEN (reopen)
        //   OPEN → CLOSED or CANCELLED
        const current = auth.ticket.status;
        if (current === targetStatus) {
            return res.status(409).json({ success: false, message: `Ticket already ${current}.` });
        }
        if (current === 'OPEN' && targetStatus === 'OPEN') {
            return res.status(409).json({ success: false, message: 'Already open.' });
        }
        if ((current === 'CLOSED' || current === 'CANCELLED') && targetStatus !== 'OPEN') {
            return res.status(409).json({
                success: false,
                message: `Cannot move from ${current} to ${targetStatus}; reopen first.`
            });
        }

        const data = {
            status: targetStatus,
            updatedAt: new Date(),
            lastActivityAt: new Date()
        };
        if (targetStatus === 'CLOSED') data.closedAt = new Date();
        if (targetStatus === 'CANCELLED') data.cancelledAt = new Date();
        if (targetStatus === 'OPEN') {
            data.closedAt = null;
            data.cancelledAt = null;
        }

        const ticket = await prisma.ticket.update({ where: { id }, data });

        // Inject status-change event card into parent friendship chat.
        // Friendship mode only — business-mode tickets have no friendship feed.
        const eventType = targetStatus === 'OPEN' ? 'REOPENED' : targetStatus;
        let eventCard = null;
        if (ticket.friendshipId) {
            eventCard = await prisma.directMessage.create({
                data: {
                    friendshipId: ticket.friendshipId,
                    senderId: userId,
                    receiverId: ticket.creatorId === userId ? ticket.counterpartyId : ticket.creatorId,
                    content: _eventCardContent(ticket, eventType),
                    messageType: 'TICKET_LINK',
                    metadata: {
                        ticketId: ticket.id,
                        ticketName: ticket.name,
                        ticketType: ticket.type,
                        ticketStatus: ticket.status,
                        eventType,
                        targetAmount: ticket.targetAmount.toString(),
                        targetCurrency: ticket.targetCurrency
                    }
                }
            });
        }

        if (io) {
            io.to(`user_${ticket.creatorId}`).emit('ticket_status_changed', { ticket });
            io.to(`user_${ticket.counterpartyId}`).emit('ticket_status_changed', { ticket });
            if (ticket.friendshipId && eventCard) {
                io.to(`friend_chat_${ticket.friendshipId}`).emit('friend_message', {
                    ...eventCard,
                    eventCard: true
                });
            }
        }

        return res.status(200).json({ success: true, ticket });
    } catch (err) {
        console.error('[changeTicketStatus] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 6. PRESENCE PING — broadcast that the caller opened/closed the ticket window
//
// POST /api/tickets/:id/presence
// Body: { viewing: true | false }
// =============================================================================
exports.pingPresence = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const userId = req.user.id;
        const { id } = req.params;
        const viewing = req.body && req.body.viewing === true;

        const auth = await _verifyTicketParticipant(prisma, id, userId);
        if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });

        if (io) {
            const payload = {
                ticketId: id,
                friendshipId: auth.ticket.friendshipId,
                userId,
                viewing
            };
            io.to(`user_${auth.ticket.creatorId}`).emit('ticket_presence_update', payload);
            io.to(`user_${auth.ticket.counterpartyId}`).emit('ticket_presence_update', payload);
            // Business-mode tickets have no friendship feed — guard against
            // emitting to a `friend_chat_null` room.
            if (auth.ticket.friendshipId) {
                io.to(`friend_chat_${auth.ticket.friendshipId}`).emit('ticket_presence_update', payload);
            }
        }

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[pingPresence] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};
