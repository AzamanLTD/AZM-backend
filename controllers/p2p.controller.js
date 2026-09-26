// controllers/p2p.controller.js
// =============================================================================
// AZAMAN V2 — P2P CONTROLLER  (Phase 2.2)
// Thin HTTP adapter. Zero business logic — everything delegates to
// services/p2p.service.js.
//
// Pattern matches the project standard:
//   const prisma            = req.app.get('prisma');
//   const io                = req.app.get('socketio');
//   const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
//   const pushIfOffline     = req.app.get('pushIfOffline');
//
// Routes (mounted at /api/p2p in server.js):
//   POST /api/p2p/ping            — buyer pings vendor   (protect)
//   POST /api/p2p/ping/accept     — vendor accepts ping  (protect)
//   POST /api/p2p/underpayment    — mark underpaid       (protect)
//   POST /api/p2p/overpayment     — flag overpayment     (protect)
//   POST /api/p2p/complete        — complete trade       (protect)
// =============================================================================

const logger = require('../src/config/logger');
const p2pService = require('../services/p2p.service');
const { audit } = require('../utils/audit');

/**
 * Phase N helper: fire any _notifications returned by p2p.service functions
 * through the notificationService pipeline (DB + socket + FCM).
 * Fire-and-forget via setImmediate so the HTTP response is never delayed.
 */
function _firePostCommitNotifications(req, notifications) {
    if (!notifications || notifications.length === 0) return;
    const notifSvc = req.app.get('notificationService');
    if (!notifSvc) return;
    setImmediate(async () => {
        for (const n of notifications) {
            try {
                await notifSvc.sendNotification(n);
            } catch (err) {
                logger.error({ err }, '[p2p._firePostCommitNotifications] non-fatal');
            }
        }
    });
}

