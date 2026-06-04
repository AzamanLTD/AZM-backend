// controllers/queueController.js
// =============================================================================
// AZAMAN V2 — QUEUE CONTROLLER (Phase P1 update)
//
// Smart Queue: when a vendor is at max concurrent trades, buyers are queued.
// When a slot opens (trade completes/cancels), processNextInQueue promotes
// the next buyer and emits `queue_promoted` so the FE can notify the user.
//
// Socket events emitted:
//   queue_joined           → { adId, queueId, position, message }
//   queue_promoted         → { queueId, adId, status }  (slot is open, go trade)
//   queue_position_update  → { queueId, position }      (position changed)
//   queue_update           → { queueId, status, adId }  (legacy compat)
// =============================================================================

const NotificationService = require('../services/notificationService');

// =============================================================================
// HELPER: Emit position updates to all WAITING buyers in a queue after a
// buyer leaves or is promoted (their positions all shift down by 1).
// =============================================================================
const _emitPositionUpdates = async (prisma, io, adId, excludeQueueId) => {
    if (!io) return;

    try {
        const waitingEntries = await prisma.tradeQueue.findMany({
            where: {
                adId: String(adId),
                status: 'WAITING',
            },
            orderBy: { joinedAt: 'asc' },
            select: { id: true, buyerId: true },
        });

        // Each entry's position is its 1-based index in the sorted list
        for (let i = 0; i < waitingEntries.length; i++) {
            const entry = waitingEntries[i];
            if (entry.id === excludeQueueId) continue;

            io.to(`user_${entry.buyerId}`).emit('queue_position_update', {
                queueId: entry.id,
                position: i + 1,
            });
        }
    } catch (err) {
        console.error('[Queue] _emitPositionUpdates error:', err.message);
    }
};

// =============================================================================
// processNextInQueue — called when a trade slot opens on an ad
//
// Phase P1 fix: now emits `queue_promoted` with the queueId + adId so the
// FE WaitingRoomScreen can auto-navigate the buyer back to the marketplace
// to initiate their trade. Also emits `queue_position_update` to remaining
// WAITING buyers so they see their position decrement in real time.
//
// Accepts { prisma, io } explicitly so callers from route handlers pass
// their app-level instances (the old global.* pattern was never wired).
// =============================================================================
const processNextInQueue = async (adId, { prisma, io } = {}) => {
    // Fallback to globals for backward compat (if someone ever wires them)
    prisma = prisma || global.prismaInstance;
    io = io || global.socketIoInstance;

    try {
        const nextInQueue = await prisma.tradeQueue.findFirst({
            where: {
                adId: String(adId),
                status: 'WAITING',
            },
            orderBy: { joinedAt: 'asc' },
        });

        if (!nextInQueue) {
            console.log(`[Smart Queue] No waiting users for Ad #${adId}`);
            return null;
        }

        const result = await prisma.$transaction(async (tx) => {
            // Phase H9 BUGFIX (2026-05-27): atomic conditional flip.
            // The previous code path was:
            //
            //   1. findFirst (outside tx) — sees one WAITING row.
            //   2. $transaction { update id -> PROCESSED }.
            //
            // Two concurrent processNextInQueue calls (vendor completes
            // two trades back-to-back) both saw the same WAITING row in
            // step 1, both flipped it to PROCESSED in step 2, and both
            // fired `queue_promoted` to the same buyer. The slot count
            // opened by 2 but only 1 buyer was promoted; a second waiter
            // was never advanced.
            //
            // The conditional `updateMany` flips the row to PROCESSED if
            // and only if it's still WAITING — the second caller gets
            // count=0 and aborts cleanly so the OUTER call (the next
            // completion) is responsible for promoting the next waiter.
            const claimed = await tx.tradeQueue.updateMany({
                where: { id: nextInQueue.id, status: 'WAITING' },
                data: { status: 'PROCESSED' },
            });
            if (claimed.count === 0) {
                throw new Error('QUEUE_RACE');
            }
            // Re-read for the response (updateMany returns count only).
            const queued = await tx.tradeQueue.findUnique({
                where: { id: nextInQueue.id },
            });

            return queued;
        });

        // Fire notification via notificationService (DB + socket + FCM)
        const notifSvc = new NotificationService(prisma, io);
        setImmediate(() => {
            notifSvc.sendNotification({
                userId: parseInt(result.buyerId),
                title: 'Your Turn to Trade!',
                body: `A slot opened on Ad #${adId}. Tap to start your trade now.`,
                category: 'GENERAL',
                actionPayload: {
                    action: 'OPEN_AD',
                    adId: String(adId),
                    queueId: result.id,
                }
            }).catch(err => console.error('[Queue] post-commit notification error:', err.message));
        });

        if (io) {
            // Primary event: the FE WaitingRoomScreen listens for this
            io.to(`user_${result.buyerId}`).emit('queue_promoted', {
                queueId: result.id,
                adId: String(adId),
                status: 'PROMOTED',
            });

            // Legacy compat event (tradeController queue path also uses this)
            io.to(`user_${result.buyerId}`).emit('queue_update', {
                queueId: result.id,
                status: 'PROCESSED',
                adId: adId,
            });
        }

        // Emit position updates to remaining WAITING buyers
        setImmediate(() => {
            _emitPositionUpdates(prisma, io, adId, result.id)
                .catch(err => console.error('[Queue] position update error:', err.message));
        });

        console.log(`[Smart Queue] Promoted buyer ${result.buyerId} from queue for Ad #${adId}`);
        return result;
    } catch (error) {
        // Phase H9: another concurrent caller already promoted this row.
        // Caller (typically `p2pController.completeTrade` post-commit
        // hook) treats this as a no-op — the slot they opened needs to
        // be picked up by a future call (or the buyer they promoted in
        // their own outer call already covers them). We log it but
        // don't re-throw, so the trade-complete response stays clean.
        if (error.message === 'QUEUE_RACE') {
            console.log(`[Smart Queue] race on Ad #${adId} — another completion already promoted; no-op.`);
            return null;
        }
        console.error('[Smart Queue] processNextInQueue error:', error.message);
        throw error;
    }
};

