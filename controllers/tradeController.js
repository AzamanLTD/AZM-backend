// controllers/tradeController.js
// =============================================================================
// AZAMAN V2 — TRADE CONTROLLER
//
// V2 ground rules (see AZAMAN_MASTER_SOUL.md §4):
//   - Trade completion happens ONLY through services/p2p.service.completeTrade,
//     reachable via POST /api/p2p/complete. The legacy `releaseAssets` handler
//     and the `vendor_release_crypto` socket handler have been removed.
//   - Vendor-side escrow uses `escrowLockedBalance` (V2 ledger split). The
//     legacy `lockedBalance` field is no longer mutated here.
//   - Messages use the V2 Conversation/Message schema. The trade conversation
//     is lazily created (Conversation.type = 'TRADE', tradeId = String(id)).
// =============================================================================

const { sendPushNotification } = require('../utils/firebaseService');
const gamification = require('../services/vendorGamificationService');
const { parsePagination, buildPageEnvelope } = require('../utils/pagination');

/**
 * Phase N helper: retrieve the singleton NotificationService from app context.
 */
function _getNotificationService(req) {
    const svc = req.app.get('notificationService');
    if (svc) return svc;
    const NotificationService = require('../services/notificationService');
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    return new NotificationService(prisma, io);
}

// ── Constants ────────────────────────────────────────────────────────────────
const PROOF_NOTICE =
    "PAYMENT SUBMITTED. " +
    "VENDOR: Verify the receipt of funds before releasing assets. " +
    "BUYER: You have marked the order as paid. Please wait for verification.";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Lazily fetch (or create) the V2 Conversation row for a trade.
 * Both the buyer and the vendor are connected as participants.
 */
const _getOrCreateTradeConversation = async (tx, trade) => {
    const tradeIdStr = String(trade.id);
    let conv = await tx.conversation.findUnique({ where: { tradeId: tradeIdStr } });
    if (conv) return conv;

    return tx.conversation.create({
        data: {
            type:    'TRADE',
            tradeId: tradeIdStr,
            participants: {
                connect: [{ id: trade.userId }, { id: trade.vendorId }]
            }
        }
    });
};