// =============================================================================
// GET /api/p2p/ads
// Returns all active P2P advertisements with vendor details and live oracle
// price recalculation. Public-facing endpoint for the marketplace feed.
// =============================================================================
exports.getAds = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        const baseRate = settings ? settings.liveUsdToGhs : 12.50;

        let ads = await prisma.ad.findMany({
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            include: {
                vendor: {
                    select: {
                        id: true,
                        username: true,
                        tradesCompleted: true,
                        completionRate: true,
                        positiveReviews: true,
                        negativeReviews: true,
                        kycStatus: true,
                        createdAt: true
                    }
                }
            }
        });

        // Recalculate live oracle prices for margin-based ads
        if (settings) {
            ads = ads.map(ad => {
                if (ad.margin !== null && ad.margin !== undefined) {
                    let vendorPrice = baseRate * (1 + (ad.margin / 100));
                    // bankMargin and thirdPartyMargin are stored as percentages (e.g., 0.03 = 3%)
                    // Applied as a percentage of the base rate to get the GHS spread
                    let marginPct = Number(settings.bankMargin);
                    const methodStr = (ad.paymentMethod || '').toLowerCase();
                    if (
                        methodStr.includes('cashapp') ||
                        methodStr.includes('zelle') ||
                        methodStr.includes('venmo')
                    ) {
                        marginPct = Number(settings.thirdPartyMargin);
                    }
                    const adminFeeGhs = baseRate * marginPct;
                    ad.pricePerUSD = ad.type === 'BUY'
                        ? vendorPrice - adminFeeGhs
                        : vendorPrice + adminFeeGhs;
                }
                return ad;
            });
        }

        // Phase UI Sprint (2026-05-26): inject `availableUsdc` per ad —
        // the FE marketplace card reads this to render the per-ad
        // liquidity badge ("Available 2,340 USDC"). For SELL ads this
        // is the vendor's currently-unallocated USDC (what they could
        // commit to a new escrow); for BUY ads the vendor doesn't
        // escrow upfront, so the visible cap is the per-trade max.
        const vendorIds = [...new Set(ads.map(a => a.vendorId))];
        if (vendorIds.length > 0) {
            const balances = await prisma.user.findMany({
                where: { id: { in: vendorIds } },
                select: { id: true, vendorUnallocatedBalance: true }
            });
            const balanceById = Object.fromEntries(
                balances.map(u => [u.id, Number(u.vendorUnallocatedBalance)])
            );
            ads = ads.map(ad => {
                const vendorPool = balanceById[ad.vendorId] ?? 0;
                const perTradeCap = Number(ad.maxLimit);
                const availableUsdc = ad.type === 'BUY'
                    ? perTradeCap
                    : vendorPool;
                return { ...ad, availableUsdc };
            });
        }

        return res.status(200).json({
            success: true,
            data: ads
        });

    } catch (error) {
        logger.error({ err: error }, '[p2p.getAds] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ── Shared error handler ─────────────────────────────────────────────────────
const _handleError = (res, label, error) => {
    logger.error(`[p2p.${label}] error:`, error.message);
    const status = error.message.includes('not found') ? 404
        : error.message.includes('Only') || error.message.includes('Cannot') ? 403
        : 400;
    return res.status(status).json({ success: false, message: error.message });
};


// =============================================================================
// POST /api/p2p/ping
// Buyer pings vendor when vendorUnallocatedBalance is insufficient.
// Body: { tradeId }
// =============================================================================
exports.pingVendor = async (req, res) => {
    const prisma        = req.app.get('prisma');
    const io            = req.app.get('socketio');
    const pushIfOffline = req.app.get('pushIfOffline');

    try {
        const tradeId = parseInt(req.body.tradeId, 10);
        const buyerId = req.user.id;

        if (!tradeId || isNaN(tradeId))
            return res.status(400).json({ success: false, message: 'tradeId is required.' });

        const data = await p2pService.pingVendor(prisma, { tradeId, buyerId });

        // Phase N: deliver notifications via full pipeline (DB + socket + FCM)
        _firePostCommitNotifications(req, data._notifications);

        // Real-time ping to vendor's socket room
        const trade = await prisma.trade.findUnique({
            where:  { id: tradeId },
            select: { vendorId: true }
        });

        if (trade?.vendorId) {
            io.to(`user_${trade.vendorId}`).emit('vendor_ping', {
                tradeId,
                pingExpiresAt: data.pingExpiresAt,
                message: 'Buyer is waiting — please top up your unallocated balance.'
            });

            await pushIfOffline(
                trade.vendorId,
                '🔔 Buyer Ping',
                `Buyer is waiting on Trade #${tradeId}. Respond within 5 minutes.`,
                { type: 'VENDOR_PING', tradeId: String(tradeId) }
            );
        }

        return res.status(200).json({
            success: true,
            message: 'Vendor has been pinged successfully.',
            data
        });
    } catch (error) {
        return _handleError(res, 'pingVendor', error);
    }
};


// =============================================================================
// POST /api/p2p/ping/accept
// Vendor accepts the ping by topping up vendorUnallocatedBalance.
// Body: { tradeId, topUpAmount }
// =============================================================================
exports.acceptPing = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const tradeId     = parseInt(req.body.tradeId, 10);
        const topUpAmount = parseFloat(req.body.topUpAmount);
        const vendorId    = req.user.id;

        if (!tradeId || isNaN(tradeId))
            return res.status(400).json({ success: false, message: 'tradeId is required.' });
        if (!topUpAmount || isNaN(topUpAmount) || topUpAmount <= 0)
            return res.status(400).json({ success: false, message: 'topUpAmount must be a positive number.' });

        const data = await p2pService.acceptPing(prisma, { tradeId, vendorId, topUpAmount });

        // Phase N: deliver notifications via full pipeline (DB + socket + FCM)
        _firePostCommitNotifications(req, data._notifications);

        // Emit updated balances to vendor
        await emitBalanceUpdate(vendorId);

        // Notify the buyer's socket
        const trade = await prisma.trade.findUnique({
            where:  { id: tradeId },
            select: { userId: true }
        });
        if (trade?.userId) {
            io.to(`user_${trade.userId}`).emit('ping_accepted', {
                tradeId,
                message: 'Vendor has topped up. You may now proceed.',
                topUpAmount
            });
        }

        // Update the trade room with a status hint
        io.to(`trade_${tradeId}`).emit('trade_update', {
            tradeId,
            message: `Vendor topped up ${topUpAmount} USDC. Trade is ready to proceed.`
        });

        return res.status(200).json({
            success: true,
            message: `Successfully moved ${topUpAmount} USDC to unallocated balance.`,
            data
        });
    } catch (error) {
        return _handleError(res, 'acceptPing', error);
    }
};


