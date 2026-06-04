// controllers/chatTransferController.js
// =============================================================================
// AZAMAN V2 — IN-CHAT CRYPTO TRANSFER  (Phase 2.3)
//
// POST /api/chat/transfer
//
// Atomically inside a single prisma.$transaction:
//   1. Deducts amountUsdc from sender's availableBalance
//   2. Credits amountUsdc to receiver's availableBalance
//   3. Upserts a Contact record (so users appear in each other's contact list)
//   4. Persists a PAYMENT_TRANSFER Message in the shared Conversation
//   5. Creates TransactionHistory records for both parties
//
// After commit:
//   - Emits balance_update to both users
//   - Emits new_personal_message to the personal chat room
//   - Fires FCM push to the receiver if offline
// =============================================================================

const crypto = require('crypto');

// ── Internal: deterministic personal room hash ────────────────────────────────
const _personalRoomHash = (uid1, uid2) => {
    const sorted = [String(uid1), String(uid2)].sort();
    return crypto
        .createHash('sha256')
        .update(sorted.join('_'))
        .digest('hex')
        .slice(0, 32);
};

exports.chatTransfer = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
    const pushIfOffline     = req.app.get('pushIfOffline');

    try {
        const senderId   = req.user.id;
        const {
            receiverId:  rawReceiverId,
            amountUsdc:  rawAmount,
            note                          // optional message note
        } = req.body;

        // ── Validation ────────────────────────────────────────────────────────
        const receiverId = parseInt(rawReceiverId, 10);
        const amount     = parseFloat(rawAmount);

        if (!receiverId || isNaN(receiverId))
            return res.status(400).json({ success: false, message: 'receiverId is required.' });

        if (!amount || isNaN(amount) || amount <= 0)
            return res.status(400).json({ success: false, message: 'amountUsdc must be a positive number.' });

        if (senderId === receiverId)
            return res.status(400).json({ success: false, message: 'Cannot transfer to yourself.' });

        // ── ACID $transaction ─────────────────────────────────────────────────
        const result = await prisma.$transaction(async (tx) => {

            // 1. Lock sender row — verify balance
            const sender = await tx.user.findUnique({ where: { id: senderId } });
            if (!sender) throw new Error('Sender not found.');

            if (sender.availableBalance < amount) {
                throw new Error(
                    `Insufficient balance. Required: ${amount} USDC, ` +
                    `available: ${sender.availableBalance.toFixed(6)} USDC.`
                );
            }

            // 2. Lock receiver row — verify exists
            const receiver = await tx.user.findUnique({ where: { id: receiverId } });
            if (!receiver) throw new Error('Receiver not found.');

            // 3. Deduct sender / credit receiver
            await tx.user.update({
                where: { id: senderId },
                data:  { availableBalance: { decrement: amount } }
            });

            await tx.user.update({
                where: { id: receiverId },
                data:  { availableBalance: { increment: amount } }
            });

            // 4. Upsert Contact in both directions (idempotent)
            await tx.contact.upsert({
                where:  { userId_savedUserId: { userId: senderId,   savedUserId: receiverId } },
                update: {},
                create: { userId: senderId,   savedUserId: receiverId }
            });

            await tx.contact.upsert({
                where:  { userId_savedUserId: { userId: receiverId, savedUserId: senderId   } },
                update: {},
                create: { userId: receiverId, savedUserId: senderId   }
            });

            // 5. Get or create personal conversation
            let conversation = await tx.conversation.findFirst({
                where: {
                    type: 'PERSONAL',
                    participants: {
                        every: { id: { in: [senderId, receiverId] } }
                    }
                }
            });

            if (!conversation) {
                conversation = await tx.conversation.create({
                    data: {
                        type: 'PERSONAL',
                        participants: {
                            connect: [{ id: senderId }, { id: receiverId }]
                        }
                    }
                });
            }

            // 6. Persist PAYMENT_TRANSFER message in the conversation
            const messageContent = note
                ? `💸 Sent ${amount} USDC — "${note}"`
                : `💸 Sent ${amount} USDC`;

            const message = await tx.message.create({
                data: {
                    conversationId: conversation.id,
                    senderId:       senderId,
                    messageType:    'PAYMENT_TRANSFER',
                    content:        messageContent
                },
                include: { sender: { select: { id: true, username: true } } }
            });

            // 7. TransactionHistory — sender debit (negative = OUT)
            await tx.transactionHistory.create({
                data: {
                    userId:     senderId,
                    type:       'INTERNAL_TRANSFER',
                    amountUsdc: -amount,
                    feeUsdc:    0,
                    status:     'COMPLETED'
                }
            });

            // 8. TransactionHistory — receiver credit (positive = IN)
            await tx.transactionHistory.create({
                data: {
                    userId:     receiverId,
                    type:       'INTERNAL_TRANSFER',
                    amountUsdc: amount,
                    feeUsdc:    0,
                    status:     'COMPLETED'
                }
            });

            return {
                conversation,
                message,
                sender,
                receiver,
                newSenderBalance:   sender.availableBalance   - amount,
                newReceiverBalance: receiver.availableBalance + amount
            };
        });

        // ── Post-commit side-effects ──────────────────────────────────────────

        // Real-time balance pushes
        await emitBalanceUpdate(senderId);
        await emitBalanceUpdate(receiverId);

        // Broadcast the payment message to the personal chat room
        const roomHash = _personalRoomHash(senderId, receiverId);
        const chatRoom = `personal_${roomHash}`;

        const socketPayload = {
            id:             result.message.id,
            conversationId: result.conversation.id,
            sender:         result.message.sender,
            messageType:    'PAYMENT_TRANSFER',
            content:        result.message.content,
            amount:         amount,
            createdAt:      result.message.createdAt
        };

        io.to(chatRoom).emit('new_personal_message', socketPayload);
        io.to(`user_${receiverId}`).emit('payment_received', {
            from:           senderId,
            amountUsdc:     amount,
            conversationId: result.conversation.id,
            messageId:      result.message.id
        });

        // Offline FCM push to receiver
        await pushIfOffline(
            receiverId,
            `💸 ${result.sender.username} sent you ${amount} USDC`,
            note || `${amount} USDC has been transferred to your account.`,
            {
                type:           'PAYMENT_TRANSFER',
                conversationId: result.conversation.id,
                route:          `/chat/${result.conversation.id}`
            }
        );

        return res.status(200).json({
            success:  true,
            message:  `Transferred ${amount} USDC to ${result.receiver.username}.`,
            data: {
                amountUsdc:         amount,
                conversationId:     result.conversation.id,
                messageId:          result.message.id,
                sender: {
                    id:         senderId,
                    username:   result.sender.username,
                    newBalance: result.newSenderBalance
                },
                receiver: {
                    id:         receiverId,
                    username:   result.receiver.username,
                    newBalance: result.newReceiverBalance
                }
            }
        });

    } catch (error) {
        console.error('[chatTransfer] error:', error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
};
