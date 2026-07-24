// services/bizNotificationService.js
// =============================================================================
// AZAMAN — Business Notification Service (2026-06-17)
//
// Pure I/O service. Persists the owner-facing BusinessNotification feed read by
// the Business Portal. No req/res, no $transaction blocks. Mirrors the
// validation/shape conventions of services/businessProductService.js.
//
// Writes are ALWAYS fire-and-forget from the caller's perspective: a failed
// notification must never roll back a financial transaction or fail an HTTP
const logger = require('../src/config/logger');
// request. createNotification therefore swallows its own errors (logs + returns
// null) so callers can `await` it without a try/catch of their own.
//
// notifyOrderEvent() is the chokepoint used by escrow hooks/controllers: given
// an escrowId it resolves the linked BusinessOrder (and its businessProfileId)
// and writes the row. It is a silent no-op when the escrow has no business
// order (e.g. peer-to-peer escrows), so callers can fire it unconditionally.
// =============================================================================

const VALID_TYPES = new Set([
    'NEW_ORDER', 'ORDER_FUNDED', 'ORDER_SATISFIED', 'ORDER_DISPUTED',
    'ORDER_SETTLED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'KYB_STATUS_CHANGED'
]);

// ── private helpers ───────────────────────────────────────────────────────────

const _clip = (value, max) => {
    if (value == null) return null;
    const str = String(value);
    return str.length > max ? str.slice(0, max) : str;
};

/** Short human ref for an order: prefers orderRef, falls back to last 8 of ticketId. */
const _orderLabel = (order) =>
    order.orderRef || (order.ticketId ? `#${String(order.ticketId).slice(-8)}` : 'your order');

/**
 * Default owner-facing copy keyed by notification type. Centralised here so the
 * escrow hooks only have to pass a `type`. `order` is the resolved BusinessOrder.
 */
const _defaultCopy = (type, order) => {
    const amount = Number(order.amountUsdc);
    const ref = _orderLabel(order);
    const item = order.title ? `"${order.title}"` : ref;
    switch (type) {
        case 'NEW_ORDER':
            return { title: 'New Order', body: `New order ${item} · ${amount} USDC` };
        case 'ORDER_FUNDED':
            return { title: 'Escrow Funded', body: `A buyer locked ${amount} USDC for order ${ref}.` };
        case 'ORDER_SATISFIED':
            return { title: 'Order Marked Satisfied', body: `The buyer marked order ${ref} satisfied.` };
        case 'ORDER_DISPUTED':
            return { title: 'Dispute Raised', body: `A dispute was raised on order ${ref}.` };
        case 'ORDER_SETTLED':
            return { title: 'Order Settled', body: `Escrow released — ${amount} USDC delivered for order ${ref}.` };
        case 'ORDER_REFUNDED':
            return { title: 'Order Refunded', body: `Order ${ref} was refunded to the buyer.` };
        case 'ORDER_CANCELLED':
            return { title: 'Order Cancelled', body: `Order ${ref} was cancelled before funding.` };
        default:
            return { title: 'Order Update', body: `Order ${ref} was updated.` };
    }
};

// =============================================================================
// 1. CREATE NOTIFICATION — fire-and-forget. Never throws; logs + returns null
//    on failure so financial flows are never disrupted by the feed.
// =============================================================================
const createNotification = async (prisma, { businessProfileId, type, title, body, metadata }) => {
    try {
        if (!businessProfileId) throw new Error('businessProfileId is required.');
        if (!VALID_TYPES.has(type)) throw new Error(`Invalid notification type: ${type}`);

        const cleanTitle = _clip(title, 200);
        const cleanBody = _clip(body, 500);
        if (!cleanTitle) throw new Error('title is required.');
        if (!cleanBody) throw new Error('body is required.');

        return await prisma.businessNotification.create({
            data: {
                businessProfileId,
                type,
                title: cleanTitle,
                body: cleanBody,
                metadata: metadata && typeof metadata === 'object' ? metadata : null
            }
        });
    } catch (err) {
        logger.error({ err: err }, '[bizNotificationService.createNotification]');
        return null;
    }
};

// =============================================================================
// 2. NOTIFY ORDER EVENT — escrow-keyed chokepoint. Resolves the BusinessOrder
//    linked to an escrow, then writes a notification for its owning business.
//    Silent no-op when no business order is linked to the escrow.
//    Returns { notification, order } | null.
// =============================================================================
const notifyOrderEvent = async (prisma, { escrowId, type, title, body, extraMetadata }) => {
    try {
        if (!escrowId) return null;

        const order = await prisma.businessOrder.findFirst({
            where: { escrowId },
            select: {
                id: true, businessProfileId: true, productId: true,
                ticketId: true, title: true, amountUsdc: true, orderRef: true,
                businessProfile: { select: { userId: true } }
            }
        });
        if (!order) return null; // not every escrow is a business order

        const copy = _defaultCopy(type, order);
        const notification = await createNotification(prisma, {
            businessProfileId: order.businessProfileId,
            type,
            title: title || copy.title,
            body: body || copy.body,
            metadata: {
                orderId: order.id,
                orderRef: order.orderRef,
                ticketId: order.ticketId,
                escrowId,
                productId: order.productId,
                amount: Number(order.amountUsdc),
                ...(extraMetadata || {})
            }
        });

        return { notification, order };
    } catch (err) {
        logger.error({ err: err }, '[bizNotificationService.notifyOrderEvent]');
        return null;
    }
};

// =============================================================================
// 3. LIST NOTIFICATIONS — cursor pagination by id, newest first. Returns the
//    live unreadCount alongside the page.
// =============================================================================
const getNotifications = async (prisma, businessProfileId, { limit, cursor, unreadOnly } = {}) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

    const where = { businessProfileId };
    if (unreadOnly === true || unreadOnly === 'true') where.isRead = false;

    const [rows, unreadCount] = await Promise.all([
        prisma.businessNotification.findMany({
            where,
            take: take + 1,
            orderBy: { createdAt: 'desc' },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        }),
        prisma.businessNotification.count({ where: { businessProfileId, isRead: false } })
    ]);

    const hasMore = rows.length > take;
    const notifications = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? notifications[notifications.length - 1].id : null;

    return { notifications, hasMore, nextCursor, unreadCount };
};

// =============================================================================
// 4. UNREAD COUNT — badge value for the portal bell.
// =============================================================================
const getUnreadCount = async (prisma, businessProfileId) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');
    return prisma.businessNotification.count({
        where: { businessProfileId, isRead: false }
    });
};

// =============================================================================
// 5. MARK AS READ — owner-scoped. Verifies ownership via the compound where so
//    a notification belonging to another business can never be flipped.
// =============================================================================
const markAsRead = async (prisma, notificationId, businessProfileId) => {
    if (!notificationId) throw new Error('notificationId is required.');
    if (!businessProfileId) throw new Error('businessProfileId is required.');

    const result = await prisma.businessNotification.updateMany({
        where: { id: notificationId, businessProfileId },
        data: { isRead: true }
    });
    if (result.count === 0) throw new Error('Notification not found.');

    return prisma.businessNotification.findUnique({ where: { id: notificationId } });
};

// =============================================================================
// 6. MARK ALL AS READ — bulk clear for the calling business.
// =============================================================================
const markAllAsRead = async (prisma, businessProfileId) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');
    const result = await prisma.businessNotification.updateMany({
        where: { businessProfileId, isRead: false },
        data: { isRead: true }
    });
    return { updated: result.count };
};

module.exports = {
    createNotification,
    notifyOrderEvent,
    getNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead
};