// =============================================================================
// POST /api/p2p/underpayment
// Vendor or admin marks a trade as underpaid.
// Body: { tradeId, paidAmountFiat, intentional? }
// =============================================================================
exports.markUnderpaid = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
    const pushIfOffline     = req.app.get('pushIfOffline');

    try {
        const tradeId       = parseInt(req.body.tradeId, 10);
        const paidAmountFiat = parseFloat(req.body.paidAmountFiat);
        const intentional   = req.body.intentional === true || req.body.intentional === 'true';
        const callerUserId  = req.user.id;

        if (!tradeId || isNaN(tradeId))
            return res.status(400).json({ success: false, message: 'tradeId is required.' });
        if (isNaN(paidAmountFiat) || paidAmountFiat < 0)
            return res.status(400).json({ success: false, message: 'paidAmountFiat must be a non-negative number.' });

        const data = await p2pService.markUnderpaid(prisma, {
            tradeId,
            callerUserId,
            paidAmountFiat,
            intentional
        });

        // Phase N: deliver notifications via full pipeline (DB + socket + FCM)
        _firePostCommitNotifications(req, data._notifications);

        // Pre-fetch trade parties for side-effects
        const trade = await prisma.trade.findUnique({
            where:  { id: tradeId },
            select: { userId: true, vendorId: true }
        });

        if (trade) {
            await emitBalanceUpdate(trade.userId);
            await emitBalanceUpdate(trade.vendorId);

            // Emit trade status update to the trade room
            io.to(`trade_${tradeId}`).emit('trade_update', {
                tradeId,
                status:  'CANCELLED',
                message: `Underpayment recorded. Paid portion released to buyer, remainder refunded to vendor.`
            });

            // If a ban was triggered, push alert to buyer
            if (data.strikeResult?.banned) {
                io.to(`user_${trade.userId}`).emit('account_restricted', {
                    reason:      'Repeated intentional underpayment',
                    strikeCount: data.strikeResult.newCount
                });

                await pushIfOffline(
                    trade.userId,
                    '🚫 Account Restricted',
                    `Your account has been restricted after ${data.strikeResult.newCount} strikes.`,
                    { type: 'ACCOUNT_RESTRICTED' }
                );
            } else if (data.strikeResult) {
                await pushIfOffline(
                    trade.userId,
                    '⚠️ Strike Issued',
                    `You have received strike ${data.strikeResult.newCount}/3 for intentional underpayment.`,
                    { type: 'STRIKE_ISSUED', strikeCount: data.strikeResult.newCount }
                );
            }
        }

        return res.status(200).json({
            success: true,
            message: `Trade #${tradeId} marked as underpaid. Adjustments applied.`,
            data
        });
    } catch (error) {
        return _handleError(res, 'markUnderpaid', error);
    }
};


