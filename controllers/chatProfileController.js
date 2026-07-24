// =============================================================================
// CHAT PROFILE + VAULT CONTROLLER — Phase UI-5 (2026-05-26)
//
// Powers the "Chat Profile Detail" screen reachable by tapping a friend's
// avatar inside any chat surface. Five endpoints, all scoped to a single
// friendship and gated to participant-only access.
//
//   • GET   /api/friends/:friendshipId/profile           — identity tier + my nickname
//   • PATCH /api/friends/:friendshipId/nickname          — set/clear my nickname for the friend
//   • GET   /api/friends/:friendshipId/media             — paginated images + videos (vault tab 1)
//   • GET   /api/friends/:friendshipId/docs-links        — paginated documents + link previews (vault tab 2)
//   • GET   /api/friends/:friendshipId/receipts          — paginated immutable P2P transfer receipts (vault tab 4)
//
// (Vault tab 3 — Tickets — is served by the existing GET /api/tickets
// endpoint with friendshipId query param.)
//
// Receipts are defined as immutable records of direct P2P off-ticket money
// transfers — the "send money with a tracking reason" flow already shipped
// as PeerTransfer. The vault surfaces them as first-class transaction
// artifacts with reference IDs and PDF download URLs (powered by
// receiptService.generateTransferReceipt).
// =============================================================================

const VALID_MEDIA_TYPES = new Set(['IMAGE', 'VIDEO']);

async function _verifyParticipant(prisma, friendshipId, userId) {
    const friendship = await prisma.friendship.findUnique({
        where: { id: friendshipId },
        select: {
            id: true,
            requesterId: true,
            addresseeId: true,
            status: true,
            createdAt: true,
            localNicknames: true
        }
    });
    if (!friendship) {
        return { ok: false, code: 404, message: 'Friendship not found.' };
    }
    if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
        return { ok: false, code: 403, message: 'Not a participant in this friendship.' };
    }
    const friendId = friendship.requesterId === userId
        ? friendship.addresseeId
        : friendship.requesterId;
    return { ok: true, friendship, friendId };
}

