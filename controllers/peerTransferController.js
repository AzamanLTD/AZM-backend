// controllers/peerTransferController.js
// =============================================================================
// AZAMAN V3 — PEER TRANSFER CONTROLLER
//
// Handles in-chat fund transfers between friends:
//   - SEND: Instantly deducts sender balance and credits receiver
//   - REQUEST: Creates a pending request; receiver must slide-to-confirm
//   - FULFILL: Recipient confirms a request (slide-to-confirm on frontend)
//   - DECLINE: Recipient rejects a fund request
//
// All transfers create DirectMessage records for in-chat visibility and
// TransactionHistory records for the unified ledger.
// =============================================================================

const NotificationService = require('../services/notificationService');

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
// 1. SEND FUNDS — Instantly transfer funds to a friend
//
// POST /api/friends/transfer/send
// Body: { friendshipId, amount, reference, clientRequestId? }
//
// Idempotency:
//   The client SHOULD pass a stable UUID v4 in `clientRequestId` (or the
//   `X-Idempotency-Key` header). It is used to derive the unique TxHash on
//   the sender's TransactionHistory row, so a flaky-network retry will hit
//   the @unique txHash constraint and return the original outcome instead
//   of double-charging the user. If no key is supplied a server-generated
//   one is used (no idempotency guarantee for that legacy caller).
// =============================================================================
exports.sendFunds = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const { friendshipId, amount, reference, clientRequestId } = req.body;
        const senderId = req.user.id;
        const idempotencyKey =
            clientRequestId ||
            req.headers['x-idempotency-key'] ||
            `srv_${senderId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const senderTxHash   = `PEER_SEND_${idempotencyKey}`;
        const receiverTxHash = `PEER_RECV_${idempotencyKey}`;

        // Validation
        if (!friendshipId || !amount) {
            return res.status(400).json({
                success: false,
                message: 'friendshipId and amount are required.'
            });
        }

        const transferAmount = parseFloat(amount);
        if (isNaN(transferAmount) || transferAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Amount must be a positive number.'
            });
        }

        // ── Idempotency replay check ─────────────────────────────────────────
        // If we already saw this clientRequestId, return the prior outcome
        // instead of mutating balances a second time.
        const prior = await prisma.transactionHistory.findUnique({
            where: { txHash: senderTxHash }
        });
        if (prior) {
            const priorTransfer = await prisma.peerTransfer.findFirst({
                where: { senderId, friendshipId, amount: transferAmount, type: 'SEND' },
                orderBy: { createdAt: 'desc' }
            });
            return res.status(200).json({
                success: true,
                message: 'Transfer already processed (idempotent replay).',
                idempotent: true,
                transfer: priorTransfer
            });
        }


        // Verify friendship
        const friendship = await prisma.friendship.findUnique({
            where: { id: friendshipId },
            select: { requesterId: true, addresseeId: true, status: true }
        });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Friendship not found.' });
        }
        if (friendship.status !== 'ACCEPTED') {
            return res.status(403).json({ success: false, message: 'You can only transfer to accepted friends.' });
        }
        if (friendship.requesterId !== senderId && friendship.addresseeId !== senderId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        const receiverId = friendship.requesterId === senderId
            ? friendship.addresseeId
            : friendship.requesterId;

        // ACID transaction: check balance, debit sender, credit receiver
        const result = await prisma.$transaction(async (tx) => {
            const sender = await tx.user.findUnique({
                where: { id: senderId },
                select: { availableBalance: true, username: true, equippedCardSkin: true }
            });

            if (!sender) throw new Error('Sender not found.');
            if (sender.availableBalance < transferAmount) {
                throw new Error('INSUFFICIENT_FUNDS');
            }


            // Debit sender
            await tx.user.update({
                where: { id: senderId },
                data: { availableBalance: { decrement: transferAmount } }
            });

            // Credit receiver
            await tx.user.update({
                where: { id: receiverId },
                data: { availableBalance: { increment: transferAmount } }
            });

            // Create PeerTransfer record
            const transfer = await tx.peerTransfer.create({
                data: {
                    friendshipId,
                    senderId,
                    receiverId,
                    amount: transferAmount,
                    currency: 'USDC',
                    reference: reference || null,
                    type: 'SEND',
                    status: 'COMPLETED'
                }
            });

            // Create TransactionHistory for both parties
            // Use the pre-allocated idempotency keys so a retry of this
            // request hits the @unique txHash constraint and is rejected
            // BEFORE any duplicate balance mutation can commit.
            await tx.transactionHistory.create({
                data: {
                    userId: senderId,
                    type: 'INTERNAL_TRANSFER',
                    amountUsdc: transferAmount,
                    feeUsdc: 0,
                    txHash: senderTxHash,
                    status: 'COMPLETED'
                }
            });


            await tx.transactionHistory.create({
                data: {
                    userId: receiverId,
                    type: 'INTERNAL_TRANSFER',
                    amountUsdc: transferAmount,
                    feeUsdc: 0,
                    txHash: receiverTxHash,
                    status: 'COMPLETED'
                }
            });

            // Create DirectMessage to show in chat
            const chatMessage = await tx.directMessage.create({
                data: {
                    friendshipId,
                    senderId,
                    receiverId,
                    content: `Sent ${transferAmount.toFixed(2)} USDC`,
                    messageType: 'TRANSFER_SENT',
                    metadata: {
                        transferId: transfer.id,
                        amount: transferAmount,
                        currency: 'USDC',
                        reference: reference || null,
                        status: 'COMPLETED',
                        cardSkin: sender.equippedCardSkin
                    }
                },
                include: {
                    sender: { select: { id: true, username: true, profilePictureUrl: true } }
                }
            });

            return { transfer, chatMessage, senderUsername: sender.username };
        });


        // Post-commit: emit balance updates
        if (emitBalanceUpdate) {
            await emitBalanceUpdate(senderId);
            await emitBalanceUpdate(receiverId);
        }

        // Real-time chat message
        if (io) {
            const msgPayload = {
                id: result.chatMessage.id,
                friendshipId,
                sender: result.chatMessage.sender,
                senderId,
                receiverId,
                content: result.chatMessage.content,
                messageType: 'TRANSFER_SENT',
                metadata: result.chatMessage.metadata,
                isRead: false,
                createdAt: result.chatMessage.createdAt
            };
            io.to(`user_${receiverId}`).emit('friend_message', msgPayload);
            io.to(`friend_chat_${friendshipId}`).emit('friend_message', msgPayload);

            // Transfer-specific event for animations
            io.to(`user_${receiverId}`).emit('friend_transfer_received', {
                transferId: result.transfer.id,
                friendshipId,
                amount: transferAmount,
                currency: 'USDC',
                reference: reference || null,
                fromUsername: result.senderUsername,
                fromUserId: senderId
            });
        }


        // Notification
        await getNotificationService(req).sendNotification({
            userId: receiverId,
            title: `💸 ${result.senderUsername} sent you ${transferAmount.toFixed(2)} USDC`,
            body: reference ? `Reference: "${reference}"` : `${transferAmount.toFixed(2)} USDC has been added to your balance.`,
            category: 'MONEY',
            actionPayload: {
                route: `/friends/chat/${friendshipId}`,
                action: 'OPEN_FRIEND_CHAT',
                friendshipId,
                transferId: result.transfer.id
            }
        });

        return res.status(200).json({
            success: true,
            message: `${transferAmount.toFixed(2)} USDC sent successfully.`,
            transfer: result.transfer
        });

    } catch (error) {
        if (error.message === 'INSUFFICIENT_FUNDS') {
            return res.status(400).json({
                success: false,
                message: 'Insufficient funds to complete this transfer.',
                code: 'INSUFFICIENT_FUNDS'
            });
        }
        // Unique-constraint conflict on the TransactionHistory.txHash means
        // a parallel duplicate attempted to write the same idempotency key.
        // Treat as idempotent success — the original request is still in
        // flight or already committed.
        if (error.code === 'P2002' && Array.isArray(error.meta?.target) && error.meta.target.includes('txHash')) {
            return res.status(200).json({
                success: true,
                message: 'Transfer already processed (concurrent idempotent replay).',
                idempotent: true
            });
        }
        console.error('[sendFunds] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 2. REQUEST FUNDS — Send a fund request to a friend
//
// POST /api/friends/transfer/request
// Body: { friendshipId, amount, reference }
// The receiver (person being asked) must confirm via slide-to-fulfill
// =============================================================================
exports.requestFunds = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const { friendshipId, amount, reference } = req.body;
        const requesterId = req.user.id; // Person requesting the funds

        if (!friendshipId || !amount) {
            return res.status(400).json({
                success: false,
                message: 'friendshipId and amount are required.'
            });
        }

        const requestAmount = parseFloat(amount);
        if (isNaN(requestAmount) || requestAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Amount must be a positive number.'
            });
        }


        // Verify friendship
        const friendship = await prisma.friendship.findUnique({
            where: { id: friendshipId },
            select: { requesterId: true, addresseeId: true, status: true }
        });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Friendship not found.' });
        }
        if (friendship.status !== 'ACCEPTED') {
            return res.status(403).json({ success: false, message: 'You can only request from accepted friends.' });
        }
        if (friendship.requesterId !== requesterId && friendship.addresseeId !== requesterId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        // The person being asked to pay (senderId in PeerTransfer context)
        const payerId = friendship.requesterId === requesterId
            ? friendship.addresseeId
            : friendship.requesterId;

        const requesterUser = await prisma.user.findUnique({
            where: { id: requesterId },
            select: { username: true, equippedCardSkin: true }
        });

        // Create the pending transfer request
        const transfer = await prisma.peerTransfer.create({
            data: {
                friendshipId,
                senderId: payerId,       // Person who will pay
                receiverId: requesterId, // Person who requested (will receive)
                amount: requestAmount,
                currency: 'USDC',
                reference: reference || null,
                type: 'REQUEST',
                status: 'PENDING'
            }
        });


        // Create DirectMessage to show in chat
        const chatMessage = await prisma.directMessage.create({
            data: {
                friendshipId,
                senderId: requesterId,
                receiverId: payerId,
                content: `Requested ${requestAmount.toFixed(2)} USDC`,
                messageType: 'TRANSFER_REQUEST',
                metadata: {
                    transferId: transfer.id,
                    amount: requestAmount,
                    currency: 'USDC',
                    reference: reference || null,
                    status: 'PENDING',
                    requestedBy: requesterId,
                    cardSkin: requesterUser.equippedCardSkin
                }
            },
            include: {
                sender: { select: { id: true, username: true, profilePictureUrl: true } }
            }
        });

        // Update friendship timestamp
        await prisma.friendship.update({
            where: { id: friendshipId },
            data: { updatedAt: new Date() }
        });

        // Real-time events
        if (io) {
            const msgPayload = {
                id: chatMessage.id,
                friendshipId,
                sender: chatMessage.sender,
                senderId: requesterId,
                receiverId: payerId,
                content: chatMessage.content,
                messageType: 'TRANSFER_REQUEST',
                metadata: chatMessage.metadata,
                isRead: false,
                createdAt: chatMessage.createdAt
            };
            io.to(`user_${payerId}`).emit('friend_message', msgPayload);
            io.to(`friend_chat_${friendshipId}`).emit('friend_message', msgPayload);


            // Transfer request event for UI pop-up
            io.to(`user_${payerId}`).emit('friend_transfer_request', {
                transferId: transfer.id,
                friendshipId,
                amount: requestAmount,
                currency: 'USDC',
                reference: reference || null,
                fromUsername: requesterUser.username,
                fromUserId: requesterId
            });
        }

        // Notification to the payer
        await getNotificationService(req).sendNotification({
            userId: payerId,
            title: `💰 ${requesterUser.username} requested ${requestAmount.toFixed(2)} USDC`,
            body: reference ? `Reason: "${reference}"` : 'Open to review and fulfill this request.',
            category: 'MONEY',
            actionPayload: {
                route: `/friends/chat/${friendshipId}`,
                action: 'OPEN_FRIEND_TRANSFER_REQUEST',
                friendshipId,
                transferId: transfer.id,
                amount: String(requestAmount)
            }
        });

        return res.status(201).json({
            success: true,
            message: 'Fund request sent successfully.',
            transfer
        });

    } catch (error) {
        console.error('[requestFunds] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 3. FULFILL TRANSFER REQUEST — Recipient slides-to-confirm to pay
//
// PUT /api/friends/transfer/:id/fulfill
// The sender (payer) confirms and funds are transferred
// =============================================================================
exports.fulfillTransferRequest = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const { id } = req.params;
        const payerId = req.user.id;

        // Find the transfer
        const transfer = await prisma.peerTransfer.findUnique({
            where: { id },
            include: {
                friendship: { select: { id: true } }
            }
        });

        if (!transfer) {
            return res.status(404).json({ success: false, message: 'Transfer request not found.' });
        }

        if (transfer.type !== 'REQUEST') {
            return res.status(400).json({ success: false, message: 'This is not a fund request.' });
        }

        if (transfer.status !== 'PENDING') {
            return res.status(409).json({
                success: false,
                message: `This request has already been ${transfer.status.toLowerCase()}.`
            });
        }


        // The payer (senderId) must be the one fulfilling
        if (transfer.senderId !== payerId) {
            return res.status(403).json({
                success: false,
                message: 'Only the person being requested can fulfill this transfer.'
            });
        }

        const transferAmount = transfer.amount;
        const receiverId = transfer.receiverId;
        const friendshipId = transfer.friendshipId;

        // ACID transaction
        const result = await prisma.$transaction(async (tx) => {
            // Phase H8 BUGFIX (2026-05-27): atomic conditional status flip.
            // The previous code path was:
            //
            //   1. Read transfer (outside tx) — sees PENDING.
            //   2. $transaction { debit, credit, update status, create txHash }.
            //
            // Two concurrent fulfill calls both saw PENDING in step 1, both
            // entered step 2, both debited the payer. The duplicate WAS
            // bounded by the @unique txHash on `PEER_FULFILL_SEND_${id}` —
            // the second tx hit P2002 on the create and rolled back. That
            // safety net works, but a refactor that removed the txHash row
            // would silently double-charge.
            //
            // The fix is to flip the status FIRST with a `status: 'PENDING'`
            // precondition. `updateMany` is the canonical Prisma pattern
            // for an atomic conditional update — `update` won't accept
            // status in `where` because status is not @unique. If the row
            // is no longer pending (concurrent decline / fulfill), `count`
            // is 0 and we abort BEFORE moving any money. Belt and braces:
            // the txHash unique constraint is still in place as the second
            // line of defence.
            const claimed = await tx.peerTransfer.updateMany({
                where: { id, status: 'PENDING' },
                data: { status: 'COMPLETED' }
            });
            if (claimed.count === 0) {
                throw new Error('ALREADY_FINALIZED');
            }

            const payer = await tx.user.findUnique({
                where: { id: payerId },
                select: { availableBalance: true, username: true, equippedCardSkin: true }
            });

            if (!payer) throw new Error('User not found.');
            // NOTE: both operands are Prisma Decimal objects; a bare `<` would
            // compare them lexicographically as strings (e.g. "300" < "75" is
            // true), falsely rejecting valid requests. Compare numerically.
            if (Number(payer.availableBalance) < Number(transferAmount)) {
                throw new Error('INSUFFICIENT_FUNDS');
            }

            // Debit payer
            await tx.user.update({
                where: { id: payerId },
                data: { availableBalance: { decrement: transferAmount } }
            });

            // Credit receiver
            await tx.user.update({
                where: { id: receiverId },
                data: { availableBalance: { increment: transferAmount } }
            });

            // Re-read the canonical row for the response. (We can't return
            // the result of `updateMany` directly — it only gives a count.)
            const updatedTransfer = await tx.peerTransfer.findUnique({
                where: { id }
            });

            // Create TransactionHistory for both
            await tx.transactionHistory.create({
                data: {
                    userId: payerId,
                    type: 'INTERNAL_TRANSFER',
                    amountUsdc: transferAmount,
                    feeUsdc: 0,
                    txHash: `PEER_FULFILL_SEND_${id}`,
                    status: 'COMPLETED'
                }
            });

            await tx.transactionHistory.create({
                data: {
                    userId: receiverId,
                    type: 'INTERNAL_TRANSFER',
                    amountUsdc: transferAmount,
                    feeUsdc: 0,
                    txHash: `PEER_FULFILL_RECV_${id}`,
                    status: 'COMPLETED'
                }
            });

            // Create completion message in chat
            const chatMessage = await tx.directMessage.create({
                data: {
                    friendshipId,
                    senderId: payerId,
                    receiverId,
                    content: `Fulfilled request: ${transferAmount.toFixed(2)} USDC sent`,
                    messageType: 'TRANSFER_COMPLETED',
                    metadata: {
                        transferId: id,
                        amount: transferAmount,
                        currency: 'USDC',
                        reference: transfer.reference || null,
                        status: 'COMPLETED',
                        fulfilledBy: payerId,
                        cardSkin: payer.equippedCardSkin
                    }
                },
                include: {
                    sender: { select: { id: true, username: true, profilePictureUrl: true } }
                }
            });

            return { updatedTransfer, chatMessage, payerUsername: payer.username };
        });


        // Post-commit side effects
        if (emitBalanceUpdate) {
            await emitBalanceUpdate(payerId);
            await emitBalanceUpdate(receiverId);
        }

        if (io) {
            const msgPayload = {
                id: result.chatMessage.id,
                friendshipId,
                sender: result.chatMessage.sender,
                senderId: payerId,
                receiverId,
                content: result.chatMessage.content,
                messageType: 'TRANSFER_COMPLETED',
                metadata: result.chatMessage.metadata,
                isRead: false,
                createdAt: result.chatMessage.createdAt
            };
            io.to(`user_${receiverId}`).emit('friend_message', msgPayload);
            io.to(`friend_chat_${friendshipId}`).emit('friend_message', msgPayload);

            // Transfer fulfilled event
            io.to(`user_${receiverId}`).emit('friend_transfer_fulfilled', {
                transferId: id,
                friendshipId,
                amount: transferAmount,
                currency: 'USDC',
                fromUsername: result.payerUsername,
                fromUserId: payerId
            });
        }

        // Notification to the requester
        await getNotificationService(req).sendNotification({
            userId: receiverId,
            title: `✅ ${result.payerUsername} fulfilled your request`,
            body: `${transferAmount.toFixed(2)} USDC has been added to your balance.`,
            category: 'MONEY',
            actionPayload: {
                route: `/friends/chat/${friendshipId}`,
                action: 'OPEN_FRIEND_CHAT',
                friendshipId,
                transferId: id
            }
        });

        return res.status(200).json({
            success: true,
            message: `Request fulfilled. ${transferAmount.toFixed(2)} USDC sent.`,
            transfer: result.updatedTransfer
        });

    } catch (error) {
        if (error.message === 'INSUFFICIENT_FUNDS') {
            return res.status(400).json({
                success: false,
                message: 'Insufficient funds to fulfill this request. Please deposit and try again.',
                code: 'INSUFFICIENT_FUNDS'
            });
        }
        // Phase H8: a parallel fulfill (or a decline that landed first)
        // already moved this row out of PENDING. Treat as idempotent
        // success — the prior outcome stands and the user shouldn't see
        // a scary error for what is essentially a "you double-tapped".
        if (error.message === 'ALREADY_FINALIZED') {
            const finalState = await prisma.peerTransfer.findUnique({ where: { id: req.params.id } }).catch(() => null);
            return res.status(200).json({
                success: true,
                message: `Request already ${finalState?.status?.toLowerCase() || 'finalized'} (idempotent replay).`,
                idempotent: true,
                transfer: finalState
            });
        }
        // Unique-constraint conflict on PEER_FULFILL_SEND_/PEER_FULFILL_RECV_
        // means the request was already fulfilled by an earlier (in-flight)
        // call. Treat as idempotent success.
        if (error.code === 'P2002' && Array.isArray(error.meta?.target) && error.meta.target.includes('txHash')) {
            return res.status(200).json({
                success: true,
                message: 'Request already fulfilled (idempotent replay).',
                idempotent: true
            });
        }
        console.error('[fulfillTransferRequest] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 4. DECLINE TRANSFER REQUEST — Recipient rejects the fund request
//
// PUT /api/friends/transfer/:id/decline
// =============================================================================
exports.declineTransferRequest = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const { id } = req.params;
        const userId = req.user.id;

        const transfer = await prisma.peerTransfer.findUnique({ where: { id } });

        if (!transfer) {
            return res.status(404).json({ success: false, message: 'Transfer request not found.' });
        }

        if (transfer.type !== 'REQUEST') {
            return res.status(400).json({ success: false, message: 'This is not a fund request.' });
        }

        if (transfer.status !== 'PENDING') {
            return res.status(409).json({
                success: false,
                message: `This request has already been ${transfer.status.toLowerCase()}.`
            });
        }

        // Only the payer (senderId) can decline
        if (transfer.senderId !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Only the person being requested can decline.'
            });
        }

        const friendshipId = transfer.friendshipId;
        const receiverId = transfer.receiverId;

        // Phase H8 BUGFIX (2026-05-27): atomic conditional status flip
        // for decline. Same race as fulfill — without a precondition,
        // two concurrent declines (or a fulfill+decline race from the
        // same payer) both saw PENDING and both wrote a "declined" chat
        // bubble + status update. Decline doesn't have a txHash safety
        // net like fulfill, so the duplicate could go through silently.
        // The conditional `updateMany` rejects the second caller cleanly.
        const claimed = await prisma.peerTransfer.updateMany({
            where: { id, status: 'PENDING' },
            data: { status: 'DECLINED' }
        });
        if (claimed.count === 0) {
            const finalState = await prisma.peerTransfer.findUnique({ where: { id } }).catch(() => null);
            return res.status(200).json({
                success: true,
                message: `Request already ${finalState?.status?.toLowerCase() || 'finalized'} (idempotent replay).`,
                idempotent: true,
                transfer: finalState
            });
        }
        // Re-read the canonical row for the response.
        const updated = await prisma.peerTransfer.findUnique({ where: { id } });


        // Create decline message in chat
        const declineUser = await prisma.user.findUnique({
            where: { id: userId },
            select: { username: true, equippedCardSkin: true }
        });

        const chatMessage = await prisma.directMessage.create({
            data: {
                friendshipId,
                senderId: userId,
                receiverId,
                content: `Declined request for ${transfer.amount.toFixed(2)} USDC`,
                messageType: 'TRANSFER_DECLINED',
                metadata: {
                    transferId: id,
                    amount: transfer.amount,
                    currency: 'USDC',
                    reference: transfer.reference || null,
                    status: 'DECLINED',
                    cardSkin: declineUser.equippedCardSkin
                }
            },
            include: {
                sender: { select: { id: true, username: true, profilePictureUrl: true } }
            }
        });

        if (io) {
            const msgPayload = {
                id: chatMessage.id,
                friendshipId,
                sender: chatMessage.sender,
                senderId: userId,
                receiverId,
                content: chatMessage.content,
                messageType: 'TRANSFER_DECLINED',
                metadata: chatMessage.metadata,
                isRead: false,
                createdAt: chatMessage.createdAt
            };
            io.to(`user_${receiverId}`).emit('friend_message', msgPayload);
            io.to(`friend_chat_${friendshipId}`).emit('friend_message', msgPayload);
        }

        // Notify the requester
        await getNotificationService(req).sendNotification({
            userId: receiverId,
            title: 'Request Declined',
            body: `${declineUser.username} declined your request for ${transfer.amount.toFixed(2)} USDC.`,
            category: 'MONEY',
            actionPayload: {
                route: `/friends/chat/${friendshipId}`,
                action: 'OPEN_FRIEND_CHAT',
                friendshipId,
                transferId: id
            }
        });

        return res.status(200).json({
            success: true,
            message: 'Transfer request declined.',
            transfer: updated
        });

    } catch (error) {
        console.error('[declineTransferRequest] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 5. GET TRANSFER DETAILS — Get a specific transfer by ID
//
// GET /api/friends/transfer/:id
// =============================================================================
exports.getTransferDetails = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { id } = req.params;
        const userId = req.user.id;

        const transfer = await prisma.peerTransfer.findUnique({
            where: { id },
            include: {
                sender: {
                    select: { id: true, username: true, profilePictureUrl: true, availableBalance: true }
                },
                receiver: {
                    select: { id: true, username: true, profilePictureUrl: true }
                }
            }
        });

        if (!transfer) {
            return res.status(404).json({ success: false, message: 'Transfer not found.' });
        }

        // Only participants can view
        if (transfer.senderId !== userId && transfer.receiverId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        // For the payer viewing a pending request, include their current balance
        let payerBalance = null;
        if (transfer.type === 'REQUEST' && transfer.status === 'PENDING' && transfer.senderId === userId) {
            payerBalance = transfer.sender.availableBalance;
        }

        return res.status(200).json({
            success: true,
            transfer: {
                id: transfer.id,
                friendshipId: transfer.friendshipId,
                sender: {
                    id: transfer.sender.id,
                    username: transfer.sender.username,
                    profilePictureUrl: transfer.sender.profilePictureUrl
                },
                receiver: {
                    id: transfer.receiver.id,
                    username: transfer.receiver.username,
                    profilePictureUrl: transfer.receiver.profilePictureUrl
                },
                amount: transfer.amount,
                currency: transfer.currency,
                reference: transfer.reference,
                type: transfer.type,
                status: transfer.status,
                createdAt: transfer.createdAt,
                updatedAt: transfer.updatedAt
            },
            payerBalance,
            hasSufficientFunds: payerBalance !== null ? payerBalance >= transfer.amount : null
        });

    } catch (error) {
        console.error('[getTransferDetails] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get transfer details.' });
    }
};


// =============================================================================
// 6. GET TRANSFER HISTORY — All transfers for a friendship
//
// GET /api/friends/transfer/history/:friendshipId?page=1&limit=20
// =============================================================================
exports.getTransferHistory = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { friendshipId } = req.params;
        const userId = req.user.id;
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const skip = (page - 1) * limit;

        // Verify participation
        const friendship = await prisma.friendship.findUnique({
            where: { id: friendshipId },
            select: { requesterId: true, addresseeId: true }
        });

        if (!friendship) {
            return res.status(404).json({ success: false, message: 'Friendship not found.' });
        }

        if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        const [transfers, total] = await Promise.all([
            prisma.peerTransfer.findMany({
                where: { friendshipId },
                include: {
                    sender: { select: { id: true, username: true, profilePictureUrl: true } },
                    receiver: { select: { id: true, username: true, profilePictureUrl: true } }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.peerTransfer.count({ where: { friendshipId } })
        ]);

        return res.status(200).json({
            success: true,
            transfers,
            total,
            page,
            limit,
            hasMore: skip + limit < total
        });

    } catch (error) {
        console.error('[getTransferHistory] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get transfer history.' });
    }
};

// =============================================================================
// 7. GET PENDING REQUESTS FOR USER — All pending transfer requests where
//    the current user is the payer (senderId)
//
// GET /api/friends/transfer/pending
// =============================================================================
exports.getPendingTransferRequests = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const pendingRequests = await prisma.peerTransfer.findMany({
            where: {
                senderId: userId,
                type: 'REQUEST',
                status: 'PENDING'
            },
            include: {
                receiver: { select: { id: true, username: true, profilePictureUrl: true } },
                friendship: { select: { id: true } }
            },
            orderBy: { createdAt: 'desc' }
        });

        // Get user's current balance for context
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { availableBalance: true }
        });

        return res.status(200).json({
            success: true,
            requests: pendingRequests,
            currentBalance: user?.availableBalance || 0,
            count: pendingRequests.length
        });

    } catch (error) {
        console.error('[getPendingTransferRequests] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get pending requests.' });
    }
};