// =============================================================================
// POST /api/p2p/overpayment
// Buyer flags they overpaid — disputed difference is frozen in disputeEscrow.
// Body: { tradeId, overpaidAmountUsdc }
// =============================================================================
exports.flagOverpayment = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
    const pushIfOffline     = req.app.get('pushIfOffline');

    try {
        const tradeId            = parseInt(req.body.tradeId, 10);
        const overpaidAmountUsdc = parseFloat(req.body.overpaidAmountUsdc);
        const buyerId            = req.user.id;

        if (!tradeId || isNaN(tradeId))
            return res.status(400).json({ success: false, message: 'tradeId is required.' });
        if (!overpaidAmountUsdc || isNaN(overpaidAmountUsdc) || overpaidAmountUsdc <= 0)
            return res.status(400).json({ success: false, message: 'overpaidAmountUsdc must be a positive number.' });

        const data = await p2pService.flagOverpayment(prisma, {
            tradeId,
            buyerId,
            overpaidAmountUsdc
        });

        // Phase N: deliver notifications via full pipeline (DB + socket + FCM)
        _firePostCommitNotifications(req, data._notifications);

        const trade = await prisma.trade.findUnique({
            where:  { id: tradeId },
            select: { userId: true, vendorId: true }
        });

        if (trade) {
            await emitBalanceUpdate(trade.vendorId);

            // Alert trade room
            io.to(`trade_${tradeId}`).emit('trade_update', {
                tradeId,
                status:  'DISPUTED',
                message: `Overpayment dispute opened. ${overpaidAmountUsdc} USDC frozen pending admin review.`
            });

            // Alert all admin sockets
            io.emit('admin_alert', {
                type:             'OVERPAYMENT_DISPUTE',
                tradeId,
                overpaidAmountUsdc,
                buyerId,
                timestamp:        new Date().toISOString()
            });

            // Push to vendor (offline)
            await pushIfOffline(
                trade.vendorId,
                '⚠️ Overpayment Dispute Filed',
                `Buyer disputes an overpayment of ${overpaidAmountUsdc} USDC on Trade #${tradeId}.`,
                { type: 'OVERPAYMENT_DISPUTE', tradeId: String(tradeId) }
            );
        }

        return res.status(200).json({
            success: true,
            message: `Overpayment dispute filed. ${overpaidAmountUsdc} USDC frozen in dispute escrow.`,
            data
        });
    } catch (error) {
        // Phase H11 (2026-05-27): a second concurrent flagOverpayment
        // hit the @unique txHash constraint on `OVERPAYMENT_FREEZE_<id>`.
        // The whole transaction (including the balance freeze) was
        // rolled back by Prisma. Treat as idempotent success — the
        // first call already moved the funds to disputeEscrowBalance.
        if (error.code === 'P2002' && Array.isArray(error.meta?.target) && error.meta.target.includes('txHash')) {
            return res.status(200).json({
                success: true,
                idempotent: true,
                message: 'Overpayment already flagged for this trade.'
            });
        }
        return _handleError(res, 'flagOverpayment', error);
    }
};


