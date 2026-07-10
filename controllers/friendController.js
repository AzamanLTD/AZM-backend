// controllers/friendController.js
// =============================================================================
// AZAMAN V3 — SOCIAL FRIEND SYSTEM CONTROLLER
//
// Handles user discovery, friend requests, and friend list management.
// Integrates with NotificationService for real-time friend request alerts.
// =============================================================================

const NotificationService = require('../services/notificationService');
const { parsePagination, buildPageEnvelope } = require('../utils/pagination');

let notificationService;
function getNotificationService(req) {
    if (!notificationService) {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        notificationService = new NotificationService(prisma, io);
    }
    return notificationService;
}

// =============================================================================
// 1. SEARCH USERS — by username or user ID
//
// GET /api/friends/search?q=<query>
// Returns matching users (excludes self, deleted accounts, sensitive fields)
// =============================================================================
exports.searchUsers = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { q } = req.query;
        const userId = req.user.id;

        if (!q || q.trim().length < 2) {
            return res.status(400).json({
                success: false,
                message: 'Search query must be at least 2 characters.'
            });
        }

        const query = q.trim();
        const isNumericQuery = /^\d+$/.test(query);

        let users = [];

        if (isNumericQuery) {
            // Search by user ID (Azaman UID)
            const userById = await prisma.user.findUnique({
                where: { id: parseInt(query) },
                select: {
                    id: true,
                    username: true,
                    profilePictureUrl: true,
                    tradesCompleted: true,
                    completionRate: true,
                    kycStatus: true,
                    isDeleted: true,
                    createdAt: true
                }
            });

            if (userById && !userById.isDeleted && userById.id !== userId) {
                users = [userById];
            }
        }

        // Also search by username (case-insensitive contains)
        const usersByUsername = await prisma.user.findMany({
            where: {
                AND: [
                    { id: { not: userId } },
                    { isDeleted: false },
                    {
                        username: {
                            contains: query,
                            mode: 'insensitive'
                        }
                    }
                ]
            },
            select: {
                id: true,
                username: true,
                profilePictureUrl: true,
                tradesCompleted: true,
                completionRate: true,
                kycStatus: true,
                createdAt: true
            },
            take: 20,
            orderBy: { username: 'asc' }
        });

        // Merge results (deduplicate)
        const userMap = new Map();
        [...users, ...usersByUsername].forEach(u => {
            if (!userMap.has(u.id)) {
                userMap.set(u.id, {
                    id: u.id,
                    username: u.username,
                    profilePictureUrl: u.profilePictureUrl,
                    tradesCompleted: u.tradesCompleted,
                    completionRate: u.completionRate,
                    isVerified: u.kycStatus === 'VERIFIED',
                    memberSince: u.createdAt
                });
            }
        });

        // Check existing friendship status with each result
        const resultUsers = Array.from(userMap.values());
        const resultIds = resultUsers.map(u => u.id);

        const existingFriendships = await prisma.friendship.findMany({
            where: {
                OR: [
                    { requesterId: userId, addresseeId: { in: resultIds } },
                    { addresseeId: userId, requesterId: { in: resultIds } }
                ]
            },
            select: {
                requesterId: true,
                addresseeId: true,
                status: true
            }
        });

        // Map friendship statuses
        const friendshipMap = new Map();
        existingFriendships.forEach(f => {
            const otherUserId = f.requesterId === userId ? f.addresseeId : f.requesterId;
            friendshipMap.set(otherUserId, {
                status: f.status,
                isSender: f.requesterId === userId
            });
        });

        const enrichedResults = resultUsers.map(u => ({
            ...u,
            friendshipStatus: friendshipMap.get(u.id)?.status || null,
            isFriendRequestSender: friendshipMap.get(u.id)?.isSender || false
        }));

        return res.status(200).json({
            success: true,
            users: enrichedResults,
            count: enrichedResults.length
        });

    } catch (error) {
        console.error('[searchUsers] error:', error.message);
        return res.status(500).json({ success: false, message: 'Search failed.' });
    }
};

