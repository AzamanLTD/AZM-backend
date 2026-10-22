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

const logger = require('../src/config/logger');
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
                adId: parseInt(adId, 10), // Int column (2026-10-20 fix)
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
        logger.error({ err: err }, '[Queue] _emitPositionUpdates error');
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
                adId: parseInt(adId, 10), // Int column (2026-10-20 fix)
                status: 'WAITING',
            },
            orderBy: { joinedAt: 'asc' },
        });

        if (!nextInQueue) {
            logger.info(`[Smart Queue] No waiting users for Ad #${adId}`);
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
            }).catch(err => logger.error({ err: err }, '[Queue] post-commit notification error'));
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
                .catch(err => logger.error({ err: err }, '[Queue] position update error'));
        });

        logger.info(`[Smart Queue] Promoted buyer ${result.buyerId} from queue for Ad #${adId}`);
        return result;
    } catch (error) {
        // Phase H9: another concurrent caller already promoted this row.
        // Caller (typically `p2pController.completeTrade` post-commit
        // hook) treats this as a no-op — the slot they opened needs to
        // be picked up by a future call (or the buyer they promoted in
        // their own outer call already covers them). We log it but
        // don't re-throw, so the trade-complete response stays clean.
        if (error.message === 'QUEUE_RACE') {
            logger.info(`[Smart Queue] race on Ad #${adId} — another completion already promoted; no-op.`);
            return null;
        }
        logger.error({ err: error }, '[Smart Queue] processNextInQueue error');
        throw error;
    }
};