// =============================================================================
// 1. INITIATE TRADE — Smart Queue State Machine
//
//    Gate logic:
//      1. Count active trades on this Ad (status IN [PENDING_PAYMENT, PAID, DISPUTED])
//      2. If count >= ad.maxConcurrentTrades  → place buyer in TradeQueue (WAITING)
//      3. Otherwise                           → create the Trade as normal
//
//    All balance mutations inside a single $transaction. Vendor-side lock now
//    uses `escrowLockedBalance` (V2) instead of legacy `lockedBalance`.
// =============================================================================
exports.initiateTrade = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const { adId, amountCrypto, amountFiat, paymentMethod, idempotencyKey, buyerPaymentDetails } = req.body;
        const userId = req.user.id;

        // HIGH-6: Input validation
        if (!adId) {
            return res.status(400).json({ success: false, message: 'adId is required.' });
        }
        if (!amountCrypto || isNaN(parseFloat(amountCrypto)) || parseFloat(amountCrypto) <= 0) {
            return res.status(400).json({ success: false, message: 'amountCrypto must be a positive number.' });
        }
        if (!amountFiat || isNaN(parseFloat(amountFiat)) || parseFloat(amountFiat) <= 0) {
            return res.status(400).json({ success: false, message: 'amountFiat must be a positive number.' });
        }
        if (parseFloat(amountCrypto) > 1000000) {
            return res.status(400).json({ success: false, message: 'Trade amount exceeds maximum allowed.' });
        }

        // HIGH-12: Idempotency protection — prevent duplicate trades from retries
        if (idempotencyKey) {
            const existingTrade = await prisma.trade.findFirst({
                where: {
                    userId,
                    createdAt: { gte: new Date(Date.now() - 60_000) }, // within last 60s
                    amountCrypto: parseFloat(amountCrypto),
                    amountFiat: parseFloat(amountFiat)
                },
                select: { id: true }
            });
            if (existingTrade) {
                return res.status(200).json({
                    success: true,
                    queued: false,
                    duplicate: true,
                    message: 'Trade already initiated (idempotent response).',
                    trade: { id: existingTrade.id }
                });
            }
        }

        const ad = await prisma.ad.findUnique({
            where:   { id: parseInt(adId) },
            include: { vendor: true, tradeAccount: true }
        });

        if (!ad)
            return res.status(404).json({ success: false, message: 'Advertisement no longer exists.' });
        if (ad.status !== 'ACTIVE')
            return res.status(400).json({ success: false, message: 'This advertisement is not currently active.' });
        if (ad.vendorId === userId)
            return res.status(400).json({ success: false, message: 'You cannot trade with your own advertisement.' });

        // ── Phase F (2026-05-25): BUY ads re-enabled ──────────────────────
        // Phase D-2 corrected the settlement model. The env-flag gate has
        // been removed. BUY ad trades are now fully supported with correct
        // escrow handling (buyer's availableBalance → escrowLockedBalance).

        // HIGH-6: Validate amount is within ad's min/max limits
        const cryptoAmount = parseFloat(amountCrypto);
        if (cryptoAmount < ad.minLimit) {
            return res.status(400).json({
                success: false,
                message: `Amount is below the minimum limit of ${ad.minLimit}.`
            });
        }
        if (cryptoAmount > ad.maxLimit) {
            return res.status(400).json({
                success: false,
                message: `Amount exceeds the maximum limit of ${ad.maxLimit}.`
            });
        }

        const vendorId = ad.vendorId;
        const isSellAd = ad.type === 'SELL';

        // ── Phase F2: SELL ads — buyer payment details are OPTIONAL at initiation.
        // The buyer sees the vendor's payment details in the active trade screen
        // and provides their sender identity after clicking "Paid".
        let validatedBuyerDetails = null;
        if (isSellAd && buyerPaymentDetails && typeof buyerPaymentDetails === 'object' && Object.keys(buyerPaymentDetails).length > 0) {
            // Validate if provided (optional)
            const methodType = ad.tradeAccount?.methodType || ad.paymentMethod;
            const { validateAccountDetails } = require('../services/tradeAccountValidation');
            const validation = validateAccountDetails(methodType, buyerPaymentDetails);
            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    code: 'INVALID_BUYER_DETAILS',
                    message: validation.error
                });
            }
            validatedBuyerDetails = buyerPaymentDetails;
        }

        // ── Phase F2: P2P trades use flat USDC fee, no GHS oracle math ─────
        // The oracle rate (liveUsdToGhs) is ONLY for the internal MoMo
        // deposit/withdrawal rail. P2P trades are USDC↔USD (1:1 parity
        // minus platform fee). Escrow amount = amountCrypto directly.
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        if (!settings) throw new Error('Global settings offline.');

        // Snapshot the vendor's trade account details for this trade
        const vendorData = await prisma.user.findUnique({ where: { id: vendorId } });
        let snapshotDetails = vendorData.paymentDetails || {};
        // If the ad links to a specific trade account, use those details
        if (ad.tradeAccountId) {
            const tradeAccount = await prisma.tradeAccount.findUnique({
                where: { id: ad.tradeAccountId }
            });
            if (tradeAccount) {
                snapshotDetails = {
                    methodType: tradeAccount.methodType,
                    ...tradeAccount.accountDetails
                };
            }
        }

        // ══ SMART QUEUE GATE + TRADE CREATION (ALL inside $transaction) ══════
        // CRITICAL-7: Both the capacity check AND the trade creation happen in a
        // single atomic transaction to prevent race conditions where two requests
        // both pass the capacity check simultaneously.
        const tradeResult = await prisma.$transaction(async (tx) => {
            // Count active trades INSIDE the transaction (prevents race condition)
            const activeTradeCount = await tx.trade.count({
                where: {
                    vendorId,
                    status: { in: ['PENDING_PAYMENT', 'PAID', 'DISPUTED'] }
                }
            });

            if (activeTradeCount >= ad.maxConcurrentTrades) {
                // QUEUE PATH — return special marker
                const queueEntry = await tx.tradeQueue.create({
                    data: { buyerId: userId, adId: ad.id, status: 'WAITING' }
                });
                const queuePosition = await tx.tradeQueue.count({
                    where: { adId: ad.id, status: 'WAITING' }
                });

                // Phase N: notification moved post-commit for full pipeline delivery.

                return { queued: true, queueEntry, queuePosition, _queueNotification: {
                    userId,
                    title: 'You Are In The Queue',
                    body: `This vendor is busy. You are #${queuePosition} in the queue.`,
                    category: 'GENERAL',
                    actionPayload: {
                        route: '/queue',
                        action: 'OPEN_QUEUE',
                        adId: String(ad.id),
                        queueId: queueEntry.id,
                        queuePosition
                    }
                }};
            }

            // NORMAL TRADE PATH — create the trade
            // V2 Vendor Approval Flow: No escrow lock at initiation.
            // Trade is created as PENDING. Escrow is locked only when
            // the vendor explicitly accepts via POST /api/trades/accept.

            const windowMinutes = ad.maxPaymentWindow || 15;

            const newTrade = await tx.trade.create({
                data: {
                    crypto: ad.crypto || 'USDT',
                    amountCrypto: cryptoAmount,
                    amountFiat: parseFloat(amountFiat),
                    currency: 'USD',
                    type: ad.type,
                    rate: 1.0,
                    status: 'PENDING',
                    user: { connect: { id: userId } },
                    vendor: { connect: { id: vendorId } },
                    paymentMethod: ad.paymentMethod || paymentMethod || 'Zelle',
                    vendorPaymentDetails: snapshotDetails,
                    buyerPaymentDetails: validatedBuyerDetails,
                    selectedTimeframe: windowMinutes,
                    expiresAt: new Date(Date.now() + 24 * 60 * 60_000) // 24h placeholder until vendor accepts
                },
                include: {
                    user: { select: { username: true, fcmToken: true } },
                    vendor: { select: { username: true, fcmToken: true } }
                }
            });

            return { queued: false, trade: newTrade };
        });

        // ── Handle queue result (post-transaction side effects) ───────────────
        if (tradeResult.queued) {
            io.to(`user_${userId}`).emit('queued', {
                adId: ad.id,
                queueId: tradeResult.queueEntry.id,
                queuePosition: tradeResult.queuePosition,
                message: `This vendor is at capacity (${ad.maxConcurrentTrades} active trades). You are #${tradeResult.queuePosition} in the queue.`
            });

            // Phase N: fire queue notification via full pipeline (DB + socket + FCM)
            if (tradeResult._queueNotification) {
                setImmediate(async () => {
                    try {
                        await _getNotificationService(req).sendNotification(tradeResult._queueNotification);
                    } catch (err) {
                        console.error('[initiateTrade] queue notification non-fatal:', err.message);
                    }
                });
            }

            return res.status(202).json({
                success: true,
                queued: true,
                message: `Ad is at capacity. You have been placed in position #${tradeResult.queuePosition}.`,
                data: {
                    queueId: tradeResult.queueEntry.id,
                    adId: ad.id,
                    queuePosition: tradeResult.queuePosition,
                    maxConcurrent: ad.maxConcurrentTrades
                }
            });
        }

        // ── Handle normal trade result ───────────────────────────────────────
        const newTrade = tradeResult.trade;

        if (emitBalanceUpdate) {
            await emitBalanceUpdate(vendorId);
            await emitBalanceUpdate(userId);
        }

        const targetUserId = isSellAd ? vendorId : userId;
        io.to(`user_${targetUserId}`).emit('new_trade_request', {
            tradeId:   newTrade.id,
            amount:    amountFiat,
            buyerName: newTrade.user.username || 'System',
            timestamp: new Date()
        });

        // Phase N: persist the notification + deliver via socket + FCM.
        // Previously this was socket-only + raw FCM — vendor's bell was
        // empty on app reopen because no DB row was created.
        setImmediate(async () => {
            try {
                await _getNotificationService(req).sendNotification({
                    userId:   targetUserId,
                    title:    '🔔 New Trade Request',
                    body:     `${newTrade.user.username || 'A buyer'} wants to trade $${amountFiat}. Tap to accept or decline.`,
                    category: 'VENDOR_PRIORITY',
                    actionPayload: {
                        route:   `/trade/${newTrade.id}`,
                        action:  'OPEN_TRADE',
                        tradeId: String(newTrade.id)
                    }
                });
            } catch (err) {
                console.error('[initiateTrade] notification non-fatal:', err.message);
            }
        });

        res.status(201).json({ success: true, queued: false, trade: newTrade });

    } catch (error) {
        console.error('Initiate Trade Error:', error);
        res.status(400).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 1b. ACCEPT TRADE — Vendor approves the trade request
//
//    - Verifies caller is the vendor on the trade
//    - Verifies trade is in PENDING status
//    - Locks escrow (SELL ad: vendor's pool → escrowLockedBalance;
//      BUY ad: buyer's availableBalance → escrowLockedBalance)
//    - Updates status to PENDING_PAYMENT, sets expiresAt + tradeStartTime
//    - Emits socket events to trade room + buyer notification
// =============================================================================
exports.acceptTrade = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const { tradeId } = req.body;
        const vendorUserId = req.user.id;

        if (!tradeId) {
            return res.status(400).json({ success: false, message: 'tradeId is required.' });
        }

        const tradeIdInt = parseInt(tradeId, 10);
        if (isNaN(tradeIdInt)) {
            return res.status(400).json({ success: false, message: 'Invalid trade id.' });
        }

        const updatedTrade = await prisma.$transaction(async (tx) => {
            const trade = await tx.trade.findUnique({
                where: { id: tradeIdInt },
                include: {
                    user: { select: { id: true, username: true, fcmToken: true } },
                    vendor: { select: { id: true, username: true, fcmToken: true } }
                }
            });

            if (!trade) throw new Error('Trade not found.');
            if (trade.vendorId !== vendorUserId) {
                throw new Error('Only the vendor can accept this trade.');
            }
            if (trade.status !== 'PENDING') {
                throw new Error(`Cannot accept trade: current status is ${trade.status}.`);
            }

            const cryptoAmount = trade.amountCrypto;
            const isSellAd = trade.type === 'SELL';

            // Lock escrow based on trade type
            if (isSellAd) {
                // SELL ad: vendor's trading pool funds the escrow
                const vendor = await tx.user.findUnique({ where: { id: trade.vendorId } });
                if (!vendor || vendor.vendorUnallocatedBalance < cryptoAmount) {
                    throw new Error('Insufficient trading pool liquidity. Please fund your trading pool.');
                }
                const lockResult = await tx.user.updateMany({
                    where: {
                        id: trade.vendorId,
                        vendorUnallocatedBalance: { gte: cryptoAmount }
                    },
                    data: {
                        vendorUnallocatedBalance: { decrement: cryptoAmount },
                        escrowLockedBalance:      { increment: cryptoAmount }
                    }
                });
                if (lockResult.count === 0) {
                    throw new Error('Insufficient trading pool liquidity for this trade.');
                }
            } else {
                // BUY ad: buyer (trade.userId) escrows their crypto
                const buyAdEscrow = cryptoAmount;
                const user = await tx.user.findUnique({ where: { id: trade.userId } });
                if (!user || user.availableBalance < buyAdEscrow) {
                    throw new Error('Buyer has insufficient balance for this trade.');
                }
                const escrowLock = await tx.user.updateMany({
                    where: {
                        id: trade.userId,
                        availableBalance: { gte: buyAdEscrow }
                    },
                    data: {
                        availableBalance:    { decrement: buyAdEscrow },
                        escrowLockedBalance: { increment: buyAdEscrow }
                    }
                });
                if (escrowLock.count === 0) {
                    throw new Error('Buyer has insufficient balance for this trade.');
                }
            }

            // Set timer and transition to PENDING_PAYMENT
            const windowMinutes = trade.selectedTimeframe || 15;
            const now = new Date();
            const expiresAt = new Date(now.getTime() + windowMinutes * 60_000);

            const updated = await tx.trade.update({
                where: { id: tradeIdInt },
                data: {
                    status: 'PENDING_PAYMENT',
                    expiresAt,
                    tradeStartTime: now
                },
                include: {
                    user: { select: { id: true, username: true, fcmToken: true } },
                    vendor: { select: { id: true, username: true, fcmToken: true } }
                }
            });

            return updated;
        });

        // Post-commit side effects
        if (emitBalanceUpdate) {
            await emitBalanceUpdate(updatedTrade.vendorId);
            await emitBalanceUpdate(updatedTrade.userId);
        }

        // Emit trade update to the trade room
        const room = `trade_${tradeIdInt}`;
        io.to(room).emit('trade_update', {
            status: 'PENDING_PAYMENT',
            tradeId: tradeIdInt,
            expiresAt: updatedTrade.expiresAt,
            tradeStartTime: updatedTrade.tradeStartTime
        });

        // Notify the buyer that the vendor accepted
        setImmediate(async () => {
            try {
                await _getNotificationService(req).sendNotification({
                    userId:   updatedTrade.userId,
                    title:    'Trade Accepted',
                    body:     `Your trade #${tradeIdInt} has been accepted. Please complete payment within ${updatedTrade.selectedTimeframe} minutes.`,
                    category: 'GENERAL',
                    actionPayload: {
                        route:   `/trade/${tradeIdInt}`,
                        action:  'OPEN_TRADE',
                        tradeId: String(tradeIdInt)
                    }
                });
            } catch (err) {
                console.error('[acceptTrade] notification non-fatal:', err.message);
            }
        });

        res.status(200).json({ success: true, trade: updatedTrade });

    } catch (error) {
        console.error('acceptTrade error:', error.message);
        const status = error.message.includes('not found') ? 404
            : error.message.includes('Only') || error.message.includes('Cannot') ? 403
            : 400;
        res.status(status).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 1c. DECLINE TRADE — Vendor declines the trade request
//
//    - Verifies caller is the vendor on the trade
//    - Verifies trade is in PENDING status
//    - Updates status to CANCELLED
//    - Notifies buyer with the decline reason
// =============================================================================
exports.declineTrade = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io     = req.app.get('socketio');

    try {
        const { tradeId, reason } = req.body;
        const vendorUserId = req.user.id;

        if (!tradeId) {
            return res.status(400).json({ success: false, message: 'tradeId is required.' });
        }

        const tradeIdInt = parseInt(tradeId, 10);
        if (isNaN(tradeIdInt)) {
            return res.status(400).json({ success: false, message: 'Invalid trade id.' });
        }

        const trade = await prisma.trade.findUnique({
            where: { id: tradeIdInt },
            include: {
                user: { select: { id: true, username: true, fcmToken: true } },
                vendor: { select: { id: true, username: true, fcmToken: true } }
            }
        });

        if (!trade) {
            return res.status(404).json({ success: false, message: 'Trade not found.' });
        }
        if (trade.vendorId !== vendorUserId) {
            return res.status(403).json({ success: false, message: 'Only the vendor can decline this trade.' });
        }
        if (trade.status !== 'PENDING') {
            return res.status(400).json({ success: false, message: `Cannot decline trade: current status is ${trade.status}.` });
        }

        await prisma.trade.update({
            where: { id: tradeIdInt },
            data:  { status: 'CANCELLED' }
        });

        // Emit trade update to the trade room
        const room = `trade_${tradeIdInt}`;
        io.to(room).emit('trade_update', {
            status: 'CANCELLED',
            tradeId: tradeIdInt,
            reason: reason || 'Vendor declined the trade.'
        });

        // Notify the buyer
        const declineReason = reason || 'The vendor declined your trade request.';
        setImmediate(async () => {
            try {
                await _getNotificationService(req).sendNotification({
                    userId:   trade.userId,
                    title:    'Trade Declined',
                    body:     `Trade #${tradeIdInt} was declined: ${declineReason}`,
                    category: 'GENERAL',
                    actionPayload: {
                        route:   `/trade/${tradeIdInt}`,
                        action:  'OPEN_TRADE',
                        tradeId: String(tradeIdInt)
                    }
                });
            } catch (err) {
                console.error('[declineTrade] notification non-fatal:', err.message);
            }
        });

        res.status(200).json({ success: true, message: 'Trade declined successfully.' });

    } catch (error) {
        console.error('declineTrade error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 2. GET TRADE DETAILS
// =============================================================================
exports.getTradeDetails = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;
        const tradeId = parseInt(id, 10);
        if (isNaN(tradeId)) return res.status(400).json({ success: false, message: 'Invalid trade id.' });

        const trade = await prisma.trade.findUnique({
            where: { id: tradeId },
            include: {
                vendor: { select: { id: true, username: true, paymentDetails: true } },
                user:   { select: { id: true, username: true } }
            }
        });

        if (!trade) return res.status(404).json({ success: false, message: 'Trade not found.' });

        // Pull conversation messages via the V2 Conversation row.
        const conversation = await prisma.conversation.findUnique({
            where:   { tradeId: String(tradeId) },
            include: { messages: { orderBy: { createdAt: 'asc' } } }
        });

        const finalPaymentDetails = (trade.vendorPaymentDetails && Object.keys(trade.vendorPaymentDetails).length > 0)
            ? trade.vendorPaymentDetails
            : trade.vendor.paymentDetails;

        res.status(200).json({
            id: trade.id,
            status: trade.status,
            userId: trade.userId,
            vendorId: trade.vendorId,
            user: trade.user,
            vendor: { username: trade.vendor.username, id: trade.vendor.id },
            type: trade.type,
            amountCrypto: trade.amountCrypto,
            amountFiat: trade.amountFiat,
            paymentMethod: trade.paymentMethod,
            vendorPaymentDetails: finalPaymentDetails,
            amount: trade.amountFiat,
            paidAt: trade.completedAt,
            proofUrl: trade.proofUrl,
            // BUGFIX (2026-05-31): expose canonical timer anchors so the
            // FE can recompute remaining time on cold-start without
            // synthesising it from createdAt + selectedTimeframe (which
            // wipes any extensions).
            createdAt: trade.createdAt,
            expiresAt: trade.expiresAt,
            selectedTimeframe: trade.selectedTimeframe,
            messages: conversation ? conversation.messages : []
        });
    } catch (error) {
        console.error('getTradeDetails error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 3. MARK AS PAID — V2 Conversation/Message schema
//
//    Writes two messages inside a single $transaction:
//      - IMAGE_PROOF      : content = proof URL
//      - SYSTEM_URGENCY   : content = professional notice for both parties
//    Trade transitions to PAID. Notifies vendor (in-app + offline push).
// =============================================================================
exports.markAsPaid = async (req, res) => {
    const prisma        = req.app.get('prisma');
    const io            = req.app.get('socketio');
    const pushIfOffline = req.app.get('pushIfOffline');

    try {
        const { tradeId } = req.body;
        if (!req.file) return res.status(400).json({ success: false, message: 'No image file received.' });

        const tradeIdInt = parseInt(tradeId, 10);
        if (isNaN(tradeIdInt)) return res.status(400).json({ success: false, message: 'Invalid trade id.' });

        // Upload proof to Cloudinary (falls back to local path if not configured)
        const { uploadToCloudinary } = require('../services/cloudinaryService');
        const { url: proofUrl } = await uploadToCloudinary(req.file, 'proofs');

        const result = await prisma.$transaction(async (tx) => {
            const trade = await tx.trade.findUnique({ where: { id: tradeIdInt } });
            if (!trade) throw new Error('Trade not found.');

            // Authorization: only the buyer (the party paying fiat) can mark as paid.
            if (trade.userId !== req.user.id) {
                throw new Error('Only the buyer of this trade can mark it as paid.');
            }
            if (!['PENDING_PAYMENT', 'PENDING'].includes(trade.status)) {
                throw new Error(`Cannot mark as paid: trade status is ${trade.status}.`);
            }

            // Phase H8 BUGFIX (2026-05-27): atomic conditional status flip.
            // Two concurrent markAsPaid calls (network retry, double-tap)
            // could both read PENDING_PAYMENT and both call `tx.trade.update`.
            // Postgres last-writer-wins, both transactions commit, and the
            // chat ends up with TWO IMAGE_PROOF messages for ONE buyer
            // upload — only the second proofUrl persists on the trade row.
            // The conditional updateMany rejects the duplicate cleanly so
            // we never write the second pair of messages.
            const claimed = await tx.trade.updateMany({
                where: { id: tradeIdInt, status: { in: ['PENDING_PAYMENT', 'PENDING'] } },
                data:  { status: 'PAID', proofUrl, paidAt: new Date() }
            });
            if (claimed.count === 0) {
                throw new Error(`Cannot mark as paid: trade status changed concurrently.`);
            }
            // Re-read the canonical row for the response (updateMany only
            // returns a count).
            const updatedTrade = await tx.trade.findUnique({ where: { id: tradeIdInt } });

            // 2. Lazy-create the trade conversation
            const conversation = await _getOrCreateTradeConversation(tx, trade);

            // 3. Write IMAGE_PROOF + SYSTEM_URGENCY messages (V2 schema)
            const proofMessage = await tx.message.create({
                data: {
                    conversationId: conversation.id,
                    senderId:       trade.userId,
                    tradeId:        trade.id,
                    messageType:    'IMAGE_PROOF',
                    content:        proofUrl
                }
            });

            const systemMessage = await tx.message.create({
                data: {
                    conversationId: conversation.id,
                    senderId:       null,
                    tradeId:        trade.id,
                    messageType:    'SYSTEM_URGENCY',
                    content:        PROOF_NOTICE
                }
            });

            // 4. Phase N: vendor notification moved post-commit for full pipeline delivery.

            return { updatedTrade, proofMessage, systemMessage };
        });

        // Side-effects (post-commit)
        const room = `trade_${tradeIdInt}`;
        io.to(room).emit('new_message', {
            id:          result.proofMessage.id,
            sender:      'user',
            content:     proofUrl,
            messageType: 'IMAGE_PROOF',
            createdAt:   result.proofMessage.createdAt
        });
        io.to(room).emit('new_message', {
            id:          result.systemMessage.id,
            sender:      'system',
            content:     PROOF_NOTICE,
            messageType: 'SYSTEM_URGENCY',
            createdAt:   result.systemMessage.createdAt
        });
        io.to(room).emit('trade_update', { status: 'PAID', proofUrl });

        // Phase N: deliver vendor notification via full pipeline (DB + socket + FCM).
        // Replaces the raw io.emit('new_notification') + pushIfOffline which only
        // delivered real-time but never persisted to the notification table.
        setImmediate(async () => {
            try {
                await _getNotificationService(req).sendNotification({
                    userId:   result.updatedTrade.vendorId,
                    title:    'Payment Proof Uploaded',
                    body:     `Buyer uploaded proof of payment for Trade #${tradeIdInt}. Please review and release.`,
                    category: 'VENDOR_PRIORITY',
                    actionPayload: {
                        route:   `/trade/${tradeIdInt}`,
                        action:  'OPEN_TRADE',
                        tradeId: String(tradeIdInt)
                    }
                });
            } catch (err) {
                console.error('[markAsPaid] notification non-fatal:', err.message);
            }
        });

        return res.status(200).json({ success: true, trade: result.updatedTrade });
    } catch (error) {
        console.error('markAsPaid error:', error.message);
        const status = error.message.includes('not found') ? 404
            : error.message.includes('Only') || error.message.includes('Cannot') ? 403
            : 400;
        return res.status(status).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 4. GET TRADE HISTORY
//
// Phase I: cursor pagination. Default limit 20. Optional ?status=... filter
// (single status name or comma-separated list — useful for the home
// "Active Trades" widget which only wants {PENDING, PENDING_PAYMENT, PAID,
// DISPUTED}). Composite indexes (userId, createdAt DESC) and (vendorId,
// createdAt DESC) cover the OR predicate efficiently.
// =============================================================================
exports.getTradeHistory = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    try {
        const { take, cursor, mode, page } = parsePagination(req.query);

        const where = { OR: [{ userId }, { vendorId: userId }] };
        if (req.query.status) {
            const statuses = String(req.query.status)
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
            if (statuses.length === 1) where.status = statuses[0];
            else if (statuses.length > 1) where.status = { in: statuses };
        }

        const findArgs = {
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
        };
        if (cursor) {
            // Phase H10 BUGFIX (2026-05-27): the previous code called
            // parseInt(cursor, 10) here even though parsePagination
            // already returns the cursor as a Number when it parsed
            // cleanly. If the FE sends a non-numeric cursor (junk
            // payload, paste error), parsePagination passes the raw
            // string through and parseInt(...) returns NaN, which
            // Prisma rejects with a P2009 type-coercion error. Trade
            // ids are always integers, so we coerce + validate here
            // and return a clean 400 instead of an opaque 500.
            const cursorId = typeof cursor === 'number'
                ? cursor
                : parseInt(String(cursor), 10);
            if (!Number.isFinite(cursorId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid cursor — must be a numeric trade id.'
                });
            }
            findArgs.cursor = { id: cursorId };
            findArgs.skip = 1;
        }

        const history = await prisma.trade.findMany(findArgs);

        const envelope = buildPageEnvelope(history, take, mode, page);
        // Backwards-compat: legacy callers (no pagination params at all)
        // get the bare `history` array shape. Opted-in callers get the
        // cursor envelope.
        const optedIn = ('cursor' in req.query) || ('limit' in req.query)
            || ('page' in req.query) || ('status' in req.query);
        if (optedIn) {
            res.status(200).json({ success: true, history, ...envelope });
        } else {
            res.status(200).json({ success: true, history });
        }
    } catch (error) {
        console.error('getTradeHistory error:', error.message);
        res.status(500).json({ success: false, message: 'Could not fetch history.' });
    }
};

// =============================================================================
// 5. RAISE DISPUTE
// =============================================================================
exports.disputeTrade = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io     = req.app.get('socketio');

    try {
        const { tradeId, reason } = req.body;
        const userId = req.user.id;
        const id     = parseInt(tradeId, 10);
        if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid trade id.' });

        const trade = await prisma.trade.update({
            where: { id },
            data:  { status: 'DISPUTED' },
            include: {
                vendor: { select: { fcmToken: true } },
                user:   { select: { fcmToken: true } }
            }
        });

        io.to(`trade_${id}`).emit('trade_update', {
            status:        'DISPUTED',
            message:       'Trade has been paused by Support. An admin will join shortly.',
            disputeReason: reason
        });

        io.emit('admin_alert', { type: 'DISPUTE', tradeId: id, reason });

        const targetToken = (userId === trade.vendorId) ? trade.user.fcmToken : trade.vendor.fcmToken;
        if (targetToken) {
            await sendPushNotification(
                targetToken,
                'Trade Disputed',
                `The other party has reported an issue: "${reason}". Support has been notified.`,
                { tradeId: id.toString() }
            );
        }

        res.status(200).json({ success: true, message: 'Dispute raised successfully.' });
    } catch (error) {
        console.error('disputeTrade error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
};

// =============================================================================
// 6. SUBMIT TRADE REVIEW
//
// Phase I4 (2026-05-25): Vendor XP/achievement scan deferred off the request
// path via setImmediate after the HTTP response flushes. Mirrors the Phase I3
// pattern in services/p2p.service.js completeTrade. The review row + the
// reviewee's positiveReviews/negativeReviews counter still update atomically
// inside the transaction (this is what the FE waits to render). The XP +
// achievement scan now runs in its own transaction post-flush via
// gamificationService.processReviewGamification, which emits the same
// gamification_update socket event the FE used to receive after the response.
//
// `gamification` field is kept in the immediate response body (always null
// now) for forward-compat with any caller that still destructures it.
// =============================================================================
exports.submitReview = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { tradeId, isPositive, comment } = req.body;
        const reviewerId = req.user.id;

        const trade = await prisma.trade.findUnique({ where: { id: parseInt(tradeId, 10) } });
        if (!trade) return res.status(404).json({ success: false, message: 'Trade not found.' });
        if (trade.status !== 'COMPLETED')
            return res.status(400).json({ success: false, message: 'Can only review completed trades.' });

        let revieweeId;
        if (reviewerId === trade.userId)        revieweeId = trade.vendorId;
        else if (reviewerId === trade.vendorId) revieweeId = trade.userId;
        else return res.status(403).json({ success: false, message: 'You are not a part of this trade.' });

        // Atomic part: review row + reviewee review-count counter only.
        // Vendor XP / achievement scan is deferred (see setImmediate below).
        const review = await prisma.$transaction(async (tx) => {
            const created = await tx.review.create({
                data: { isPositive, comment, tradeId: trade.id, reviewerId, revieweeId }
            });

            await tx.user.update({
                where: { id: revieweeId },
                data: isPositive
                    ? { positiveReviews: { increment: 1 } }
                    : { negativeReviews: { increment: 1 } }
            });

            return created;
        });

        // Whether the reviewee qualifies for vendor gamification — only
        // when the buyer is reviewing the vendor (XP rewards are vendor-only
        // by design; buyers do not have an XP/level surface).
        const shouldRunVendorGamification = revieweeId === trade.vendorId;

        // Respond immediately. The FE only waits on review create + counter
        // bump (status 201). XP / achievement-unlock arrive via the
        // `gamification_update` socket event a few ms after this response
        // flushes — same surface the FE already used to receive these
        // updates from when this code was inline.
        res.status(201).json({
            success:      true,
            review,
            gamification: null
        });

        // Deferred: XP + achievement scan + socket emit. Runs after the
        // response flushes via setImmediate so a slow gamification path
        // can never delay the FE's "Thanks for reviewing!" snackbar.
        // Errors are caught and logged inside processReviewGamification —
        // the review row is already committed, gamification failures are
        // non-fatal and forward-only on the next review or trade.
        if (shouldRunVendorGamification) {
            setImmediate(async () => {
                try {
                    const gamResult = await gamification.processReviewGamification(prisma, {
                        revieweeId,
                        isPositive,
                        tradeId: trade.id
                    });

                    if (gamResult) {
                        const io = req.app.get('socketio');
                        if (io) {
                            io.to(`user_${revieweeId}`).emit('gamification_update', {
                                type:            'REVIEW_RECEIVED',
                                isPositive,
                                xp:              gamResult.xpResult,
                                newAchievements: gamResult.newAchievements || []
                            });
                        }
                    }
                    // processReviewGamification already logs internally,
                    // so we don't double-log on the gamResult === null case.
                } catch (deferredErr) {
                    console.error(
                        `[submitReview.deferred] tradeId=${trade.id} revieweeId=${revieweeId} ` +
                        `unexpected error: ${deferredErr.message}`
                    );
                }
            });
        }
    } catch (error) {
        if (error.code === 'P2002')
            return res.status(400).json({ success: false, message: 'You have already reviewed this trade.' });
        console.error('submitReview error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
};