// =============================================================================
// 2. SEND FRIEND REQUEST
//
// POST /api/friends/request
// Body: { addresseeId, message }
// =============================================================================
exports.sendFriendRequest = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const { addresseeId, addresseeAzamanId, message } = req.body;
        const requesterId = req.user.id;

        // PHASE 6: accept either a legacy numeric addresseeId OR an Azaman ID
        // (the find-a-user flow only knows the public AZM-######### id, never
        // the numeric User.id). Resolve azamanId → numeric id here.
        let targetId;
        if (addresseeAzamanId) {
            if (!/^AZM-\d{9}$/.test(String(addresseeAzamanId).trim())) {
                return res.status(400).json({ success: false, message: 'Invalid Azaman ID.' });
            }
            const byAzaman = await prisma.user.findUnique({
                where: { azamanId: String(addresseeAzamanId).trim() },
                select: { id: true },
            });
            if (!byAzaman) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            targetId = byAzaman.id;
        } else {
            if (!addresseeId) {
                return res.status(400).json({ success: false, message: 'addresseeId or addresseeAzamanId is required.' });
            }
            targetId = parseInt(addresseeId);
        }

        if (targetId === requesterId) {
            return res.status(400).json({ success: false, message: 'You cannot add yourself as a friend.' });
        }

        // Check target user exists and is not deleted
        const targetUser = await prisma.user.findUnique({
            where: { id: targetId },
            select: { id: true, username: true, isDeleted: true }
        });

        if (!targetUser || targetUser.isDeleted) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Check for existing friendship (in either direction)
        const existing = await prisma.friendship.findFirst({
            where: {
                OR: [
                    { requesterId: requesterId, addresseeId: targetId },
                    { requesterId: targetId, addresseeId: requesterId }
                ]
            }
        });

        if (existing) {
            if (existing.status === 'ACCEPTED') {
                return res.status(409).json({ success: false, message: 'You are already friends with this user.' });
            }
            if (existing.status === 'PENDING') {
                return res.status(409).json({ success: false, message: 'A friend request already exists between you and this user.' });
            }
            if (existing.status === 'BLOCKED') {
                return res.status(403).json({ success: false, message: 'Unable to send friend request to this user.' });
            }
            // If REJECTED, allow re-sending by updating the existing record
            if (existing.status === 'REJECTED') {
                const updated = await prisma.friendship.update({
                    where: { id: existing.id },
                    data: {
                        requesterId: requesterId,
                        addresseeId: targetId,
                        status: 'PENDING',
                        message: message || null
                    },
                    include: {
                        requester: { select: { id: true, username: true, profilePictureUrl: true } }
                    }
                });

                // Send notification
                await getNotificationService(req).sendNotification({
                    userId: targetId,
                    title: 'New Friend Request',
                    body: `${req.user.username || 'Someone'} wants to be your friend${message ? `: "${message}"` : '.'}`,
                    category: 'SOCIAL',
                    actionPayload: {
                        route: '/friends/requests',
                        action: 'OPEN_FRIEND_REQUEST',
                        friendshipId: updated.id,
                        requesterId: String(requesterId)
                    }
                });

                // Real-time socket event
                if (io) {
                    io.to(`user_${targetId}`).emit('friend_request_received', {
                        friendshipId: updated.id,
                        requester: updated.requester,
                        message: message || null,
                        createdAt: updated.updatedAt
                    });
                }

                return res.status(200).json({
                    success: true,
                    message: 'Friend request re-sent.',
                    friendship: updated
                });
            }
        }

        // Create new friendship
        const requesterUser = await prisma.user.findUnique({
            where: { id: requesterId },
            select: { id: true, username: true, profilePictureUrl: true }
        });

        const friendship = await prisma.friendship.create({
            data: {
                requesterId: requesterId,
                addresseeId: targetId,
                message: message || null,
                status: 'PENDING'
            },
            include: {
                requester: { select: { id: true, username: true, profilePictureUrl: true } },
                addressee: { select: { id: true, username: true, profilePictureUrl: true } }
            }
        });

        // Send notification to addressee
        await getNotificationService(req).sendNotification({
            userId: targetId,
            title: 'New Friend Request',
            body: `${requesterUser.username} wants to be your friend${message ? `: "${message}"` : '.'}`,
            category: 'SOCIAL',
            actionPayload: {
                route: '/friends/requests',
                action: 'OPEN_FRIEND_REQUEST',
                friendshipId: friendship.id,
                requesterId: String(requesterId)
            }
        });

        // Real-time socket event
        if (io) {
            io.to(`user_${targetId}`).emit('friend_request_received', {
                friendshipId: friendship.id,
                requester: friendship.requester,
                message: message || null,
                createdAt: friendship.createdAt
            });
        }

        return res.status(201).json({
            success: true,
            message: 'Friend request sent successfully.',
            friendship
        });

    } catch (error) {
        console.error('[sendFriendRequest] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 3. GET PENDING FRIEND REQUESTS (incoming)
//
// GET /api/friends/requests
// =============================================================================
exports.getPendingRequests = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const skip = (page - 1) * limit;

        const [requests, total] = await Promise.all([
            prisma.friendship.findMany({
                where: {
                    addresseeId: userId,
                    status: 'PENDING'
                },
                include: {
                    requester: {
                        select: {
                            id: true,
                            username: true,
                            profilePictureUrl: true,
                            tradesCompleted: true,
                            completionRate: true,
                            kycStatus: true,
                            createdAt: true
                        }
                    }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.friendship.count({
                where: { addresseeId: userId, status: 'PENDING' }
            })
        ]);

        // Enrich with isVerified flag
        const enriched = requests.map(r => ({
            ...r,
            requester: {
                ...r.requester,
                isVerified: r.requester.kycStatus === 'VERIFIED'
            }
        }));

        return res.status(200).json({
            success: true,
            requests: enriched,
            total,
            page,
            limit
        });

    } catch (error) {
        console.error('[getPendingRequests] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch requests.' });
    }
};

// =============================================================================
// 4. GET SENT FRIEND REQUESTS (outgoing)
//
// GET /api/friends/requests/sent
// =============================================================================
exports.getSentRequests = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const requests = await prisma.friendship.findMany({
            where: {
                requesterId: userId,
                status: 'PENDING'
            },
            include: {
                addressee: {
                    select: {
                        id: true,
                        username: true,
                        profilePictureUrl: true,
                        tradesCompleted: true,
                        completionRate: true,
                        kycStatus: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        return res.status(200).json({
            success: true,
            requests
        });

    } catch (error) {
        console.error('[getSentRequests] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch sent requests.' });
    }
};

// =============================================================================
// 5. ACCEPT FRIEND REQUEST
//
// PUT /api/friends/request/:id/accept
// =============================================================================
exports.acceptFriendRequest = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const { id } = req.params;
        const userId = req.user.id;

        const friendship = await prisma.friendship.findUnique({
            where: { id },
            include: {
                requester: { select: { id: true, username: true, profilePictureUrl: true } },
                addressee: { select: { id: true, username: true, profilePictureUrl: true } }
            }
        });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Friend request not found.' });
        }

        if (friendship.addresseeId !== userId) {
            return res.status(403).json({ success: false, message: 'You can only accept requests sent to you.' });
        }

        if (friendship.status !== 'PENDING') {
            return res.status(409).json({ success: false, message: `Request is already ${friendship.status.toLowerCase()}.` });
        }

        const updated = await prisma.friendship.update({
            where: { id },
            data: { status: 'ACCEPTED' },
            include: {
                requester: { select: { id: true, username: true, profilePictureUrl: true } },
                addressee: { select: { id: true, username: true, profilePictureUrl: true } }
            }
        });

        // Notify the requester that their request was accepted
        await getNotificationService(req).sendNotification({
            userId: friendship.requesterId,
            title: 'Friend Request Accepted',
            body: `${friendship.addressee.username} accepted your friend request! You can now chat and transfer funds.`,
            category: 'SOCIAL',
            actionPayload: {
                route: `/friends/chat/${friendship.id}`,
                action: 'OPEN_FRIEND_CHAT',
                friendshipId: friendship.id,
                friendId: String(userId)
            }
        });

        // Real-time event to requester
        if (io) {
            io.to(`user_${friendship.requesterId}`).emit('friend_request_accepted', {
                friendshipId: friendship.id,
                friend: friendship.addressee
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Friend request accepted.',
            friendship: updated
        });

    } catch (error) {
        console.error('[acceptFriendRequest] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 6. REJECT FRIEND REQUEST
//
// PUT /api/friends/request/:id/reject
// =============================================================================
exports.rejectFriendRequest = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { id } = req.params;
        const userId = req.user.id;

        const friendship = await prisma.friendship.findUnique({ where: { id } });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Friend request not found.' });
        }

        if (friendship.addresseeId !== userId) {
            return res.status(403).json({ success: false, message: 'You can only reject requests sent to you.' });
        }

        if (friendship.status !== 'PENDING') {
            return res.status(409).json({ success: false, message: `Request is already ${friendship.status.toLowerCase()}.` });
        }

        const updated = await prisma.friendship.update({
            where: { id },
            data: { status: 'REJECTED' }
        });

        return res.status(200).json({
            success: true,
            message: 'Friend request rejected.',
            friendship: updated
        });

    } catch (error) {
        console.error('[rejectFriendRequest] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 7. GET FRIENDS LIST (accepted friendships)
//
// GET /api/friends?cursor=<friendshipId>&limit=20
//
// Phase I:
//   - Cursor pagination by Friendship.id (UUID), order by Friendship.updatedAt
//     DESC. Note that updatedAt is mutated by every direct message and peer
//     transfer (directMessageController + friendSocketService + peerTransferController),
//     so a friend whose updatedAt bumps mid-pagination can be skipped or
//     duplicated across pages. Friend-list scale (rarely > 1 page) makes this
//     a non-issue in practice; flagged here for future readers.
//   - The N+1 latestMessage / unreadCount loop is replaced with two batched
//     aggregations: one Prisma `findMany` with `distinct: ['friendshipId']`
//     for latest messages, and one `groupBy` for unread counts. Two queries
//     total instead of 2*N.
//   - Friend payload is an explicit projection (id, username, profilePictureUrl,
//     tradesCompleted, completionRate, kycStatus, isVerified). Same fields the
//     old `select` returned; only the spread-style construction changed.
// =============================================================================
exports.getFriends = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { take, cursor, mode, page } = parsePagination(req.query);

        const friendships = await prisma.friendship.findMany({
            where: {
                status: 'ACCEPTED',
                OR: [
                    { requesterId: userId },
                    { addresseeId: userId }
                ]
            },
            include: {
                requester: {
                    select: {
                        id: true,
                        username: true,
                        profilePictureUrl: true,
                        tradesCompleted: true,
                        completionRate: true,
                        positiveReviews: true,
                        negativeReviews: true,
                        kycStatus: true,
                        role: true
                    }
                },
                addressee: {
                    select: {
                        id: true,
                        username: true,
                        profilePictureUrl: true,
                        tradesCompleted: true,
                        completionRate: true,
                        positiveReviews: true,
                        negativeReviews: true,
                        kycStatus: true,
                        role: true
                    }
                }
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take,
            ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {})
        });

        // ── Two-query enrichment (was 2N before Phase I) ──────────────────
        let enriched = [];
        if (friendships.length > 0) {
            const friendshipIds = friendships.map(f => f.id);

            // distinct on friendshipId returns one row per friendship — the
            // newest, because we order by createdAt DESC. Postgres uses
            // DirectMessage_friendshipId_createdAt_idx for this.
            const latestMessagesPromise = prisma.directMessage.findMany({
                where: { friendshipId: { in: friendshipIds } },
                orderBy: [{ friendshipId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
                distinct: ['friendshipId'],
                select: {
                    friendshipId: true,
                    content: true,
                    messageType: true,
                    createdAt: true,
                    senderId: true
                }
            });

            // groupBy aggregates unread counts in a single query.
            const unreadCountsPromise = prisma.directMessage.groupBy({
                by: ['friendshipId'],
                where: {
                    friendshipId: { in: friendshipIds },
                    receiverId: userId,
                    isRead: false
                },
                _count: { _all: true }
            });

            const [latestMessages, unreadCounts] = await Promise.all([
                latestMessagesPromise,
                unreadCountsPromise
            ]);

            const latestByFriendship = new Map(latestMessages.map(m => [m.friendshipId, m]));
            const unreadByFriendship = new Map(unreadCounts.map(u => [u.friendshipId, u._count._all]));

            // ── Phase UI-7 (2026-05-27): batched trust-metric aggregates ─────
            // Compute the GLOBAL completedTransactions count per friend in
            // four indexed groupBy queries (independent of N — page-size of
            // 20 still costs 4 queries, not 4×N). Sums:
            //   tradesCompleted               (already on the User row)
            //   PeerTransfer status=COMPLETED (sent OR received by friend)
            //   Ticket       status=CLOSED   (creator OR counterparty)
            // Each Map keys by friend.id so the per-row enrichment is O(1).
            const friendIds = friendships
                .map(f => (f.requesterId === userId ? f.addresseeId : f.requesterId))
                .filter(id => Number.isInteger(id));

            let transferSentByFriend = new Map();
            let transferReceivedByFriend = new Map();
            let ticketCreatedByFriend = new Map();
            let ticketCounterByFriend = new Map();

            if (friendIds.length > 0) {
                const [
                    sentTransfers,
                    receivedTransfers,
                    createdTickets,
                    counterTickets
                ] = await Promise.all([
                    prisma.peerTransfer.groupBy({
                        by: ['senderId'],
                        where: { senderId: { in: friendIds }, status: 'COMPLETED' },
                        _count: { _all: true }
                    }).catch(() => []),
                    prisma.peerTransfer.groupBy({
                        by: ['receiverId'],
                        where: { receiverId: { in: friendIds }, status: 'COMPLETED' },
                        _count: { _all: true }
                    }).catch(() => []),
                    prisma.ticket.groupBy({
                        by: ['creatorId'],
                        where: { creatorId: { in: friendIds }, status: 'CLOSED' },
                        _count: { _all: true }
                    }).catch(() => []),
                    prisma.ticket.groupBy({
                        by: ['counterpartyId'],
                        where: { counterpartyId: { in: friendIds }, status: 'CLOSED' },
                        _count: { _all: true }
                    }).catch(() => [])
                ]);

                transferSentByFriend = new Map(
                    sentTransfers.map(t => [t.senderId, t._count._all])
                );
                transferReceivedByFriend = new Map(
                    receivedTransfers.map(t => [t.receiverId, t._count._all])
                );
                ticketCreatedByFriend = new Map(
                    createdTickets.map(t => [t.creatorId, t._count._all])
                );
                ticketCounterByFriend = new Map(
                    counterTickets.map(t => [t.counterpartyId, t._count._all])
                );
            }

            enriched = friendships.map(f => {
                const friend = f.requesterId === userId ? f.addressee : f.requester;
                const latest = latestByFriendship.get(f.id);

                // Phase UI-7: trust signals computed from the batched maps.
                const transfersCount =
                    (transferSentByFriend.get(friend.id) || 0) +
                    (transferReceivedByFriend.get(friend.id) || 0);
                const ticketsCount =
                    (ticketCreatedByFriend.get(friend.id) || 0) +
                    (ticketCounterByFriend.get(friend.id) || 0);
                const completedTransactions =
                    (friend.tradesCompleted || 0) + transfersCount + ticketsCount;

                const reviewTotal =
                    (friend.positiveReviews || 0) + (friend.negativeReviews || 0);
                const rating = reviewTotal === 0
                    ? null
                    : Number((((friend.positiveReviews || 0) / reviewTotal) * 5).toFixed(1));

                const isVerifiedVendor =
                    friend.role === 'VENDOR' && friend.kycStatus === 'VERIFIED';

                return {
                    friendshipId: f.id,
                    id: f.id, // for cursor envelope
                    friend: {
                        id: friend.id,
                        username: friend.username,
                        profilePictureUrl: friend.profilePictureUrl,
                        tradesCompleted: friend.tradesCompleted,
                        completionRate: friend.completionRate,
                        // kycStatus retained for FE consumers that distinguish
                        // PENDING vs REJECTED vs VERIFIED. isVerified is the
                        // derived boolean for callers that only need the dot.
                        kycStatus: friend.kycStatus,
                        isVerified: friend.kycStatus === 'VERIFIED',
                        // Phase UI-7: chat-list trust signals so the row can
                        // render the same metric the chat AppBar surfaces.
                        role: friend.role,
                        completedTransactions,
                        rating,
                        isVerifiedVendor
                    },
                    latestMessage: latest ? {
                        content: latest.messageType === 'TEXT'
                            ? latest.content
                            : `[${latest.messageType.replace(/_/g, ' ')}]`,
                        createdAt: latest.createdAt,
                        isFromMe: latest.senderId === userId
                    } : null,
                    unreadCount: unreadByFriendship.get(f.id) || 0,
                    friendSince: f.createdAt
                };
            });
        }

        const envelope = buildPageEnvelope(enriched, take, mode, page);

        return res.status(200).json({
            success: true,
            friends: enriched,
            count: enriched.length,
            ...envelope
        });

    } catch (error) {
        console.error('[getFriends] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch friends.' });
    }
};

// =============================================================================
// 8. REMOVE FRIEND
//
// DELETE /api/friends/:id
// =============================================================================
exports.removeFriend = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { id } = req.params;
        const userId = req.user.id;

        const friendship = await prisma.friendship.findUnique({ where: { id } });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Friendship not found.' });
        }

        // Only participants can remove the friendship
        if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        await prisma.friendship.delete({ where: { id } });

        return res.status(200).json({
            success: true,
            message: 'Friend removed successfully.'
        });

    } catch (error) {
        console.error('[removeFriend] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 9. GET FRIEND PROFILE (detailed view for request review)
//
// GET /api/friends/profile/:userId
// =============================================================================
exports.getFriendProfile = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const targetId = parseInt(req.params.userId);
        if (isNaN(targetId)) {
            return res.status(400).json({ success: false, message: 'Invalid user ID.' });
        }

        const user = await prisma.user.findUnique({
            where: { id: targetId },
            select: {
                id: true,
                username: true,
                profilePictureUrl: true,
                tradesCompleted: true,
                completionRate: true,
                positiveReviews: true,
                negativeReviews: true,
                kycStatus: true,
                loyaltyTier: true,
                createdAt: true,
                isDeleted: true
            }
        });

        if (!user || user.isDeleted) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        return res.status(200).json({
            success: true,
            profile: {
                id: user.id,
                username: user.username,
                profilePictureUrl: user.profilePictureUrl,
                tradesCompleted: user.tradesCompleted,
                completionRate: user.completionRate,
                positiveReviews: user.positiveReviews,
                negativeReviews: user.negativeReviews,
                isVerified: user.kycStatus === 'VERIFIED',
                loyaltyTier: user.loyaltyTier,
                memberSince: user.createdAt
            }
        });

    } catch (error) {
        console.error('[getFriendProfile] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
    }
};