const initiateTradeWithQueue = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const { adId, amountCrypto, amountFiat, paymentMethod } = req.body;
        const userId = req.user.id;

        // ── §r42 idempotency disposition ─────────────────────────────────
        // The route now mounts the shared idempotency authority with the
        // CANONICAL trade-initiation identity (routes/aiRoutes.js), so this
        // handler owns a durable FinancialOperation claim exactly like
        // tradeController.initiateTrade. Until the admission transaction
        // below, every guard here is provably pre-economic: mark the claim
        // releasable so a 4xx validation refusal does not poison the key.
        // The flag is cleared before the admission transaction, and only
        // the branches that provably committed NOTHING set it back.
        res.locals.financialClaimRelease = true;

        const ad = await prisma.ad.findUnique({
            where: { id: parseInt(adId) },
            include: { vendor: true },
        });

        if (!ad) return res.status(404).json({ success: false, message: 'Advertisement no longer exists.' });
        if (ad.vendorId === userId) return res.status(400).json({ success: false, message: 'You cannot trade with your own advertisement.' });
        if (ad.status !== 'ACTIVE') return res.status(400).json({ success: false, message: 'This advertisement is not active.' });

        // CAPACITY POLICY (2026-10-20 A2 — corrected state-machine audit):
        // this optimistic gate MUST use the SAME active-status filter as
        // the in-transaction checks in `tradeController.initiateTrade` and
        // the locked recount below, so all three capacity checks express
        // one explicit policy: every UNFINALIZED trade — PENDING,
        // PENDING_PAYMENT, PAID, DISPUTED — consumes one
        // maxConcurrentTrades slot from creation to a terminal state.
        //
        // The H11 note claimed "PENDING is never persisted" — that premise
        // is FALSE for the V2 vendor-approval flow: `initiateTrade` creates
        // trades with status 'PENDING' and `acceptTrade` transitions them
        // PENDING → PENDING_PAYMENT. Under the old filter a vendor-pending
        // request was invisible to the gate: unlimited initiations slipped
        // past a busy ad, and accepting them all exceeded
        // maxConcurrentTrades and bypassed the waiting queue. PENDING now
        // counts everywhere (initiation is the single capacity gate —
        // acceptTrade never re-checks capacity, so it must not strand an
        // accepted request).
        //
        // This remains an OPTIMISTIC gate — the locked recount below and
        // `tradeController.initiateTrade` re-run the same count under the
        // Ad-row lock, so a race past this gate is still resolved
        // truthfully at the canonical layer.
        const ACTIVE_TRADE_STATUSES = ['PENDING', 'PENDING_PAYMENT', 'PAID', 'DISPUTED'];
        const activeTrades = await prisma.trade.count({
            where: {
                vendorId: ad.vendorId,
                status: { in: ACTIVE_TRADE_STATUSES },
            },
        });

        if (activeTrades >= ad.maxConcurrentTrades) {
            // QUEUE ADMISSION PROTOCOL (2026-10-20 final review): the
            // optimistic ad.status read above is stale by the time we get
            // here — a vendor may have deactivated and archived the ad
            // between the read and this insert. Dedup + admission run in
            // ONE transaction whose first statement takes the same Ad-row
            // FOR UPDATE lock that archiveAd/deactivateAd/toggleAdStatus
            // take, and the ad's CURRENT status is re-read under that
            // lock: a WAITING entry can never be created for an ad that is
            // no longer ACTIVE (or is legacy-marked archived via
            // archivedAt). Admission never takes the TradeAccount lock, so
            // the TradeAccount→Ad lock order cannot invert.
            // TYPE FIX (found during the lock audit): TradeQueue.buyerId
            // and adId are Int columns — the previous String(...) wrappers
            // made every queue admission on this path throw a Prisma
            // validation error (this path never succeeded).
            // A queue-entry insert may commit from here on: a committed
            // admission must RETAIN its durable identity (the auto-commit
            // bookkeeping on the 200 stores the queued response for replay).
            res.locals.financialClaimRelease = false;
            const admission = await prisma.$transaction(async (tx) => {
                const locked = await tx.$queryRaw`
                    SELECT "status", "archivedAt", "maxConcurrentTrades" FROM "Ad"
                    WHERE "id" = ${parseInt(adId)}
                    FOR UPDATE`;
                if (!locked[0] || locked[0].status !== 'ACTIVE' || locked[0].archivedAt) {
                    return { refused: true };
                }

                // CAPACITY RECHECK UNDER THE LOCK (2026-10-20 review): the
                // optimistic count above said the vendor was busy, but a
                // slot may have freed (trade completed / cancelled) between
                // that read and this lock. Re-run the CANONICAL active-trade
                // filter inside the transaction: if a slot is now free, do
                // NOT create a WAITING entry — the buyer proceeds through
                // the canonical trade-initiation path (below, outside this
                // transaction), which rechecks status and capacity under its
                // own Ad-row lock and keeps its idempotency authority.
                // canonical fall-through is the SAME direct handler call the
                // not-busy optimistic path has always used.
                const activeNow = await tx.trade.count({
                    where: {
                        vendorId: ad.vendorId,
                        // A2: same explicit capacity policy as the
                        // optimistic gate and tradeController (PENDING counts).
                        status: { in: ACTIVE_TRADE_STATUSES },
                    },
                });
                if (activeNow < locked[0].maxConcurrentTrades) {
                    return { capacityFreed: true };
                }

                const existingQueueEntry = await tx.tradeQueue.findFirst({
                    where: {
                        buyerId: userId,
                        adId: parseInt(adId),
                        status: 'WAITING',
                    },
                });

                if (existingQueueEntry) {
                    return { alreadyQueued: existingQueueEntry };
                }

                const queueEntry = await tx.tradeQueue.create({
                    data: {
                        buyerId: userId,
                        adId: parseInt(adId),
                        status: 'WAITING',
                    },
                });

                const queuePosition = await tx.tradeQueue.count({
                    where: {
                        adId: parseInt(adId),
                        status: 'WAITING',
                        joinedAt: { lte: queueEntry.joinedAt },
                    },
                });

                return { queueEntry, queuePosition };
            });

            if (admission.refused) {
                // Provably pre-economic: the refusal came from the locked
                // recheck at the transaction's first statement — nothing was
                // written. Release the claim so the key stays reusable.
                res.locals.financialClaimRelease = true;
                return res.status(400).json({ success: false, message: 'This advertisement is not active.' });
            }
            if (admission.capacityFreed) {
                // A slot freed between the optimistic count and the locked
                // recheck: no WAITING entry was created — the admission
                // transaction committed nothing. Hand the request to the
                // canonical trade-initiation path (the same direct
                // fall-through the not-busy optimistic branch uses), which
                // rechecks status and capacity inside its own transaction.
                // initiateTrade re-manages this claim's disposition flags
                // from its own pre-economic mark; the shared claim
                // (res.locals.financialOperation) stays with this request,
                // so a created trade commits under the SAME durable identity.
                res.locals.financialClaimRelease = true;
                const tradeController = require('./tradeController');
                return tradeController.initiateTrade(req, res);
            }
            if (admission.alreadyQueued) {
                // A1: converge on the canonical path's already-queued
                // contract. The pre-A1 shape returned queueEntry.id (a
                // UUID) under the queuePosition name — the fresh-join
                // response returns a true ordinal position, so the two
                // responses disagreed on the same field. Both paths now
                // return the same alreadyQueued envelope with the buyer's
                // true ordinal position (WAITING rows joined no later).
                const alreadyPosition = await prisma.tradeQueue.count({
                    where: {
                        adId: parseInt(adId),
                        status: 'WAITING',
                        joinedAt: { lte: admission.alreadyQueued.joinedAt },
                    },
                });
                return res.status(200).json({
                    success: true,
                    queued: true,
                    alreadyQueued: true,
                    message: 'You are already in the queue for this ad.',
                    queuePosition: alreadyPosition,
                    queueId: admission.alreadyQueued.id,
                    joinedAt: admission.alreadyQueued.joinedAt,
                });
            }

            const { queueEntry, queuePosition } = admission;

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
        logger.error('[Smart Queue] initiateTradeWithQueue error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getQueueStatus = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    try {
        const { adId } = req.query;

        // (2026-10-20 fix) TradeQueue.buyerId/adId are Int columns — the
        // previous String(...) filters threw PrismaClientValidationError and
        // 500'd the whole status read. Validate inputs truthfully instead.
        const whereClause = { buyerId: userId, status: 'WAITING' };
        if (adId !== undefined && adId !== null && adId !== '') {
            const parsedAdId = parseInt(adId, 10);
            if (Number.isNaN(parsedAdId)) {
                return res.status(400).json({ success: false, message: 'adId must be a valid ad id.' });
            }
            whereClause.adId = parsedAdId;
        }

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
        logger.error('[Smart Queue] getQueueStatus error:', error);
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
        // (2026-10-20 fix) entry.buyerId is a numeric Int column — the
        // previous String(userId) comparison ALWAYS rejected the legitimate
        // owner. Compare numerically.
        if (Number(entry.buyerId) !== Number(userId)) return res.status(403).json({ success: false, message: 'Unauthorized.' });
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
                .catch(err => logger.error({ err: err }, '[Queue] position update on leave error'));
        });

        res.status(200).json({ success: true, message: 'Left the queue successfully.' });
    } catch (error) {
        logger.error('[Smart Queue] leaveQueue error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    initiateTradeWithQueue,
    processNextInQueue,
    getQueueStatus,
    leaveQueue,
};
