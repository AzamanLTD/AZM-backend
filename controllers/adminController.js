// controllers/adminController.js
const { sendPushNotification } = require('../utils/firebaseService');
const { parsePagination, buildPageEnvelope } = require('../utils/pagination');

/**
 * Helper: retrieve the singleton NotificationService from app context.
 * Falls back to a lazy-init from prisma + io if needed (belt-and-braces).
 */
function _getNotificationService(req) {
    const svc = req.app.get('notificationService');
    if (svc) return svc;
    const NotificationService = require('../services/notificationService');
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    return new NotificationService(prisma, io);
}

/**
 * Helper: format seconds into human-readable uptime string
 */
function _formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

/**
 * 1. GET ALL DISPUTED TRADES
 *
 * Phase I5 (2026-05-25): pagination added. Was unbounded — a high-dispute
 * day could push hundreds of rows on every dashboard refresh. Default
 * page size is 100 (preserves the natural admin-war-room read size);
 * cap is the shared `MAX_LIMIT = 100` from `utils/pagination`. Cursor
 * mode (`?cursor=ID&limit=N`) and offset mode (`?page=N&limit=M`) both
 * accepted. Bare `disputes` top-level key preserved for the existing
 * `lib/screens/admin_war_room_screen.dart` consumer; new `pagination`
 * envelope alongside it.
 */
exports.getAllDisputes = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const queryHasNoPaginationParams =
            req.query.cursor == null &&
            req.query.limit == null &&
            req.query.page == null;
        // When no pagination param is passed we keep the previous
        // unbounded-feeling default by raising the take to 100. Opted-in
        // callers get the standard 20-row default unless they specify.
        if (queryHasNoPaginationParams) req.query.limit = '100';

        const { take, cursor, mode, page, skip } = parsePagination(req.query);

        const where = { status: 'DISPUTED' };
        const findArgs = {
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            include: {
                user: { select: { id: true, username: true, email: true } },
                vendor: { select: { id: true, username: true, email: true } },
                messages: { orderBy: { createdAt: 'asc' } }
            }
        };
        if (cursor) {
            findArgs.cursor = { id: parseInt(cursor, 10) };
            findArgs.skip = 1;
        } else if (skip > 0) {
            findArgs.skip = skip;
        }

        // Only count on page-1 of offset mode — admin dashboards show
        // pagination chips, but we don't need to recompute the total on
        // every page navigation. Cursor mode never needs a total.
        const wantsTotal = mode === 'offset' && page === 1;
        const [disputes, total] = await Promise.all([
            prisma.trade.findMany(findArgs),
            wantsTotal ? prisma.trade.count({ where }) : Promise.resolve(undefined)
        ]);

        const envelope = buildPageEnvelope(disputes, take, mode, page, total);
        res.status(200).json({ success: true, disputes, pagination: envelope });
    } catch (error) {
        console.error("Fetch Disputes Error:", error);
        res.status(500).json({ success: false, message: "Could not fetch disputes." });
    }
};

/**
 * 2. GET ALL LIVE TRADES (THE WAR ROOM FEED)
 *
 * ADMIN BUG FIX: The previous filter used 'PENDING' which doesn't exist
 * in the TradeStatus enum. The actual enum values are:
 *   PENDING, PENDING_PAYMENT, PAID, COMPLETED, CANCELLED, DISPUTED
 *
 * We now fetch ALL non-terminal trades so nothing slips through.
 *
 * Phase I5 (2026-05-25): pagination added. The hardcoded `take: 100`
 * cap was a silent ceiling — a war-room admin during peak hours
 * couldn't see trade #101+. Cap is preserved as the default page size
 * (matches MAX_LIMIT) but admins can now navigate past it via
 * `?cursor=ID&limit=N` (cursor mode, append-stable) or
 * `?page=N&limit=M` (offset mode, classic page chips). Bare `trades`
 * top-level key preserved for the existing
 * `lib/screens/admin_war_room_screen.dart` consumer.
 */
exports.getLiveTrades = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const queryHasNoPaginationParams =
            req.query.cursor == null &&
            req.query.limit == null &&
            req.query.page == null;
        if (queryHasNoPaginationParams) req.query.limit = '100';

        const { take, cursor, mode, page, skip } = parsePagination(req.query);

        const where = { status: { notIn: ['COMPLETED', 'CANCELLED'] } };
        const findArgs = {
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            include: {
                user: { select: { id: true, username: true, email: true } },
                vendor: { select: { id: true, username: true, email: true } },
                messages: { orderBy: { createdAt: 'asc' } }
            }
        };
        if (cursor) {
            findArgs.cursor = { id: parseInt(cursor, 10) };
            findArgs.skip = 1;
        } else if (skip > 0) {
            findArgs.skip = skip;
        }

        const wantsTotal = mode === 'offset' && page === 1;
        const [trades, total] = await Promise.all([
            prisma.trade.findMany(findArgs),
            wantsTotal ? prisma.trade.count({ where }) : Promise.resolve(undefined)
        ]);

        console.log(`📊 Admin War Room: Returning ${trades.length} live trades (page ${page}, mode ${mode})`);

        const envelope = buildPageEnvelope(trades, take, mode, page, total);
        res.status(200).json({ success: true, trades, pagination: envelope });
    } catch (error) {
        console.error("Fetch Live Trades Error:", error);
        res.status(500).json({ success: false, message: "Could not fetch live network trades." });
    }
};

/**
 * 3. FORCE RELEASE (Admin override)
 *
 * V2: delegates to services/p2p.service.completeTrade — single source of
 * truth. Admin authorization passes through `releasedByUserId` as the
 * counterparty receiving fiat, identified from the trade type.
 */
