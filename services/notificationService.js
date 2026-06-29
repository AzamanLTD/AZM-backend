// services/notificationService.js
// =============================================================================
// AZAMAN V2 — NOTIFICATION SERVICE  (Phase 2.4 Upgrade)
//
// Every notification passes through one pipeline:
//   1. DB  → prisma.notification.create  (60-second batch dedup for OPEN_TRADE)
//   2. WS  → io.to(`user_${userId}`).emit('new_notification', …)
//   3. FCM → sendPushNotification if user is offline
//
// actionPayload is ALWAYS a Flutter deep-link object:
//   { route: '/path', action: 'ACTION_NAME', …extra }
//
// Valid NotificationCategory values (matches Prisma enum):
//   GENERAL | SECURITY_ACCOUNT | VENDOR_PRIORITY | ADMIN_SYSTEM
// =============================================================================

const { sendPushNotification } = require('../utils/firebaseService');

class NotificationService {
    constructor(prisma, io) {
        this.prisma           = prisma;
        this.io               = io;
        this.BATCH_WINDOW_MS  = 60 * 1000; // 1 minute dedup window
    }

    // =========================================================================
    // PRIMARY ENTRY POINT
    // =========================================================================

    /**
     * sendNotification
     *
     * Creates a DB record, emits a socket event, and fires FCM if the user
     * has no active socket connection.  All three happen for every call.
     *
     * @param {{ userId, title, body, category, actionPayload }} params
     *   actionPayload MUST be a plain object with at minimum { route: string }
     */
    async sendNotification({ userId, title, body, category, actionPayload }) {
        const parsedUserId = parseInt(userId, 10);
        if (isNaN(parsedUserId)) throw new Error('Invalid userId');

        const normalizedCategory = this._normalizeCategory(category);

        // ── 60-second dedup for repeated OPEN_TRADE events ─────────────────
        const batchKey = this._buildBatchKey(actionPayload);
        if (batchKey) {
            const batched = await this._tryBatchUpdate(parsedUserId, batchKey, body, normalizedCategory);
            if (batched) return batched;
        }

        // ── Persist ────────────────────────────────────────────────────────
        const record = await this.prisma.notification.create({
            data: {
                userId:        parsedUserId,
                title,
                body,
                category:      normalizedCategory,
                actionPayload: this._ensureDeepLink(actionPayload)
            }
        });

        // ── Real-time socket emit ──────────────────────────────────────────
        this._emitSocketEvent(parsedUserId, record);

        // ── Offline FCM push ───────────────────────────────────────────────
        await this._triggerPushNotification(parsedUserId, title, body, actionPayload);

        return record;
    }

    // =========================================================================
    // BATCH DEDUPLICATION  (prevents notification spam for rapid-fire events)
    // =========================================================================

    async _tryBatchUpdate(userId, batchKey, newBody, category) {
        const cutoff = new Date(Date.now() - this.BATCH_WINDOW_MS);

        const existing = await this.prisma.notification.findFirst({
            where: {
                userId,
                category,
                actionPayload: { path: batchKey.path, equals: batchKey.value },
                createdAt:     { gte: cutoff }
            },
            orderBy: { createdAt: 'desc' }
        });

        if (!existing) return null;

        const updated = await this.prisma.notification.update({
            where: { id: existing.id },
            data:  { body: newBody, updatedAt: new Date() }
        });

        this._emitSocketEvent(userId, updated);
        return updated;
    }

    _buildBatchKey(actionPayload) {
        if (!actionPayload) return null;
        if (actionPayload.action === 'OPEN_TRADE' && actionPayload.tradeId) {
            return { path: ['action'], value: 'OPEN_TRADE', tradeId: actionPayload.tradeId };
        }
        return null;
    }

    // =========================================================================
    // SOCKET + FCM
    // =========================================================================

    _emitSocketEvent(userId, record) {
        if (!this.io) return;
        this.io.to(`user_${userId}`).emit('new_notification', {
            id:            record.id,
            title:         record.title,
            body:          record.body,
            category:      record.category,
            actionPayload: record.actionPayload,
            isRead:        record.isRead,
            createdAt:     record.createdAt
        });
    }

    async _triggerPushNotification(userId, title, body, actionPayload) {
        try {
            // Only fire FCM when the user has no live socket connection
            if (this.io) {
                const sockets = await this.io.in(`user_${userId}`).allSockets();
                if (sockets && sockets.size > 0) return; // user is online — skip FCM
            }

            const user = await this.prisma.user.findUnique({
                where:  { id: userId },
                select: { fcmToken: true }
            });
            if (!user || !user.fcmToken) return;

            // Convert actionPayload to flat string map for FCM data
            const data = {};
            if (actionPayload) {
                Object.keys(actionPayload).forEach(key => {
                    data[key] = String(actionPayload[key]);
                });
            }

            await sendPushNotification(user.fcmToken, title, body, data);
        } catch (err) {
            console.error('[NotificationService] FCM error:', err.message);
        }
    }