// =============================================================================
// POST /api/p2p/complete
// Vendor (SELL ad) or buyer (BUY ad) releases assets.
// Applies tiered margin split — admin cut routed to SystemProfitFees.
// Body: { tradeId }
// =============================================================================
exports.completeTrade = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
    const pushIfOffline     = req.app.get('pushIfOffline');

    try {
        const tradeId         = parseInt(req.body.tradeId, 10);
        const releasedByUserId = req.user.id;

        if (!tradeId || isNaN(tradeId))
            return res.status(400).json({ success: false, message: 'tradeId is required.' });

        const data = await p2pService.completeTrade(prisma, { tradeId, releasedByUserId });

        // Phase N: deliver notifications via full pipeline (DB + socket + FCM)
        _firePostCommitNotifications(req, data._notifications);

        // Emit live balance updates to both parties
        const trade = await prisma.trade.findUnique({
            where:  { id: tradeId },
            select: { userId: true, vendorId: true }
        });

        if (trade) {
            await emitBalanceUpdate(trade.userId);
            await emitBalanceUpdate(trade.vendorId);

            // Broadcast completion to the trade room
            io.to(`trade_${tradeId}`).emit('trade_update', {
                tradeId,
                status:       'COMPLETED',
                netUsdc:      data.netUsdc,
                vendorProfit: data.vendorCutUsdc,
                message:      'Assets released successfully. Trade is complete.'
            });

            // Phase I3: gamification socket emit moved into the deferred
            // setImmediate block below. The previous in-line emit has been
            // removed because `data.gamification` is always null in the
            // immediate response now (the engine runs after this handler
            // returns).

            // Push offline notifications
            await pushIfOffline(
                trade.userId,
                '🎉 Trade Complete!',
                `Trade #${tradeId} is complete. ${data.netUsdc.toFixed(4)} USDC settled.`,
                { type: 'TRADE_COMPLETE', tradeId: String(tradeId) }
            );

            await pushIfOffline(
                trade.vendorId,
                '✅ Trade Settled',
                `Trade #${tradeId} complete. Fee share: ${data.vendorCutUsdc.toFixed(4)} USDC.`,
                { type: 'TRADE_COMPLETE', tradeId: String(tradeId) }
            );

            // ── Phase I3: deferred vendor gamification ───────────────────
            // Run XP / streak / level / achievement processing AFTER the
            // HTTP response goes out. setImmediate yields back to the event
            // loop first, lets Express flush the response, then runs the
            // gamification engine in its own transaction. The vendor sees
            // an instant trade-complete confirmation; XP/level/achievements
            // arrive a few ms later via the `gamification_update` socket
            // event already wired into the FE's vendor-stats provider.
            //
            // Errors are caught and logged inside processPostCompletionGamification —
            // they cannot fail the already-settled trade.
            setImmediate(async () => {
                try {
                    const gamInputs = data._gamificationInputs;
                    if (!gamInputs) return;

                    const gamResult = await p2pService.processPostCompletionGamification(
                        prisma,
                        {
                            tradeId,
                            vendorId:         gamInputs.vendorId,
                            tradeVolumeUsdc:  gamInputs.tradeVolumeUsdc,
                            vendorProfitUsdc: gamInputs.vendorProfitUsdc
                        }
                    );

                    if (gamResult && io) {
                        io.to(`user_${trade.vendorId}`).emit('gamification_update', {
                            type:            'TRADE_COMPLETED',
                            tradeId,
                            xpAwarded:       gamResult.xpAwarded,
                            totalXpGained:   gamResult.totalXpGained,
                            newXpTotal:      gamResult.newXpTotal,
                            level:           gamResult.level,
                            leveledUp:       gamResult.leveledUp,
                            previousLevel:   gamResult.previousLevel,
                            streak:          gamResult.streak,
                            newAchievements: gamResult.newAchievements || []
                        });
                    }
                } catch (deferredErr) {
                    // processPostCompletionGamification already logs internally,
                    // but a setImmediate-level error (e.g. socket emit failure)
                    // still needs a safety net so it doesn't propagate as an
                    // unhandled rejection.
                    logger.error(
                        `[p2p.completeTrade] deferred gamification top-level error tradeId=${tradeId}: ${deferredErr.message}`
                    );
                }

                // ── Phase E1: AZM earn mechanics (buyer + referral + milestones) ──
                try {
                    const azmSvc = req.app.get('azmRewardService');
                    if (!azmSvc) return;

                    // 1. Buyer earns AZM for trade completion
                    await azmSvc.rewardTradeComplete(trade.userId, tradeId, data.netUsdc);

                    // 2. Referral bonus: if buyer's first trade, reward the referrer
                    const buyer = await prisma.user.findUnique({
                        where: { id: trade.userId },
                        select: { tradesCompleted: true, referredByCode: true }
                    });
                    // tradesCompleted was incremented for the vendor, not buyer — 
                    // check buyer's completed trade count via TransactionHistory
                    if (buyer?.referredByCode) {
                        const buyerTradeCount = await prisma.transactionHistory.count({
                            where: { userId: trade.userId, type: 'P2P_TRADE', status: 'COMPLETED' }
                        });
                        if (buyerTradeCount === 1) {
                            // This is the buyer's first completed trade — reward referrer
                            const referrer = await prisma.user.findFirst({
                                where: { influencerCode: buyer.referredByCode },
                                select: { id: true }
                            });
                            if (referrer) {
                                await azmSvc.rewardReferralFirstTrade(referrer.id, trade.userId, tradeId);
                            }
                        }
                    }

                    // 3. Volume milestones for the vendor
                    const gamInputs = data._gamificationInputs;
                    if (gamInputs) {
                        const vendor = await prisma.user.findUnique({
                            where: { id: gamInputs.vendorId },
                            select: { totalVolumeUsdc: true }
                        });
                        if (vendor) {
                            const vol = vendor.totalVolumeUsdc;
                            const prevVol = vol - gamInputs.tradeVolumeUsdc;
                            const milestones = [1000, 10000, 50000, 100000];
                            for (const m of milestones) {
                                if (vol >= m && prevVol < m) {
                                    await azmSvc.rewardVolumeMilestone(gamInputs.vendorId, m, vol);
                                }
                            }
                        }
                    }
                } catch (azmErr) {
                    logger.error(`[p2p.completeTrade] AZM reward error tradeId=${tradeId}: ${azmErr.message}`);
                }

                // ── Phase P1: auto-process queue for the trade's ad ──────────
                // When a trade completes, a slot opened on the vendor. Check if
                // anyone is waiting and promote them automatically.
                try {
                    const completedTrade = await prisma.trade.findUnique({
                        where: { id: tradeId },
                        select: { adId: true }
                    });
                    if (completedTrade?.adId) {
                        const { processNextInQueue } = require('./queueController');
                        await processNextInQueue(completedTrade.adId, { prisma, io });
                    }
                } catch (queueErr) {
                    logger.error(`[p2p.completeTrade] queue auto-process error tradeId=${tradeId}: ${queueErr.message}`);
                }
            });
        }

        await audit(prisma, {
            actorId: releasedByUserId, actorName: req.user.username,
            action: 'TRADE_COMPLETED', targetType: 'TRADE', targetId: String(data.tradeId || tradeId),
            metadata: { netUsdc: data.netUsdc, vendorCutUsdc: data.vendorCutUsdc }, ipAddress: req.ip,
        });

        return res.status(200).json({
            success: true,
            message: `Trade #${tradeId} completed successfully.`,
            data: {
                tradeId:         data.tradeId,
                netUsdc:         data.netUsdc,
                adminCutUsdc:    data.adminCutUsdc,
                vendorCutUsdc:   data.vendorCutUsdc,
                vendorCutGhs:    data.vendorCutGhs,
                split: {
                    adminPct:  `${(data.adminPct  * 100).toFixed(0)}%`,
                    vendorPct: `${(data.vendorPct * 100).toFixed(0)}%`,
                    tier:      data.tradeId >= 1000 ? '≥$1000 (50/50)' : '<$1000 (60/40)'
                },
                totalMarginUsdc: data.totalMarginUsdc,
                gamification:    data.gamification || null
            }
        });
    } catch (error) {
        // Phase H8 (2026-05-27): if a concurrent caller already
        // finalized this trade (vendor double-tapped release on bad
        // network), the conditional `updateMany` in p2pService.completeTrade
        // throws TRADE_ALREADY_FINALIZED. Return idempotent 200 so the FE
        // doesn't surface a scary error for a no-op double-tap. The
        // canonical post-completion side effects (balances, gamification,
        // queue auto-process, notifications) all ran on the first call,
        // so the second caller just sees the trade as done.
        if (error.message === 'TRADE_ALREADY_FINALIZED') {
            return res.status(200).json({
                success: true,
                idempotent: true,
                message: 'Trade was already finalized by a concurrent request.'
            });
        }
        return _handleError(res, 'completeTrade', error);
    }
};