exports.forceRelease = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const { tradeId, adminNotes } = req.body;
        const id = parseInt(tradeId);

        const trade = await prisma.trade.findUnique({ where: { id } });
        if (!trade)                          return res.status(404).json({ success: false, message: "Trade not found." });
        if (trade.status !== 'DISPUTED')     return res.status(400).json({ success: false, message: "Trade is not disputed." });

        // The party authorized to release is the one receiving fiat.
        const releasedByUserId = trade.type === 'SELL' ? trade.vendorId : trade.userId;

        // Phase H9 BUGFIX (2026-05-27): atomic conditional status flip
        // before delegating to completeTrade. Two concurrent admins
        // hitting the force-release button could both flip DISPUTED →
        // PAID and both call completeTrade. The H8 fix on completeTrade
        // catches the duplicate at the second layer (one of the calls
        // gets TRADE_ALREADY_FINALIZED), but a failed completeTrade
        // would leave the trade stranded in PAID. With the conditional
        // flip here, only one admin's call ever proceeds — the second
        // gets a clean 409 before any lower-level work.
        const claimed = await prisma.trade.updateMany({
            where: { id, status: 'DISPUTED' },
            data:  { status: 'PAID' }
        });
        if (claimed.count === 0) {
            return res.status(409).json({
                success: false,
                message: 'Trade is no longer disputed (concurrent admin action).'
            });
        }

        const p2pService = require('../services/p2p.service');
        const result     = await p2pService.completeTrade(prisma, { tradeId: id, releasedByUserId });

        // Lazy-create conversation, drop ADMIN_INTERVENTION message
        let conversation = await prisma.conversation.findUnique({ where: { tradeId: String(id) } });
        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: {
                    type:    'TRADE',
                    tradeId: String(id),
                    participants: { connect: [{ id: trade.userId }, { id: trade.vendorId }] }
                }
            });
        }
        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                senderId:       req.user.id,
                tradeId:        id,
                messageType:    'ADMIN_INTERVENTION',
                content:        `Admin force-released the trade. Notes: ${adminNotes ?? 'Resolved by admin.'}`
            }
        });

        if (emitBalanceUpdate) {
            await emitBalanceUpdate(trade.userId);
            await emitBalanceUpdate(trade.vendorId);
        }

        io.to(`trade_${id}`).emit('trade_update', {
            status:  'COMPLETED',
            message: `ADMIN RESOLUTION: Assets force-released. Notes: ${adminNotes ?? 'Resolved.'}`
        });
        io.to(`user_${trade.userId}`).emit('new_notification',   { title: 'Trade Resolved — Assets Released' });
        io.to(`user_${trade.vendorId}`).emit('new_notification', { title: 'Trade Resolved by Admin' });

        res.status(200).json({ success: true, message: 'Force Release Successful.', data: result });
    } catch (error) {
        console.error("Force Release Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * 4. FORCE CANCEL (Admin override)
 *
 * V2: refunds escrow using the V2 ledger fields. SELL ad → vendor's
 * `escrowLockedBalance` returns to `vendorUnallocatedBalance`. BUY ad →
 * buyer's escrowed USDC is restored to `availableBalance` (Phase D-2).
 * Writes an ADMIN_INTERVENTION message.
 */
exports.forceCancel = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const { tradeId, adminNotes } = req.body;
        const id = parseInt(tradeId);

        const trade = await prisma.trade.findUnique({ where: { id } });
        if (!trade)                       return res.status(404).json({ success: false, message: "Trade not found." });
        if (trade.status !== 'DISPUTED')  return res.status(400).json({ success: false, message: "Trade is not disputed." });

        const isSellAd = trade.type === 'SELL';

        await prisma.$transaction(async (tx) => {
            // Phase H9 BUGFIX (2026-05-27): atomic conditional status
            // flip. Two concurrent forceCancel calls (two admins or one
            // admin double-clicking the override button on the dispute
            // resolution page) would both pass the DISPUTED check above
            // (which runs OUTSIDE the transaction) and both refund the
            // escrow. Fix: claim the row FIRST inside the transaction.
            const claimed = await tx.trade.updateMany({
                where: { id, status: 'DISPUTED' },
                data:  { status: 'CANCELLED' }
            });
            if (claimed.count === 0) {
                throw new Error('TRADE_NO_LONGER_DISPUTED');
            }

            if (isSellAd) {
                // Vendor's escrow returns to their unallocated pool (V2 fields).
                await tx.user.update({
                    where: { id: trade.vendorId },
                    data: {
                        escrowLockedBalance:      { decrement: trade.amountCrypto },
                        vendorUnallocatedBalance: { increment: trade.amountCrypto }
                    }
                });
            } else {
                // BUY ad: refund the user's escrowed USDC (Phase F correction).
                await tx.user.update({
                    where: { id: trade.userId },
                    data: {
                        escrowLockedBalance: { decrement: trade.amountCrypto },
                        availableBalance:    { increment: trade.amountCrypto }
                    }
                });
            }

            // Trade was already stamped CANCELLED at the top of this
            // transaction (atomic conditional flip).

            // Lazy-create conversation, drop ADMIN_INTERVENTION message
            let conversation = await tx.conversation.findUnique({ where: { tradeId: String(id) } });
            if (!conversation) {
                conversation = await tx.conversation.create({
                    data: {
                        type:    'TRADE',
                        tradeId: String(id),
                        participants: { connect: [{ id: trade.userId }, { id: trade.vendorId }] }
                    }
                });
            }
            await tx.message.create({
                data: {
                    conversationId: conversation.id,
                    senderId:       req.user.id,
                    tradeId:        id,
                    messageType:    'ADMIN_INTERVENTION',
                    content:        `Admin cancelled the trade. Assets refunded. Notes: ${adminNotes ?? 'Resolved by admin.'}`
                }
            });
        });

        if (emitBalanceUpdate) {
            await emitBalanceUpdate(trade.vendorId);
            await emitBalanceUpdate(trade.userId);
        }

        io.to(`trade_${id}`).emit('trade_update', {
            status:  'CANCELLED',
            message: `ADMIN RESOLUTION: Trade cancelled. Notes: ${adminNotes ?? 'Resolved.'}`
        });
        io.to(`user_${trade.userId}`).emit('new_notification',   { title: 'Trade Cancelled by Admin' });
        io.to(`user_${trade.vendorId}`).emit('new_notification', { title: 'Trade Resolved — Assets Returned' });

        res.status(200).json({ success: true, message: 'Force Cancel Successful.' });
    } catch (error) {
        // Phase H9: another concurrent admin already finalized this
        // trade. Surface a 409 so the FE can refresh and show the new
        // state instead of a generic 500.
        if (error.message === 'TRADE_NO_LONGER_DISPUTED') {
            return res.status(409).json({
                success: false,
                message: 'Trade is no longer disputed (concurrent admin action).'
            });
        }
        console.error("Force Cancel Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * 5. PLATFORM METRICS
 */
exports.getPlatformStats = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const totalUsers = await prisma.user.count();
        const activeDisputes = await prisma.trade.count({ where: { status: 'DISPUTED' } });
        
        const completedTrades = await prisma.trade.aggregate({
            where: { status: 'COMPLETED' },
            _sum: { amountFiat: true, amountCrypto: true, vendorProfitCut: true }
        });

        const totalFiat = completedTrades._sum.amountFiat || 0;
        const estimatedPlatformProfitGhs = (totalFiat * 0.015).toFixed(2);

        res.status(200).json({
            success: true,
            stats: {
                totalUsers,
                activeDisputes,
                totalFiatVolume: totalFiat,
                totalAdminProfit: estimatedPlatformProfitGhs
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * 6. GET PENDING KYC APPLICATIONS
 *
 * Phase I5 (2026-05-25): pagination added. Was unbounded; a backlog of
 * pending KYCs would push every applicant on every dashboard refresh.
 * Default page size 100; opt-in via `?cursor=ID&limit=N` or
 * `?page=N&limit=M`. Bare `applications` top-level key preserved for
 * the existing `lib/screens/admin_war_room_screen.dart` consumer.
 */
exports.getPendingKyc = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const queryHasNoPaginationParams =
            req.query.cursor == null &&
            req.query.limit == null &&
            req.query.page == null;
        if (queryHasNoPaginationParams) req.query.limit = '100';

        const { take, cursor, mode, page, skip } = parsePagination(req.query);

        const where = { kycStatus: 'PENDING' };
        const findArgs = {
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            select: {
                id: true,
                username: true,
                email: true,
                legalName: true,
                idType: true,
                idNumber: true,
                idImageFront: true,
                idImageBack: true,
                kycStatus: true,
                createdAt: true,
            }
        };
        if (cursor) {
            findArgs.cursor = { id: parseInt(cursor, 10) };
            findArgs.skip = 1;
        } else if (skip > 0) {
            findArgs.skip = skip;
        }

        const wantsTotal = mode === 'offset' && page === 1;
        const [applications, total] = await Promise.all([
            prisma.user.findMany(findArgs),
            wantsTotal ? prisma.user.count({ where }) : Promise.resolve(undefined)
        ]);

        // Decrypt the at-rest-encrypted idNumber for the authorized admin
        // review view (this endpoint is adminOnly). Legacy plaintext rows
        // pass through unchanged; tryDecrypt returns null on any failure
        // so a bad row degrades to null instead of 500-ing the queue.
        const fieldCipher = require('../services/crypto/fieldCipher');
        const decrypted = applications.map((u) => ({
            ...u,
            idNumber: u.idNumber ? fieldCipher.tryDecrypt(u.idNumber) : null,
        }));

        const envelope = buildPageEnvelope(decrypted, take, mode, page, total);
        res.status(200).json({ success: true, applications: decrypted, pagination: envelope });
    } catch (error) {
        console.error("Fetch KYC Error:", error);
        res.status(500).json({ success: false, message: "Could not fetch KYC applications." });
    }
};

/**
 * 7. APPROVE KYC APPLICATION
 *
 * Phase K — bumps the user's tokenVersion in the same transaction as the
 * role flip USER -> VENDOR, and revokes every active refresh token. The
 * client's NEXT request hits `protect`, sees its access JWT's
 * `tokenVersion` claim is below the live row, gets a `TOKEN_STALE` 401,
 * tries `/api/auth/refresh` — but every refresh token is revoked too, so
 * that fails with `REFRESH_INVALID`, and the client is forced to log in
 * again. After the fresh login, the new JWT carries `role: 'VENDOR'` and
 * the matching new tokenVersion. The privilege change has propagated
 * exactly once, atomically.
 */
exports.approveKyc = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: "userId is required." });

        const targetId = parseInt(userId);

        const user = await prisma.user.findUnique({ where: { id: targetId } });
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        if (user.kycStatus !== 'PENDING') return res.status(400).json({ success: false, message: "User is not pending KYC review." });

        // Run the role flip + the tokenVersion bump + refresh-token
        // revocation as one atomic transaction. If any step fails, none
        // of them apply. This is critical: a partial state where the
        // role is VENDOR but the tokenVersion isn't bumped would leave
        // an old-claim USER access token still able to act for up to
        // 15 more minutes, blocking the vendor surface from activating.
        //
        // Phase H12 BUGFIX (2026-05-27): atomic conditional flip on the
        // user.update so two admins approving simultaneously can't both
        // bump tokenVersion + fire two notifications. The standard
        // updateMany-with-precondition pattern from H8.
        const claimed = await prisma.$transaction(async (tx) => {
            const upd = await tx.user.updateMany({
                where: { id: targetId, kycStatus: 'PENDING' },
                data: {
                    kycStatus: 'VERIFIED',
                    role: 'VENDOR',
                    tokenVersion: { increment: 1 },
                }
            });
            if (upd.count === 0) return { ok: false };
            await tx.refreshToken.updateMany({
                where: { userId: targetId, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            return { ok: true };
        });

        if (!claimed.ok) {
            return res.status(409).json({
                success: false,
                message: 'KYC was already finalized by another admin (concurrent action).'
            });
        }

        // Notify the user
        await _getNotificationService(req).sendNotification({
            userId: targetId,
            title: "KYC Approved",
            body: "Congratulations! Your identity has been verified. You are now a Verified Vendor.",
            category: 'ADMIN_SYSTEM',
            actionPayload: { action: 'KYC_STATUS', status: 'VERIFIED' }
        });

        io.to(`user_${userId}`).emit('kyc_update', { status: 'VERIFIED' });
        // Tell the client to refresh its session — the access token it's
        // holding is now stale (we bumped tokenVersion). The mobile app
        // should listen for this event in the auth-bound provider and
        // call POST /api/auth/refresh to get a new pair.
        io.to(`user_${userId}`).emit('session_refresh_required', {
            reason: 'role_changed',
            newRole: 'VENDOR',
        });

        res.status(200).json({ success: true, message: "KYC approved. User promoted to Vendor." });
    } catch (error) {
        console.error("Approve KYC Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * 8. REJECT KYC APPLICATION
 */
exports.rejectKyc = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const { userId, reason } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: "userId is required." });

        const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        if (user.kycStatus !== 'PENDING') return res.status(400).json({ success: false, message: "User is not pending KYC review." });

        // Phase H12 BUGFIX (2026-05-27): atomic conditional flip — same
        // race protection as approveKyc. Without this, two admins both
        // rejecting would both fire a notification + websocket emit.
        const upd = await prisma.user.updateMany({
            where: { id: parseInt(userId), kycStatus: 'PENDING' },
            data: { kycStatus: 'REJECTED' }
        });
        if (upd.count === 0) {
            return res.status(409).json({
                success: false,
                message: 'KYC was already finalized by another admin (concurrent action).'
            });
        }

        await _getNotificationService(req).sendNotification({
            userId: parseInt(userId),
            title: "KYC Rejected",
            body: reason || "Your identity verification was not approved. Please resubmit with clearer documents.",
            category: 'ADMIN_SYSTEM',
            actionPayload: { action: 'KYC_STATUS', status: 'REJECTED', reason: reason || null }
        });

        io.to(`user_${userId}`).emit('kyc_update', { status: 'REJECTED' });

        res.status(200).json({ success: true, message: "KYC rejected." });
    } catch (error) {
        console.error("Reject KYC Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * 9. INJECT ADMIN MESSAGE INTO CHAT
 */
exports.sendAdminMessage = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io     = req.app.get('socketio');

    try {
        const { tradeId, message } = req.body;
        const adminId = req.user.id;
        const id      = parseInt(tradeId, 10);

        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, message: 'Message content is required.' });
        }

        const trade = await prisma.trade.findUnique({
            where:  { id },
            select: { id: true, userId: true, vendorId: true }
        });
        if (!trade) return res.status(404).json({ success: false, message: 'Trade not found.' });

        // Lazy-create the trade conversation (V2 schema)
        let conversation = await prisma.conversation.findUnique({ where: { tradeId: String(id) } });
        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: {
                    type:    'TRADE',
                    tradeId: String(id),
                    participants: { connect: [{ id: trade.userId }, { id: trade.vendorId }] }
                }
            });
        }

        const savedMessage = await prisma.message.create({
            data: {
                conversationId: conversation.id,
                senderId:       adminId,
                tradeId:        id,
                messageType:    'ADMIN_INTERVENTION',
                content:        message.trim()
            },
            include: { sender: { select: { id: true, username: true, role: true } } }
        });

        // Phase N: route through notificationService for socket + FCM delivery
        const notifSvc = _getNotificationService(req);
        await Promise.all([
            notifSvc.sendNotification({
                userId:        trade.userId,
                title:         'Admin Message',
                body:          message.substring(0, 200),
                category:      'ADMIN_SYSTEM',
                actionPayload: { action: 'OPEN_TRADE', tradeId: String(id) }
            }),
            notifSvc.sendNotification({
                userId:        trade.vendorId,
                title:         'Admin Message',
                body:          message.substring(0, 200),
                category:      'ADMIN_SYSTEM',
                actionPayload: { action: 'OPEN_TRADE', tradeId: String(id) }
            })
        ]);

        io.to(`trade_${id}`).emit('new_message', {
            id:          savedMessage.id,
            sender:      savedMessage.sender,
            content:     savedMessage.content,
            messageType: savedMessage.messageType,
            createdAt:   savedMessage.createdAt
        });

        res.status(200).json({ success: true, message: 'Admin message injected successfully.' });
    } catch (error) {
        console.error('Admin Chat Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * 10. LIQUIDATE PLATFORM PROFITS
 *     Moves accumulated profit from SystemProfitFees → SystemFiatPool.
 *     V2 FIX: Delegates to finance.service.js; uses V2 singleton models
 *     (SystemProfitFees, SystemFiatPool) — the old SystemLedger is removed.
 */
exports.liquidateProfits = async (req, res) => {
    const prisma   = req.app.get('prisma');
    const io       = req.app.get('socketio');
    const financeService = require('../services/finance.service');

    try {
        const { amountUsdc } = req.body;

        if (!amountUsdc || Number(amountUsdc) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid liquidation amount.' });
        }

        const data = await financeService.liquidateProfits(
            prisma,
            parseFloat(amountUsdc),
            req.user.id
        );

        try {
            io.emit('admin_alert', {
                type:             'PROFIT_LIQUIDATION',
                amountLiquidated: data.amountLiquidated,
                newProfitFees:    data.newProfitFees,
                newFiatPool:      data.newFiatPool,
                timestamp:        new Date().toISOString()
            });
        } catch (socketErr) {
            console.error('[liquidateProfits] Failed to emit socket alert:', socketErr.message);
        }

        return res.status(200).json({
            success: true,
            message: `Liquidated ${data.amountLiquidated} USDC from profit fees to fiat pool.`,
            data
        });
    } catch (error) {
        console.error('[liquidateProfits] error:', error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
};



// =============================================================================
// V4: NEW ADMIN ENDPOINTS — Full Command Center
// =============================================================================

/**
 * 11. ENHANCED PLATFORM STATS
 *     GET /api/admin/stats
 *     Returns comprehensive metrics: 24h volume, new users today, active
 *     vendors, revenue breakdown, trade counts by status.
 */
// (Replaces the old getPlatformStats above — we keep the old one as fallback
//  but the route now points here)
const _originalGetPlatformStats = exports.getPlatformStats;
exports.getPlatformStats = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        const thisWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

        const [
            totalUsers,
            newUsersToday,
            activeVendors,
            totalTrades,
            activeDisputes,
            pendingKyc,
            liveTrades,
            completedToday,
            completedAllTime,
            volume24h,
            volumeAllTime,
            profitFees,
            pendingWithdrawals
        ] = await Promise.all([
            // Total users
            prisma.user.count(),
            // New users today
            prisma.user.count({ where: { createdAt: { gte: today } } }),
            // Active vendors (VENDOR role + at least 1 active ad)
            prisma.user.count({ where: { role: 'VENDOR', banStatus: 'ACTIVE' } }),
            // Total trades (all time)
            prisma.trade.count(),
            // Active disputes
            prisma.trade.count({ where: { status: 'DISPUTED' } }),
            // Pending KYC
            prisma.user.count({ where: { kycStatus: 'PENDING' } }),
            // Live trades (non-terminal)
            prisma.trade.count({ where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
            // Completed today
            prisma.trade.count({ where: { status: 'COMPLETED', completedAt: { gte: today } } }),
            // Completed all time aggregate
            prisma.trade.aggregate({
                where: { status: 'COMPLETED' },
                _sum: { amountFiat: true, amountCrypto: true, vendorProfitCut: true },
                _count: true
            }),
            // 24h volume
            prisma.trade.aggregate({
                where: { status: 'COMPLETED', completedAt: { gte: yesterday } },
                _sum: { amountFiat: true, amountCrypto: true }
            }),
            // All-time volume
            prisma.trade.aggregate({
                where: { status: 'COMPLETED' },
                _sum: { amountFiat: true, amountCrypto: true }
            }),
            // System profit fees
            prisma.systemProfitFees.findUnique({ where: { id: 1 } }).catch(() => null),
            // Pending withdrawals
            prisma.withdrawal.count({ where: { status: 'PENDING' } })
        ]);

        const totalFiatVolume = volumeAllTime._sum.amountFiat || 0;
        const totalCryptoVolume = volumeAllTime._sum.amountCrypto || 0;
        const fiatVolume24h = volume24h._sum.amountFiat || 0;
        const cryptoVolume24h = volume24h._sum.amountCrypto || 0;
        const totalAdminProfit = profitFees?.balance || 0;
        const totalVendorProfit = completedAllTime._sum.vendorProfitCut || 0;

        return res.status(200).json({
            success: true,
            stats: {
                // User metrics
                totalUsers,
                newUsersToday,
                activeVendors,

                // Trade metrics
                totalTrades,
                liveTrades,
                completedToday,
                completedAllTime: completedAllTime._count || 0,
                activeDisputes,

                // Volume
                totalFiatVolume,
                totalCryptoVolume,
                fiatVolume24h,
                cryptoVolume24h,

                // Revenue
                totalAdminProfit,
                totalVendorProfit,
                estimatedDailyRevenue: (fiatVolume24h * 0.015).toFixed(2),

                // Operations
                pendingKyc,
                pendingWithdrawals,

                // Timestamps
                generatedAt: now.toISOString()
            }
        });
    } catch (error) {
        console.error('[getPlatformStats] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


/**
 * 12. PROFIT BREAKDOWN
 *     GET /api/admin/profit-breakdown
 *     Returns real PnL data from AdminProfitLog + SystemProfitFees.
 *     Includes daily breakdown for charting and source categorization.
 */
exports.getProfitBreakdown = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const [profitFees, fiatPool, hotWallet, masterCrypto, profitLogs, dailySnapshots] = await Promise.all([
            prisma.systemProfitFees.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            prisma.systemFiatPool.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            prisma.systemHotWallet.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            prisma.systemMasterCrypto.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            // Last 30 days of profit logs grouped by source
            prisma.adminProfitLog.groupBy({
                by: ['source'],
                where: { createdAt: { gte: thirtyDaysAgo } },
                _sum: { amountUsdc: true },
                _count: true
            }),
            // Daily snapshots for charting
            prisma.dailySnapshot.findMany({
                where: { date: { gte: thirtyDaysAgo } },
                orderBy: { date: 'asc' },
                select: { date: true, totalProfitUsdc: true, totalVolumeUsdc: true, activeUsers: true, profitBySource: true }
            })
        ]);

        // Build source breakdown
        const sourceBreakdown = {};
        for (const log of profitLogs) {
            sourceBreakdown[log.source] = {
                totalUsdc: log._sum.amountUsdc || 0,
                count: log._count
            };
        }

        // Build daily PnL array for charting (last 30 days)
        const dailyPnl = dailySnapshots.map(s => ({
            date: s.date,
            profit: s.totalProfitUsdc,
            volume: s.totalVolumeUsdc,
            users: s.activeUsers,
            bySource: s.profitBySource
        }));

        // If no daily snapshots exist, generate from profit logs
        if (dailyPnl.length === 0) {
            const recentLogs = await prisma.adminProfitLog.findMany({
                where: { createdAt: { gte: thirtyDaysAgo } },
                orderBy: { createdAt: 'asc' },
                select: { amountUsdc: true, source: true, createdAt: true }
            });

            // Group by day
            const dayMap = {};
            for (const log of recentLogs) {
                const dayKey = log.createdAt.toISOString().split('T')[0];
                if (!dayMap[dayKey]) dayMap[dayKey] = { profit: 0, count: 0 };
                dayMap[dayKey].profit += log.amountUsdc;
                dayMap[dayKey].count += 1;
            }

            for (const [date, data] of Object.entries(dayMap)) {
                dailyPnl.push({ date, profit: data.profit, volume: 0, users: 0 });
            }
        }

        return res.status(200).json({
            success: true,
            data: {
                // Current system pool balances
                pools: {
                    profitFees: profitFees?.balance || 0,
                    fiatPool: fiatPool?.balance || 0,
                    hotWallet: hotWallet?.balance || 0,
                    masterCrypto: masterCrypto?.balance || 0
                },

                // Revenue by source (last 30 days)
                sourceBreakdown,

                // Daily PnL for charting
                dailyPnl,

                // Summary
                totalProfitLast30Days: profitLogs.reduce((sum, l) => sum + (l._sum.amountUsdc || 0), 0),
                totalTransactionsLast30Days: profitLogs.reduce((sum, l) => sum + l._count, 0),

                period: {
                    from: thirtyDaysAgo.toISOString(),
                    to: now.toISOString()
                }
            }
        });
    } catch (error) {
        console.error('[getProfitBreakdown] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


/**
 * 13. GET ALL USERS (paginated with search + filters)
 *     GET /api/admin/users?page=1&limit=20&search=john&role=VENDOR&banStatus=ACTIVE
 */
exports.getUsers = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;
        const search = req.query.search || '';
        const role = req.query.role || '';
        const banStatus = req.query.banStatus || '';
        const kycStatus = req.query.kycStatus || '';

        // Build where clause
        const where = { isDeleted: false };

        if (search) {
            where.OR = [
                { username: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { legalName: { contains: search, mode: 'insensitive' } }
            ];
        }
        if (role) where.role = role;
        if (banStatus) where.banStatus = banStatus;
        if (kycStatus) where.kycStatus = kycStatus;

        const [users, totalCount] = await Promise.all([
            prisma.user.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    username: true,
                    email: true,
                    role: true,
                    kycStatus: true,
                    banStatus: true,
                    banUntil: true,
                    strikeCount: true,
                    tradesCompleted: true,
                    completionRate: true,
                    availableBalance: true,
                    azmBalance: true,
                    vendorLevel: true,
                    loyaltyTier: true,
                    loginStreak: true,
                    lastLoginAt: true,
                    createdAt: true,
                    _count: {
                        select: {
                            tradesAsBuyer: true,
                            tradesAsVendor: true,
                            ads: true
                        }
                    }
                }
            }),
            prisma.user.count({ where })
        ]);

        return res.status(200).json({
            success: true,
            data: {
                users,
                pagination: {
                    page,
                    limit,
                    totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                    hasNext: page * limit < totalCount,
                    hasPrev: page > 1
                }
            }
        });
    } catch (error) {
        console.error('[getUsers] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


/**
 * 14. BAN / UNBAN USER
 *     POST /api/admin/users/:id/ban
 *     Body: { action: 'BAN_24H' | 'BAN_1W' | 'BAN_INDEF' | 'UNBAN', reason? }
 */
exports.banUser = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const userId = parseInt(req.params.id);
        const { action, reason } = req.body;

        if (!userId || isNaN(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid user ID.' });
        }

        const validActions = ['BAN_24H', 'BAN_1W', 'BAN_INDEF', 'UNBAN'];
        if (!action || !validActions.includes(action)) {
            return res.status(400).json({
                success: false,
                message: `action must be one of: ${validActions.join(', ')}`
            });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        let banStatus, banUntil;
        const now = new Date();

        switch (action) {
            case 'BAN_24H':
                banStatus = 'BANNED_24H';
                banUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                break;
            case 'BAN_1W':
                banStatus = 'BANNED_1W';
                banUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
                break;
            case 'BAN_INDEF':
                banStatus = 'BANNED_INDEF';
                banUntil = null;
                break;
            case 'UNBAN':
                banStatus = 'ACTIVE';
                banUntil = null;
                break;
        }

        await prisma.user.update({
            where: { id: userId },
            data: { banStatus, banUntil }
        });

        // Notify the user
        await _getNotificationService(req).sendNotification({
            userId,
            title: action === 'UNBAN' ? 'Account Restored' : 'Account Restricted',
            body: action === 'UNBAN'
                ? 'Your account restrictions have been lifted. You can trade again.'
                : `Your account has been restricted. ${reason || 'Contact support for details.'}`,
            category: 'SECURITY_ACCOUNT',
            actionPayload: { action: 'ACCOUNT_STATUS', banStatus, reason: reason || null }
        });

        // Real-time notification
        io.to(`user_${userId}`).emit('account_restricted', {
            banStatus,
            banUntil,
            reason: reason || null
        });

        // ---- Phase B2 (2026-05-25): force-disconnect any open sockets ----
        // Without this, a banned user's open WebSocket connections keep
        // receiving server pushes (and could keep emitting events the
        // socket auth middleware admitted at connect time) until the
        // client manually refreshes. Phase K's protect middleware closes
        // the gap on every NEW HTTP/WS request; this closes the gap on
        // EXISTING connections.
        //
        // Scope: only on actual ban actions, not UNBAN. We don't want to
        // disturb a user we're un-banning.
        if (action !== 'UNBAN') {
            try {
                io.in(`user_${userId}`).disconnectSockets();
            } catch (sockErr) {
                // Disconnect failure must not fail the ban — the DB row
                // is already flipped, the next request will be rejected.
                console.error(`[banUser] socket disconnect non-fatal: ${sockErr.message}`);
            }
        }

        return res.status(200).json({
            success: true,
            message: action === 'UNBAN'
                ? `User ${user.username} has been unbanned.`
                : `User ${user.username} has been banned (${action}).`,
            data: { userId, banStatus, banUntil }
        });
    } catch (error) {
        console.error('[banUser] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


/**
 * 15. CHANGE USER ROLE
 *     POST /api/admin/users/:id/role
 *     Body: { role: 'USER' | 'VENDOR' | 'ADMIN' }
 */
exports.changeUserRole = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');

    try {
        const userId = parseInt(req.params.id);
        const { role } = req.body;

        if (!userId || isNaN(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid user ID.' });
        }

        const validRoles = ['USER', 'VENDOR', 'ADMIN'];
        if (!role || !validRoles.includes(role)) {
            return res.status(400).json({
                success: false,
                message: `role must be one of: ${validRoles.join(', ')}`
            });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        // Prevent self-demotion
        if (userId === req.user.id && role !== 'ADMIN') {
            return res.status(400).json({ success: false, message: 'You cannot demote yourself.' });
        }

        // Phase K — same cascade as approveKyc. The role flip MUST land
        // atomically with the tokenVersion bump and the refresh-token
        // revocation, so the user can't keep acting under their old role
        // for the remaining lifetime of an in-flight access JWT (≤ 15 min)
        // or indefinitely via a still-valid refresh token. If we updated
        // role only, an admin demoting a user to USER would leave that
        // user with their old admin JWT working against `protect` until
        // the JWT expired naturally, which is exactly the "JWT staleness"
        // the audit called out.
        //
        // Skip the cascade only if the role isn't actually changing (admin
        // re-saving the same role) — we don't want to needlessly invalidate
        // every device for a no-op write.
        const isActualChange = user.role !== role;

        if (isActualChange) {
            await prisma.$transaction([
                prisma.user.update({
                    where: { id: userId },
                    data: { role, tokenVersion: { increment: 1 } }
                }),
                prisma.refreshToken.updateMany({
                    where: { userId, revokedAt: null },
                    data: { revokedAt: new Date() },
                }),
            ]);
        } else {
            await prisma.user.update({
                where: { id: userId },
                data: { role }
            });
        }

        // Notify user — only when role actually changed.
        if (isActualChange) {
            await _getNotificationService(req).sendNotification({
                userId,
                title: 'Role Updated',
                body: `Your account role has been changed to ${role}.`,
                category: 'ADMIN_SYSTEM',
                actionPayload: { action: 'ROLE_CHANGE', newRole: role }
            });

            io.to(`user_${userId}`).emit('role_update', { role });
            // Tell the client to refresh its session — same socket event
            // approveKyc emits, so the FE has a single handler.
            io.to(`user_${userId}`).emit('session_refresh_required', {
                reason: 'role_changed',
                newRole: role,
            });
        }

        return res.status(200).json({
            success: true,
            message: `User ${user.username} role changed to ${role}.`,
            data: { userId, previousRole: user.role, newRole: role }
        });
    } catch (error) {
        console.error('[changeUserRole] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


/**
 * 16. GET PENDING WITHDRAWALS
 *     GET /api/admin/withdrawals/pending
 *
 * Phase I5 (2026-05-25): pagination added on the `pending` array.
 * Was unbounded; a treasury backlog could push every pending
 * withdrawal on every dashboard refresh. Default page size 100; opt-in
 * via `?cursor=ID&limit=N` or `?page=N&limit=M`. The `frozen` array
 * remains capped at 20 (separate small list, no pagination needed).
 * Response shape extended: `data: { pending, frozen, counts,
 * pagination }`. `counts.pending` keeps its original page-length
 * semantic; the real backlog total is exposed on `pagination.total`
 * (only populated on page-1 of offset mode, for cost reasons).
 * UIs that want a "X queued" chip should prefer
 * `pagination.total ?? counts.pending`. No FE consumer today, free
 * to evolve.
 */
exports.getPendingWithdrawals = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const queryHasNoPaginationParams =
            req.query.cursor == null &&
            req.query.limit == null &&
            req.query.page == null;
        if (queryHasNoPaginationParams) req.query.limit = '100';

        const { take, cursor, mode, page, skip } = parsePagination(req.query);

        const where = { status: 'PENDING' };
        const findArgs = {
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            include: {
                user: {
                    select: {
                        id: true,
                        username: true,
                        email: true,
                        kycStatus: true,
                        banStatus: true,
                        strikeCount: true,
                        tradesCompleted: true
                    }
                }
            }
        };
        if (cursor) {
            findArgs.cursor = { id: parseInt(cursor, 10) };
            findArgs.skip = 1;
        } else if (skip > 0) {
            findArgs.skip = skip;
        }

        const wantsTotal = mode === 'offset' && page === 1;
        // Run pending list + frozen list + count in parallel.
        const [pending, frozen, totalPending] = await Promise.all([
            prisma.withdrawal.findMany(findArgs),
            prisma.transactionHistory.findMany({
                where: { status: 'FROZEN_DISPUTE' },
                include: {
                    user: { select: { id: true, username: true, email: true } }
                },
                orderBy: { createdAt: 'desc' },
                take: 20
            }),
            wantsTotal ? prisma.withdrawal.count({ where }) : Promise.resolve(undefined)
        ]);

        const envelope = buildPageEnvelope(pending, take, mode, page, totalPending);

        return res.status(200).json({
            success: true,
            data: {
                pending,
                frozen,
                counts: {
                    // Page length only — the original contract.
                    // Total backlog now lives in `pagination.total`
                    // (only populated on page-1 of offset mode for cost
                    // reasons). UIs that want a "X queued" chip should
                    // read `pagination.total ?? counts.pending`.
                    pending: pending.length,
                    frozen: frozen.length
                },
                pagination: envelope
            }
        });
    } catch (error) {
        console.error('[getPendingWithdrawals] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


/**
 * 17. APPROVE WITHDRAWAL
 *     POST /api/admin/withdrawals/:id/approve
 *     Body: { adminNotes? }
 */
exports.approveWithdrawal = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const withdrawalId = parseInt(req.params.id);
        const { adminNotes } = req.body;

        if (!withdrawalId || isNaN(withdrawalId)) {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal ID.' });
        }

        const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
        if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found.' });
        if (withdrawal.status !== 'PENDING') {
            return res.status(400).json({ success: false, message: `Cannot approve: status is ${withdrawal.status}.` });
        }

        // Phase H12 BUGFIX (2026-05-27): atomic conditional flip. Without
        // this, two admins both clicking approve would both fire the
        // user notification + websocket event. Effect is mostly cosmetic
        // (no money moves on approve — that happens in the disbursement
        // worker), but consistent with the rejectWithdrawal fix.
        const claimed = await prisma.withdrawal.updateMany({
            where: { id: withdrawalId, status: 'PENDING' },
            data: { status: 'APPROVED' }
        });
        if (claimed.count === 0) {
            return res.status(409).json({
                success: false,
                message: 'Withdrawal was already finalized by another admin (concurrent action).'
            });
        }

        // Notify user
        await _getNotificationService(req).sendNotification({
            userId: withdrawal.userId,
            title: 'Withdrawal Approved',
            body: `Your withdrawal of ${withdrawal.amount} ${withdrawal.payoutMethod} has been approved and is being processed.`,
            category: 'GENERAL',
            actionPayload: { action: 'WITHDRAWAL_STATUS', withdrawalId: String(withdrawalId), status: 'APPROVED' }
        });

        io.to(`user_${withdrawal.userId}`).emit('withdrawal_update', {
            withdrawalId,
            status: 'APPROVED',
            message: 'Your withdrawal has been approved.'
        });

        return res.status(200).json({
            success: true,
            message: `Withdrawal #${withdrawalId} approved.`,
            data: { withdrawalId, userId: withdrawal.userId, amount: withdrawal.amount, adminNotes }
        });
    } catch (error) {
        console.error('[approveWithdrawal] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


/**
 * 18. REJECT WITHDRAWAL
 *     POST /api/admin/withdrawals/:id/reject
 *     Body: { reason }
 */
exports.rejectWithdrawal = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const withdrawalId = parseInt(req.params.id);
        const { reason } = req.body;

        if (!withdrawalId || isNaN(withdrawalId)) {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal ID.' });
        }
        if (!reason || !reason.trim()) {
            return res.status(400).json({ success: false, message: 'Rejection reason is required.' });
        }

        const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
        if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found.' });
        if (withdrawal.status !== 'PENDING') {
            return res.status(400).json({ success: false, message: `Cannot reject: status is ${withdrawal.status}.` });
        }

        // Refund the user's balance
        // Phase H12 BUGFIX (2026-05-27): atomic conditional flip on
        // the withdrawal status BEFORE the refund. Without this guard,
        // two admins both clicking reject on the same row would both
        // refund the user — the user receives their withdrawal amount
        // credited back TWICE. Real money loss. The conditional
        // `updateMany({ where: { id, status: 'PENDING' } })` rejects
        // the second concurrent caller cleanly inside the transaction.
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.withdrawal.updateMany({
                where: { id: withdrawalId, status: 'PENDING' },
                data: { status: 'REJECTED' }
            });
            if (claimed.count === 0) {
                throw new Error('WITHDRAWAL_ALREADY_FINALIZED');
            }

            // Refund the balance that was deducted (Phase D-2: unified on availableBalance)
            await tx.user.update({
                where: { id: withdrawal.userId },
                data: { availableBalance: { increment: withdrawal.amount } }
            });
        });

        // Notify user
        await _getNotificationService(req).sendNotification({
            userId: withdrawal.userId,
            title: 'Withdrawal Rejected',
            body: `Your withdrawal of ${withdrawal.amount} was rejected: ${reason}. Funds have been returned to your wallet.`,
            category: 'GENERAL',
            actionPayload: { action: 'WITHDRAWAL_STATUS', withdrawalId: String(withdrawalId), status: 'REJECTED' }
        });

        if (emitBalanceUpdate) await emitBalanceUpdate(withdrawal.userId);

        io.to(`user_${withdrawal.userId}`).emit('withdrawal_update', {
            withdrawalId,
            status: 'REJECTED',
            reason,
            message: 'Your withdrawal was rejected. Funds returned.'
        });

        return res.status(200).json({
            success: true,
            message: `Withdrawal #${withdrawalId} rejected. Funds refunded.`,
            data: { withdrawalId, userId: withdrawal.userId, amount: withdrawal.amount, reason }
        });
    } catch (error) {
        // Phase H12: another admin already finalized this row. Return
        // 409 instead of a generic 500 so the FE can refresh and show
        // the new state.
        if (error.message === 'WITHDRAWAL_ALREADY_FINALIZED') {
            return res.status(409).json({
                success: false,
                message: 'Withdrawal was already finalized by another admin (concurrent action).'
            });
        }
        console.error('[rejectWithdrawal] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


/**
 * 19. SYSTEM HEALTH
 *     GET /api/admin/system-health
 *     Returns all 4 system pool balances + operational status.
 */
exports.getSystemHealth = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const [masterCrypto, hotWallet, fiatPool, profitFees, settings, recentTrades, recentDeposits] = await Promise.all([
            prisma.systemMasterCrypto.findUnique({ where: { id: 1 } }).catch(() => null),
            prisma.systemHotWallet.findUnique({ where: { id: 1 } }).catch(() => null),
            prisma.systemFiatPool.findUnique({ where: { id: 1 } }).catch(() => null),
            prisma.systemProfitFees.findUnique({ where: { id: 1 } }).catch(() => null),
            prisma.globalSettings.findUnique({ where: { id: 1 } }),
            // Last 5 completed trades (to verify engine is running)
            prisma.trade.findMany({
                where: { status: 'COMPLETED' },
                orderBy: { completedAt: 'desc' },
                take: 5,
                select: { id: true, completedAt: true, amountFiat: true }
            }),
            // Last 5 deposits
            prisma.transactionHistory.findMany({
                where: { type: { in: ['DEPOSIT_FIAT', 'DEPOSIT_CRYPTO'] }, status: 'COMPLETED' },
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: { id: true, type: true, amountUsdc: true, createdAt: true }
            })
        ]);

        const lastTradeTime = recentTrades[0]?.completedAt || null;
        const lastDepositTime = recentDeposits[0]?.createdAt || null;

        return res.status(200).json({
            success: true,
            data: {
                pools: {
                    masterCrypto: masterCrypto?.balance || 0,
                    hotWallet: hotWallet?.balance || 0,
                    fiatPool: fiatPool?.balance || 0,
                    profitFees: profitFees?.balance || 0,
                    totalSystemValue: (masterCrypto?.balance || 0) + (hotWallet?.balance || 0) + (fiatPool?.balance || 0) + (profitFees?.balance || 0)
                },

                oracle: {
                    liveUsdToGhs: settings?.liveUsdToGhs || 0,
                    liveRetailRate: settings?.liveRetailRate || 0,
                    liveCorporateRate: settings?.liveCorporateRate || 0,
                    rateSource: settings?.liveRateSource || 'UNKNOWN',
                    lastRateSync: settings?.lastRateSync || null
                },

                engine: {
                    status: 'ONLINE',
                    lastTradeCompleted: lastTradeTime,
                    lastDeposit: lastDepositTime,
                    uptime: _formatUptime(process.uptime()),
                    memoryUsage: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`,
                    nodeVersion: process.version
                },

                recentActivity: {
                    trades: recentTrades,
                    deposits: recentDeposits
                },

                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('[getSystemHealth] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// PHASE Q8 — AUTONOMOUS PAYOUT ENDPOINTS
// =============================================================================

/**
 * POST /api/admin/payouts/batch-process
 * Manual trigger for the payout batch worker.
 * Body: { force?: boolean }
 * - force=true: processes even if autoPayoutEnabled is false
 */
exports.batchProcessPayouts = async (req, res) => {
    try {
        const payoutBatchWorker = req.app.get('payoutBatchWorker');
        if (!payoutBatchWorker) {
            return res.status(503).json({
                success: false,
                message: 'Payout batch worker is not initialized.'
            });
        }

        const { force } = req.body || {};
        const result = await payoutBatchWorker.processNow({ force: !!force });

        return res.status(200).json({
            success: result.success !== false,
            ...result
        });
    } catch (error) {
        console.error('[batchProcessPayouts] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/payouts/settings
 * Returns the current auto-payout configuration from GlobalSettings.
 */
exports.getPayoutSettings = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        if (!settings) {
            return res.status(404).json({ success: false, message: 'GlobalSettings not found.' });
        }

        const fiatPool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });

        return res.status(200).json({
            success: true,
            settings: {
                autoPayoutEnabled: settings.autoPayoutEnabled,
                autoPayoutThresholdUsdc: settings.autoPayoutThresholdUsdc,
                autoPayoutMaxAmountUsdc: settings.autoPayoutMaxAmountUsdc,
                autoPayoutIntervalMs: settings.autoPayoutIntervalMs
            },
            pool: {
                balance: fiatPool ? fiatPool.balance : 0,
                alertThreshold: 5000 // FIAT_POOL_ALERT_THRESH from finance.service
            }
        });
    } catch (error) {
        console.error('[getPayoutSettings] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * PUT /api/admin/payouts/settings
 * Updates the auto-payout configuration.
 * Body: { autoPayoutEnabled?, autoPayoutThresholdUsdc?, autoPayoutMaxAmountUsdc?, autoPayoutIntervalMs? }
 */
exports.updatePayoutSettings = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const {
            autoPayoutEnabled,
            autoPayoutThresholdUsdc,
            autoPayoutMaxAmountUsdc,
            autoPayoutIntervalMs
        } = req.body;

        const updateData = {};

        if (typeof autoPayoutEnabled === 'boolean') {
            updateData.autoPayoutEnabled = autoPayoutEnabled;
        }
        if (autoPayoutThresholdUsdc != null) {
            const val = parseFloat(autoPayoutThresholdUsdc);
            if (isNaN(val) || val < 0) {
                return res.status(400).json({ success: false, message: 'autoPayoutThresholdUsdc must be >= 0.' });
            }
            updateData.autoPayoutThresholdUsdc = val;
        }
        if (autoPayoutMaxAmountUsdc != null) {
            const val = parseFloat(autoPayoutMaxAmountUsdc);
            if (isNaN(val) || val < 0) {
                return res.status(400).json({ success: false, message: 'autoPayoutMaxAmountUsdc must be >= 0.' });
            }
            updateData.autoPayoutMaxAmountUsdc = val;
        }
        if (autoPayoutIntervalMs != null) {
            const val = parseInt(autoPayoutIntervalMs, 10);
            if (isNaN(val) || val < 10000) {
                return res.status(400).json({ success: false, message: 'autoPayoutIntervalMs must be >= 10000 (10 seconds).' });
            }
            updateData.autoPayoutIntervalMs = val;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ success: false, message: 'No valid fields to update.' });
        }

        const updated = await prisma.globalSettings.update({
            where: { id: 1 },
            data: updateData
        });

        console.log(`[updatePayoutSettings] admin ${req.user.id} updated:`, JSON.stringify(updateData));

        return res.status(200).json({
            success: true,
            message: 'Payout settings updated.',
            settings: {
                autoPayoutEnabled: updated.autoPayoutEnabled,
                autoPayoutThresholdUsdc: updated.autoPayoutThresholdUsdc,
                autoPayoutMaxAmountUsdc: updated.autoPayoutMaxAmountUsdc,
                autoPayoutIntervalMs: updated.autoPayoutIntervalMs
            }
        });
    } catch (error) {
        console.error('[updatePayoutSettings] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/payouts/needs-review
 * Returns withdrawals flagged as NEEDS_MANUAL_REVIEW.
 * Supports cursor pagination.
 */
exports.getNeedsManualReview = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const queryHasNoPaginationParams =
            req.query.cursor == null &&
            req.query.limit == null &&
            req.query.page == null;
        if (queryHasNoPaginationParams) req.query.limit = '50';

        const { take, cursor, mode, page, skip } = parsePagination(req.query);

        const where = { status: 'NEEDS_MANUAL_REVIEW' };
        const findArgs = {
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            include: {
                user: {
                    select: {
                        id: true,
                        username: true,
                        email: true,
                        kycStatus: true,
                        banStatus: true,
                        tradesCompleted: true,
                        phoneNumber: true
                    }
                }
            }
        };
        if (cursor) {
            findArgs.cursor = { id: parseInt(cursor, 10) };
            findArgs.skip = 1;
        } else if (skip > 0) {
            findArgs.skip = skip;
        }

        const wantsTotal = mode === 'offset' && page === 1;
        const [withdrawals, total] = await Promise.all([
            prisma.withdrawal.findMany(findArgs),
            wantsTotal ? prisma.withdrawal.count({ where }) : Promise.resolve(undefined)
        ]);

        const envelope = buildPageEnvelope(withdrawals, take, mode, page, total);

        return res.status(200).json({
            success: true,
            withdrawals,
            count: withdrawals.length,
            pagination: envelope
        });
    } catch (error) {
        console.error('[getNeedsManualReview] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};