    // =========================================================================
    // DEEP-LINK PAYLOAD HELPERS
    // Enforce { route, action, ...extras } shape required by Flutter Navigator
    // =========================================================================

    /**
     * Ensure every actionPayload has a `route` key for Flutter deep-linking.
     * If the caller already included `route`, this is a no-op.
     */
    _ensureDeepLink(payload) {
        if (!payload) return { route: '/', action: 'OPEN_HOME' };
        if (!payload.route) {
            // Derive route from action if possible
            const routeMap = {
                OPEN_TRADE:     `/trade/${payload.tradeId || ''}`,
                OPEN_WALLET:    '/wallet',
                OPEN_WAR_ROOM:  '/admin/war-room',
                OPEN_DISPUTE:   `/dispute/${payload.disputeId || ''}`,
                OPEN_QUEUE:     '/queue',
                VIEW_BADGE:     '/badges',
                VIEW_CFO_REPORT:'/admin/cfo',
                APPROVE_DISCOUNT:'/admin/discounts',
                OPEN_HOME:      '/'
            };
            return { ...payload, route: routeMap[payload.action] || '/' };
        }
        return payload;
    }

    // =========================================================================
    // PRE-BUILT PAYLOADS — Flutter-ready deep-link format
    // =========================================================================

    formatTradeStarted(tradeId) {
        return {
            title:         'Trade Started',
            body:          `Trade #${tradeId} has been opened.`,
            category:      'VENDOR_PRIORITY',
            actionPayload: {
                route:   `/trade/${tradeId}`,
                action:  'OPEN_TRADE',
                tradeId: String(tradeId)
            }
        };
    }

    formatTradeCompleted(tradeId) {
        return {
            title:         '🎉 Trade Complete',
            body:          `Trade #${tradeId} has been completed successfully.`,
            category:      'GENERAL',
            actionPayload: {
                route:   `/trade/${tradeId}`,
                action:  'OPEN_TRADE',
                tradeId: String(tradeId)
            }
        };
    }

    formatDisputeUpdated(disputeId) {
        return {
            title:         'Dispute Updated',
            body:          `Dispute #${disputeId} has new activity.`,
            category:      'SECURITY_ACCOUNT',
            actionPayload: {
                route:     `/dispute/${disputeId}`,
                action:    'OPEN_DISPUTE',
                disputeId: String(disputeId)
            }
        };
    }

    formatDepositSuccess(amountUsdc) {
        return {
            title:         '💰 Deposit Confirmed',
            body:          amountUsdc
                ? `${amountUsdc} USDC has been credited to your account.`
                : 'Your deposit has been confirmed.',
            category:      'GENERAL',
            actionPayload: { route: '/wallet', action: 'OPEN_WALLET' }
        };
    }

    formatPaymentTransfer(fromUsername, amountUsdc, conversationId) {
        return {
            title:         `💸 ${fromUsername} sent you ${amountUsdc} USDC`,
            body:          `${amountUsdc} USDC has been transferred to your account.`,
            category:      'GENERAL',
            actionPayload: {
                route:          `/chat/${conversationId}`,
                action:         'OPEN_CHAT',
                conversationId: String(conversationId)
            }
        };
    }

    formatQueuePosition(adId, queuePosition) {
        return {
            title:         '⏳ You Are In The Queue',
            body:          `You are #${queuePosition} in the queue. We'll notify you when a slot opens.`,
            category:      'GENERAL',
            actionPayload: {
                route:         '/queue',
                action:        'OPEN_QUEUE',
                adId:          String(adId),
                queuePosition: String(queuePosition)
            }
        };
    }

    formatAiMaticLowWarning(maticBalance, threshold) {
        return {
            title:         '⚠️ System MATIC Balance Low',
            body:          `SystemHotWallet MATIC balance (${maticBalance}) is below the safe threshold (${threshold}). Top-up required.`,
            category:      'ADMIN_SYSTEM',
            actionPayload: {
                route:        '/admin/war-room',
                action:       'OPEN_WAR_ROOM',
                maticBalance: String(maticBalance),
                threshold:    String(threshold)
            }
        };
    }