// =============================================================================
// 1. GET PROFILE — identity tier (friend's username, avatar, KYC, mutual stats)
//                  + caller's local nickname for this friend.
//
// GET /api/friends/:friendshipId/profile
// =============================================================================
exports.getProfile = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { friendshipId } = req.params;
        const auth = await _verifyParticipant(prisma, friendshipId, userId);
        if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });

        const friend = await prisma.user.findUnique({
            where: { id: auth.friendId },
            select: {
                id: true,
                username: true,
                profilePictureUrl: true,
                kycStatus: true,
                role: true,
                tradesCompleted: true,
                completionRate: true,
                positiveReviews: true,
                negativeReviews: true,
                loyaltyTier: true,
                createdAt: true
            }
        });
        if (!friend) {
            return res.status(404).json({ success: false, message: 'Friend not found.' });
        }

        // Mutual P2P trade count (where both parties were participants).
        // Lightweight: counts Trades whose user is one of us and vendor is the other.
        const mutualTrades = await prisma.trade.count({
            where: {
                OR: [
                    { userId: userId, vendor: { userId: auth.friendId } },
                    { userId: auth.friendId, vendor: { userId: userId } }
                ],
                status: 'COMPLETED'
            }
        }).catch(() => 0);

        // ── Phase UI-6 (2026-05-27): Social Trust Metrics ───────────────────
        // The chat header shows a persistent "⭐ rating · N Completed
        // Transactions" line under the contact's name. The metric is
        // GLOBAL (not just P2P trades) — the brief is explicit that
        // both users and vendors play critical roles in successful
        // transactions, so we aggregate every kind of transaction
        // commitment a user closes:
        //
        //   tradesCompleted               (P2P escrow trades)
        //   PeerTransfer status=COMPLETED (off-ticket money transfers)
        //   Ticket       status=CLOSED    (deal-tracking workspaces)
        //
        // Each of the three counts is computed in parallel with one cheap
        // query, falling back to 0 on any individual failure so a count
        // outage never blocks the profile screen from rendering.
        const [completedTransfers, closedTickets] = await Promise.all([
            prisma.peerTransfer.count({
                where: {
                    status: 'COMPLETED',
                    OR: [
                        { senderId: auth.friendId },
                        { receiverId: auth.friendId }
                    ]
                }
            }).catch(() => 0),
            prisma.ticket.count({
                where: {
                    status: 'CLOSED',
                    OR: [
                        { creatorId: auth.friendId },
                        { counterpartyId: auth.friendId }
                    ]
                }
            }).catch(() => 0)
        ]);

        const completedTransactions =
            (friend.tradesCompleted || 0) +
            (completedTransfers || 0) +
            (closedTickets || 0);

        // Rating: 5-star scale derived from positive vs negative reviews.
        // Returns null when the friend has no reviews so the FE can
        // suppress the star icon entirely (a 0.0 star next to a brand
        // new account is misleading).
        const totalReviews =
            (friend.positiveReviews || 0) + (friend.negativeReviews || 0);
        const rating = totalReviews === 0
            ? null
            : Number((((friend.positiveReviews || 0) / totalReviews) * 5).toFixed(1));

        const isVerifiedVendor =
            friend.role === 'VENDOR' && friend.kycStatus === 'VERIFIED';

        const localNicknames = auth.friendship.localNicknames || {};
        const myNickname = localNicknames[String(userId)] || null;

        return res.status(200).json({
            success: true,
            profile: {
                friendshipId,
                friendSince: auth.friendship.createdAt,
                friendshipStatus: auth.friendship.status,
                friend: {
                    ...friend,
                    // Phase UI-6: pre-computed trust signals so the chat
                    // header has no FE-side aggregation work to do.
                    completedTransactions,
                    // Phase UI-7 (2026-05-27): expose the per-category
                    // breakdown so the vault identity-tier card and the
                    // AppBar tap-popup can share one source of truth.
                    completedTransactionsBreakdown: {
                        tradesCompleted: friend.tradesCompleted || 0,
                        completedTransfers: completedTransfers || 0,
                        closedTickets: closedTickets || 0
                    },
                    rating,
                    isVerifiedVendor
                },
                myNicknameForFriend: myNickname,
                mutualTradesCompleted: mutualTrades
            }
        });
    } catch (err) {
        logger.error({ err: err }, '[chatProfile.getProfile] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 2. PATCH NICKNAME — set / update / clear caller's local nickname for the friend.
//
// PATCH /api/friends/:friendshipId/nickname
// Body: { nickname: string|null }   // null or empty string clears
// =============================================================================
exports.setNickname = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { friendshipId } = req.params;
        let { nickname } = req.body || {};

        const auth = await _verifyParticipant(prisma, friendshipId, userId);
        if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });

        if (typeof nickname === 'string') {
            nickname = nickname.trim();
            if (nickname.length > 40) {
                return res.status(400).json({
                    success: false,
                    message: 'Nickname must be 40 characters or fewer.'
                });
            }
            if (nickname.length === 0) nickname = null;
        } else if (nickname !== null) {
            return res.status(400).json({
                success: false,
                message: 'nickname must be a string or null.'
            });
        }

        const current = auth.friendship.localNicknames || {};
        const updated = { ...current };
        const key = String(userId);
        if (nickname === null) {
            delete updated[key];
        } else {
            updated[key] = nickname;
        }

        await prisma.friendship.update({
            where: { id: friendshipId },
            data: { localNicknames: updated }
        });

        return res.status(200).json({
            success: true,
            nickname,
            myNicknameForFriend: nickname
        });
    } catch (err) {
        logger.error({ err: err }, '[chatProfile.setNickname] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 3. GET MEDIA — chronological images + videos from DirectMessage AND
//                TicketMessage (both sources of vault content for this thread).
//
// GET /api/friends/:friendshipId/media?type=IMAGE|VIDEO&cursor=&limit=
// =============================================================================
exports.getMedia = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { friendshipId } = req.params;
        const auth = await _verifyParticipant(prisma, friendshipId, userId);
        if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });

        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const typeFilter = req.query.type ? String(req.query.type).toUpperCase() : null;

        let typeIn;
        if (typeFilter && VALID_MEDIA_TYPES.has(typeFilter)) {
            typeIn = [typeFilter];
        } else {
            typeIn = Array.from(VALID_MEDIA_TYPES);
        }

        // ── DirectMessage source ────────────────────────────────────────────
        const directRows = await prisma.directMessage.findMany({
            where: {
                friendshipId,
                messageType: { in: typeIn }
            },
            orderBy: { createdAt: 'desc' },
            take: limit
        });

        // ── TicketMessage source ────────────────────────────────────────────
        // All tickets under this friendship (any status — vault is historical).
        const ticketIds = (await prisma.ticket.findMany({
            where: { friendshipId },
            select: { id: true }
        })).map((t) => t.id);

        const ticketRows = ticketIds.length === 0 ? [] : await prisma.ticketMessage.findMany({
            where: {
                ticketId: { in: ticketIds },
                type: { in: typeIn }
            },
            orderBy: { createdAt: 'desc' },
            take: limit
        });

        // ── Merge + sort by createdAt DESC ──────────────────────────────────
        const merged = [
            ...directRows.map((r) => ({
                source: 'DIRECT',
                id: r.id,
                friendshipId,
                ticketId: null,
                senderId: r.senderId,
                type: r.messageType,
                mediaUrl: r.mediaUrl,
                mediaType: r.mediaType,
                mediaMimeType: r.mediaMimeType,
                mediaSize: r.mediaSize,
                mediaDuration: r.mediaDuration,
                createdAt: r.createdAt
            })),
            ...ticketRows.map((r) => ({
                source: 'TICKET',
                id: r.id,
                friendshipId,
                ticketId: r.ticketId,
                senderId: r.senderId,
                type: r.type,
                mediaUrl: r.mediaUrl,
                mediaType: r.mediaType,
                mediaMimeType: r.mediaMimeType,
                mediaSize: r.mediaSize,
                mediaDuration: r.mediaDuration,
                createdAt: r.createdAt
            }))
        ]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);

        return res.status(200).json({
            success: true,
            items: merged,
            count: merged.length
        });
    } catch (err) {
        logger.error({ err: err }, '[chatProfile.getMedia] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 4. GET DOCS & LINKS — chronological documents + link previews from both
//                       DirectMessage AND TicketMessage.
//
// GET /api/friends/:friendshipId/docs-links?limit=
// =============================================================================
exports.getDocsAndLinks = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { friendshipId } = req.params;
        const auth = await _verifyParticipant(prisma, friendshipId, userId);
        if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });

        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const typeIn = ['DOCUMENT', 'LINK'];

        const directRows = await prisma.directMessage.findMany({
            where: { friendshipId, messageType: { in: typeIn } },
            orderBy: { createdAt: 'desc' },
            take: limit
        });

        const ticketIds = (await prisma.ticket.findMany({
            where: { friendshipId },
            select: { id: true }
        })).map((t) => t.id);

        const ticketRows = ticketIds.length === 0 ? [] : await prisma.ticketMessage.findMany({
            where: { ticketId: { in: ticketIds }, type: { in: typeIn } },
            orderBy: { createdAt: 'desc' },
            take: limit
        });

        const merged = [
            ...directRows.map((r) => ({
                source: 'DIRECT',
                id: r.id,
                friendshipId,
                ticketId: null,
                senderId: r.senderId,
                type: r.messageType,
                content: r.content,                    // for LINK type, this is the URL
                mediaUrl: r.mediaUrl,
                mediaMimeType: r.mediaMimeType,
                mediaSize: r.mediaSize,
                linkPreview: r.linkPreview,
                createdAt: r.createdAt
            })),
            ...ticketRows.map((r) => ({
                source: 'TICKET',
                id: r.id,
                friendshipId,
                ticketId: r.ticketId,
                senderId: r.senderId,
                type: r.type,
                content: r.content,
                mediaUrl: r.mediaUrl,
                mediaMimeType: r.mediaMimeType,
                mediaSize: r.mediaSize,
                linkPreview: r.linkPreview,
                createdAt: r.createdAt
            }))
        ]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);

        return res.status(200).json({
            success: true,
            items: merged,
            count: merged.length
        });
    } catch (err) {
        logger.error({ err: err }, '[chatProfile.getDocsAndLinks] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 5. GET RECEIPTS — paginated PeerTransfer history between the two friends.
//
// Receipts are immutable records of direct P2P off-ticket money transfers.
// Source: PeerTransfer rows (any status). The FE typically filters to
// COMPLETED for the polished receipt vault tab; we ship every status here so
// the FE can render pending / declined ones in a "transactions" sub-tab if it
// wants to.
//
// GET /api/friends/:friendshipId/receipts?status=&cursor=&limit=
// =============================================================================
exports.getReceipts = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { friendshipId } = req.params;
        const auth = await _verifyParticipant(prisma, friendshipId, userId);
        if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });

        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const cursor = req.query.cursor || null;
        const status = req.query.status ? String(req.query.status).toUpperCase() : null;

        const where = { friendshipId };
        if (status) where.status = status;

        const transfers = await prisma.peerTransfer.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit + 1,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            include: {
                sender: { select: { id: true, username: true, profilePictureUrl: true } },
                receiver: { select: { id: true, username: true, profilePictureUrl: true } }
            }
        });

        const hasMore = transfers.length > limit;
        const slice = hasMore ? transfers.slice(0, limit) : transfers;
        const nextCursor = hasMore ? slice[slice.length - 1].id : null;

        // Project into a receipt-shaped row with direction relative to caller.
        const items = slice.map((t) => {
            const direction = t.senderId === userId ? 'SENT' : 'RECEIVED';
            return {
                id: t.id,
                friendshipId: t.friendshipId,
                amount: t.amount.toString(),
                currency: t.currency,
                reference: t.reference || null,
                type: t.type,
                status: t.status,
                direction,
                counterparty: direction === 'SENT' ? t.receiver : t.sender,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt,
                downloadUrl: t.status === 'COMPLETED'
                    ? `/api/receipts/transfer/${t.id}`
                    : null
            };
        });

        return res.status(200).json({
            success: true,
            items,
            count: items.length,
            hasMore,
            nextCursor
        });
    } catch (err) {
        logger.error({ err: err }, '[chatProfile.getReceipts] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};


// =============================================================================
// 6. GET TRUST METRICS — Phase UI-6 (2026-05-27)
//
// Lightweight subset of getProfile, dedicated to the chat AppBar trust line.
// Returns ONLY the fields the persistent header subtitle needs:
//
//   ⭐ {rating} · {completedTransactions} Completed Transactions   (+ verified ✓)
//
// Rationale: getProfile is the right call for the full vault screen, but the
// chat header opens far more often (every time a user enters a chat) and
// shouldn't pay for the mutual-trades aggregation, the nickname JSON pluck,
// or the friendship status round-trip. This endpoint is two parallel COUNTs
// plus one User row.
//
// GET /api/friends/:friendshipId/trust-metrics
//
// Response:
//   { success: true, metrics: {
//        completedTransactions: number,
//        rating: number | null,            // 5-star scale, null when no reviews
//        positiveReviews: number,
//        negativeReviews: number,
//        isVerifiedVendor: boolean,
//        kycStatus: string
//   }}
// =============================================================================
exports.getTrustMetrics = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { friendshipId } = req.params;
        const auth = await _verifyParticipant(prisma, friendshipId, userId);
        if (!auth.ok) {
            return res.status(auth.code).json({ success: false, message: auth.message });
        }

        const friend = await prisma.user.findUnique({
            where: { id: auth.friendId },
            select: {
                id: true,
                role: true,
                kycStatus: true,
                tradesCompleted: true,
                positiveReviews: true,
                negativeReviews: true
            }
        });
        if (!friend) {
            return res.status(404).json({ success: false, message: 'Friend not found.' });
        }

        const [completedTransfers, closedTickets] = await Promise.all([
            prisma.peerTransfer.count({
                where: {
                    status: 'COMPLETED',
                    OR: [
                        { senderId: auth.friendId },
                        { receiverId: auth.friendId }
                    ]
                }
            }).catch(() => 0),
            prisma.ticket.count({
                where: {
                    status: 'CLOSED',
                    OR: [
                        { creatorId: auth.friendId },
                        { counterpartyId: auth.friendId }
                    ]
                }
            }).catch(() => 0)
        ]);

        const completedTransactions =
            (friend.tradesCompleted || 0) +
            (completedTransfers || 0) +
            (closedTickets || 0);

        const totalReviews =
            (friend.positiveReviews || 0) + (friend.negativeReviews || 0);
        const rating = totalReviews === 0
            ? null
            : Number((((friend.positiveReviews || 0) / totalReviews) * 5).toFixed(1));

        return res.status(200).json({
            success: true,
            metrics: {
                completedTransactions,
                // Phase UI-7 (2026-05-27): expose the per-category breakdown
                // so the chat AppBar can drive a tap-to-detail popup without
                // a second round-trip. Same numbers we just summed above —
                // returning them individually means the FE never has to
                // approximate.
                breakdown: {
                    tradesCompleted: friend.tradesCompleted || 0,
                    completedTransfers: completedTransfers || 0,
                    closedTickets: closedTickets || 0
                },
                rating,
                positiveReviews: friend.positiveReviews || 0,
                negativeReviews: friend.negativeReviews || 0,
                isVerifiedVendor:
                    friend.role === 'VENDOR' && friend.kycStatus === 'VERIFIED',
                kycStatus: friend.kycStatus
            }
        });
    } catch (err) {
        logger.error({ err: err }, '[chatProfile.getTrustMetrics] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};