const initiateTradeWithQueue = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const { adId, amountCrypto, amountFiat, paymentMethod } = req.body;
        const userId = req.user.id;

        const ad = await prisma.ad.findUnique({
            where: { id: parseInt(adId) },
            include: { vendor: true },
        });

        if (!ad) return res.status(404).json({ success: false, message: 'Advertisement no longer exists.' });
        if (ad.vendorId === userId) return res.status(400).json({ success: false, message: 'You cannot trade with your own advertisement.' });
        if (ad.status !== 'ACTIVE') return res.status(400).json({ success: false, message: 'This advertisement is not active.' });

        // Phase H11 BUGFIX (2026-05-27): the active-status filter MUST
        // match the in-transaction check in `tradeController.initiateTrade`
        // (line ~138) so the two paths agree on what counts as an
        // "active trade" for cap purposes. Drift between the two filters
        // could let a buyer pass the optimistic gate here only to bounce
        // off the canonical check inside the trade-creation transaction
        // — confusing UX and wasted round-trips.
        //
        // Canonical filter is `[PENDING_PAYMENT, PAID, DISPUTED]`. The
        // previous version used `[PENDING, PENDING_PAYMENT, PAID]` which
        // was wrong on two counts:
        //   • `PENDING` is never persisted (Trade.status defaults to
        //     PENDING_PAYMENT and no code path ever flips to PENDING).
        //   • `DISPUTED` was missing — a vendor with an ongoing dispute
        //     would be considered "free" here but blocked at the
        //     in-transaction check, producing an inconsistent answer.
        //
        // This is an OPTIMISTIC gate — `tradeController.initiateTrade`
        // re-runs the same count atomically inside `$transaction`, so a
        // race that slips a buyer past this gate will still queue them
        // correctly at the canonical layer. No money loss; the fix is
        // about consistent UX and avoiding wasted round-trips.
        const activeTrades = await prisma.trade.count({
            where: {
                vendorId: ad.vendorId,
                status: { in: ['PENDING_PAYMENT', 'PAID', 'DISPUTED'] },
            },
        });

        if (activeTrades >= ad.maxConcurrentTrades) {
            const existingQueueEntry = await prisma.tradeQueue.findFirst({
                where: {
                    buyerId: String(userId),
                    adId: String(adId),
                    status: 'WAITING',
                },
            });

            if (existingQueueEntry) {
                return res.status(200).json({
                    success: true,
                    queued: true,
                    message: 'You are already in the queue for this ad.',
                    queuePosition: existingQueueEntry.id,
                    joinedAt: existingQueueEntry.joinedAt,
                });
            }

            const queueEntry = await prisma.tradeQueue.create({
                data: {
                    buyerId: String(userId),
                    adId: String(adId),
                    status: 'WAITING',
                },
            });

            const queuePosition = await prisma.tradeQueue.count({
                where: {
                    adId: String(adId),
                    status: 'WAITING',
                    joinedAt: { lte: queueEntry.joinedAt },
                },
            });

            if (io) {
                io.to(`user_${userId}`).emit('queue_joined', {
                    adId: adId,
                    queueId: queueEntry.id,
                    position: queuePosition,
                    message: `Ad #${adId} is at capacity. You have been added to the queue.`,
                });
            }

            return res.status(200).json({
                success: true,
                queued: true,
                message: 'Ad is at max concurrent trades. You have been added to the queue.',
                queuePosition,
                queueId: queueEntry.id,
                estimatedWait: 'Until a trade slot opens.',
            });
        }

        const tradeController = require('./tradeController');
        return tradeController.initiateTrade(req, res);
    } catch (error) {
        console.error('[Smart Queue] initiateTradeWithQueue error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getQueueStatus = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    try {
        const { adId } = req.query;

        const whereClause = { buyerId: String(userId), status: 'WAITING' };
        if (adId) whereClause.adId = String(adId);

        const queueEntries = await prisma.tradeQueue.findMany({
            where: whereClause,
            orderBy: { joinedAt: 'asc' },
            include: {
                ad: {
                    select: {
                        id: true,
                        type: true,
                        pricePerUSD: true,
                        vendor: { select: { username: true } },
                    },
                },
            },
        });

        const positions = await Promise.all(
            queueEntries.map(async (entry) => {
                const position = await prisma.tradeQueue.count({
                    where: {
                        adId: entry.adId,
                        status: 'WAITING',
                        joinedAt: { lte: entry.joinedAt },
                    },
                });
                return { ...entry, position };
            })
        );

        res.status(200).json({ success: true, queue: positions });
    } catch (error) {
        console.error('[Smart Queue] getQueueStatus error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// leaveQueue — Phase P1 update: emits queue_position_update to remaining
// WAITING buyers so they see their position decrement in real time.
// =============================================================================
const leaveQueue = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    const userId = req.user.id;

    try {
        const { queueId } = req.params;

        const entry = await prisma.tradeQueue.findUnique({
            where: { id: queueId },
        });

        if (!entry) return res.status(404).json({ success: false, message: 'Queue entry not found.' });
        if (entry.buyerId !== String(userId)) return res.status(403).json({ success: false, message: 'Unauthorized.' });
        if (entry.status !== 'WAITING') return res.status(400).json({ success: false, message: 'Can only leave WAITING queue entries.' });

        // Phase H9 BUGFIX (2026-05-27): atomic conditional flip. Without
        // a `status: 'WAITING'` precondition, a leaveQueue + concurrent
        // processNextInQueue race could promote a buyer who just left
        // (the race fires `queue_promoted` to a buyer whose queue entry
        // is moments away from CANCELLED). The conditional updateMany
        // means whichever transaction commits first wins, and the second
        // gets count=0 and reports the row as already-finalized.
        const claimed = await prisma.tradeQueue.updateMany({
            where: { id: queueId, status: 'WAITING' },
            data: { status: 'CANCELLED' },
        });
        if (claimed.count === 0) {
            return res.status(409).json({
                success: false,
                message: 'Queue entry status changed concurrently — refresh to see the latest state.'
            });
        }

        // Emit position updates to remaining WAITING buyers for this ad
        setImmediate(() => {
            _emitPositionUpdates(prisma, io, entry.adId, queueId)
                .catch(err => console.error('[Queue] position update on leave error:', err.message));
        });

        res.status(200).json({ success: true, message: 'Left the queue successfully.' });
    } catch (error) {
        console.error('[Smart Queue] leaveQueue error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    initiateTradeWithQueue,
    processNextInQueue,
    getQueueStatus,
    leaveQueue,
};