    formatLeaderboardTopUser(rank, totalVolume) {
        return {
            title:       `🏆 You're #${rank} on the Leaderboard!`,
            body:        `You traded ${totalVolume.toFixed(2)} USDC this week. A discount credit is on its way.`,
            category:    'GENERAL',
            actionPayload: {
                route:       '/leaderboard',
                action:      'VIEW_LEADERBOARD',
                rank:        String(rank),
                totalVolume: String(totalVolume)
            }
        };
    }

    formatAdminDiscountApprovalRequest(userId, rank, totalVolume) {
        return {
            title:    `Discount Approval — Rank #${rank} User`,
            body:     `User #${userId} is ranked #${rank} this week with ${totalVolume.toFixed(2)} USDC volume. Approve a discount credit?`,
            category: 'ADMIN_SYSTEM',
            actionPayload: {
                route:       '/admin/discounts',
                action:      'APPROVE_DISCOUNT',
                userId:      String(userId),
                rank:        String(rank),
                totalVolume: String(totalVolume)
            }
        };
    }

    // =========================================================================
    // CONVENIENCE SEND METHODS
    // =========================================================================

    async sendTradeStarted(userId, tradeId) {
        return this.sendNotification({ userId, ...this.formatTradeStarted(tradeId) });
    }

    async sendTradeCompleted(userId, tradeId) {
        return this.sendNotification({ userId, ...this.formatTradeCompleted(tradeId) });
    }

    async sendDisputeUpdated(userId, disputeId) {
        return this.sendNotification({ userId, ...this.formatDisputeUpdated(disputeId) });
    }

    async sendDepositSuccess(userId, amountUsdc) {
        return this.sendNotification({ userId, ...this.formatDepositSuccess(amountUsdc) });
    }

    async sendPaymentTransfer(receiverId, fromUsername, amountUsdc, conversationId) {
        return this.sendNotification({
            userId: receiverId,
            ...this.formatPaymentTransfer(fromUsername, amountUsdc, conversationId)
        });
    }

    async sendAiMaticLowWarning(adminUserId, maticBalance, threshold) {
        return this.sendNotification({
            userId: adminUserId,
            ...this.formatAiMaticLowWarning(maticBalance, threshold)
        });
    }

    // =========================================================================
    // READ / MANAGEMENT
    // =========================================================================

    async getNotifications(userId, opts = {}) {
        const parsedUserId = parseInt(userId, 10);
        const { page = 1, limit = 20, unreadOnly = false, cursor = null, category = null } = opts;

        const where = { userId: parsedUserId };
        if (unreadOnly) where.isRead = false;
        if (category) where.category = String(category).toUpperCase();

        // Cursor mode: O(limit) lookup against the composite index.
        // Skip 1 ensures the cursor row itself isn't repeated on the next page.
        // Secondary `id` sort breaks ties on createdAt (notification fan-out
        // can produce same-millisecond rows) so cursor pages don't skip or
        // duplicate.
        if (cursor) {
            const notifications = await this.prisma.notification.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: limit,
                cursor: { id: String(cursor) },
                skip: 1
            });
            return { notifications, page: null, limit, total: null, mode: 'cursor' };
        }

        // Legacy offset mode. Total is only computed on page 1 to spare the
        // count query on every paginated fetch — clients that need a precise
        // total can re-request page 1.
        const skip = (page - 1) * limit;
        const findPromise = this.prisma.notification.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip,
            take: limit
        });
        const countPromise = page === 1
            ? this.prisma.notification.count({ where })
            : Promise.resolve(null);
        const [notifications, total] = await Promise.all([findPromise, countPromise]);

        return { notifications, total, page, limit, mode: 'offset' };
    }

    async markAsRead(notificationId, userId) {
        const parsedUserId = parseInt(userId, 10);
        const notification = await this.prisma.notification.findUnique({
            where: { id: notificationId }
        });
        if (!notification) throw new Error('Notification not found');
        if (notification.userId !== parsedUserId) throw new Error('Not authorized');

        return this.prisma.notification.update({
            where: { id: notificationId },
            data:  { isRead: true }
        });
    }

    async markAllAsRead(userId) {
        return this.prisma.notification.updateMany({
            where: { userId: parseInt(userId, 10), isRead: false },
            data:  { isRead: true }
        });
    }

    async getUnreadCount(userId) {
        return this.prisma.notification.count({
            where: { userId: parseInt(userId, 10), isRead: false }
        });
    }

    // =========================================================================
    // INTERNALS
    // =========================================================================

    _normalizeCategory(category) {
        const valid = ['GENERAL', 'SECURITY_ACCOUNT', 'VENDOR_PRIORITY', 'ADMIN_SYSTEM', 'VAULT', 'SUSU', 'SMART_ROUTE', 'AUCTION'];
        return valid.includes(category) ? category : 'GENERAL';
    }
}

module.exports = NotificationService;