// =============================================================================
// B-9: GET /api/p2p/action-required
// Returns a list of trades needing the user's attention.
// =============================================================================
exports.getActionRequired = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const activeStatuses = ['PENDING', 'PENDING_PAYMENT', 'PAID', 'DISPUTED'];

        const trades = await prisma.trade.findMany({
            where: {
                OR: [
                    { userId, status: { in: activeStatuses } },
                    { vendorId: userId, status: { in: activeStatuses } }
                ]
            },
            select: {
                id: true,
                type: true,
                amountCrypto: true,
                amountFiat: true,
                currency: true,
                status: true,
                createdAt: true,
                user:   { select: { id: true, username: true } },
                vendor: { select: { id: true, username: true } },
            },
            orderBy: { createdAt: 'desc' }
        });

        const unreadCount = await prisma.directMessage.count({
            where: {
                receiverId: userId,
                isRead: false
            }
        });

        const unrespondedPings = await prisma.trade.count({
            where: {
                vendorId: userId,
                status: 'PENDING',
            }
        });

        return res.status(200).json({
            success: true,
            data: {
                hasAction: trades.length > 0 || unreadCount > 0,
                activeTradeCount: trades.length,
                unreadMessageCount: unreadCount,
                unrespondedPingCount: unrespondedPings,
                trades
            }
        });
    } catch (error) {
        return _handleError(res, 'getActionRequired', error);
    }
};
