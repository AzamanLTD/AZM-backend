// services/bizNotificationService.js
// =============================================================================
// AZAMAN — Business Notification Service (2026-06-17)
// =============================================================================

const logger = require('../src/config/logger');

let _socketIo = null;
const setSocketIO = (io) => { _socketIo = io || null; };

const VALID_TYPES = new Set([
    'NEW_ORDER', 'ORDER_FUNDED', 'ORDER_SATISFIED', 'ORDER_DISPUTED',
    'ORDER_SETTLED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'KYB_STATUS_CHANGED',
    'DINE_IN_TAB_OPENED', 'DINE_IN_TAB_FINALIZED', 'DINE_IN_TAB_PAID'
]);

const DINE_IN_TYPES = new Set([
    'DINE_IN_TAB_OPENED', 'DINE_IN_TAB_FINALIZED', 'DINE_IN_TAB_PAID'
]);

const _clip = (value, max) => {
    if (value == null) return null;
    const str = String(value);
    return str.length > max ? str.slice(0, max) : str;
};

const _orderLabel = (order) =>
    order.orderRef || (order.ticketId ? `#${String(order.ticketId).slice(-8)}` : 'your order');

const _defaultCopy = (type, order) => {
    const amount = Number(order.amountUsdc);
    const ref = _orderLabel(order);
    const item = order.title ? `\"${order.title}\"` : ref;
    switch (type) {
        case 'NEW_ORDER': return { title: 'New Order', body: `New order ${item} · ${amount} USDC` };
        case 'ORDER_FUNDED': return { title: 'Escrow Funded', body: `A buyer locked ${amount} USDC for order ${ref}.` };
        case 'ORDER_SATISFIED': return { title: 'Order Marked Satisfied', body: `The buyer marked order ${ref} satisfied.` };
        case 'ORDER_DISPUTED': return { title: 'Dispute Raised', body: `A dispute was raised on order ${ref}.` };
        case 'ORDER_SETTLED': return { title: 'Order Settled', body: `Escrow released — ${amount} USDC delivered for order ${ref}.` };
        case 'ORDER_REFUNDED': return { title: 'Order Refunded', body: `Order ${ref} was refunded to the buyer.` };
        case 'ORDER_CANCELLED': return { title: 'Order Cancelled', body: `Order ${ref} was cancelled before funding.` };
        default: return { title: 'Order Update', body: `Order ${ref} was updated.` };
    }
};

const _dineInCopy = (type, { tabId, totalAmount } = {}) => {
    const ref = tabId ? `Tab ${String(tabId).slice(-8)}` : 'Dine-in tab';
    switch (type) {
        case 'DINE_IN_TAB_OPENED': return { title: 'Dine-in Tab Opened', body: `${ref} was opened.` };
        case 'DINE_IN_TAB_FINALIZED': return { title: 'Dine-in Tab Finalized', body: `${ref} is awaiting customer payment${totalAmount != null ? ` · ${Number(totalAmount)} USDC` : ''}.` };
        case 'DINE_IN_TAB_PAID': return { title: 'Dine-in Tab Paid', body: `${ref} has been paid and closed.` };
        default: return { title: 'Dine-in Update', body: `${ref} was updated.` };
    }
};

const createNotification = async (prisma, { businessProfileId, type, title, body, metadata }) => {
    try {
        if (!businessProfileId) throw new Error('businessProfileId is required.');
        if (!VALID_TYPES.has(type)) throw new Error(`Invalid notification type: ${type}`);
        const cleanTitle = _clip(title, 200);
        const cleanBody = _clip(body, 500);
        if (!cleanTitle) throw new Error('title is required.');
        if (!cleanBody) throw new Error('body is required.');
        return await prisma.businessNotification.create({
            data: { businessProfileId, type, title: cleanTitle, body: cleanBody, metadata: metadata && typeof metadata === 'object' ? metadata : null }
        });
    } catch (err) {
        logger.error({ err: err }, '[bizNotificationService.createNotification]');
        return null;
    }
};

const _emitNotificationSignal = (notification, recipient, ioOverride) => {
    const io = ioOverride || _socketIo;
    if (!io || !notification || !recipient?.userId) return;
    const payload = {
        notificationId: notification.id,
        businessProfileId: notification.businessProfileId,
        type: notification.type,
        orderId: recipient.orderId || null,
        orderRef: recipient.orderRef || null,
        ticketId: recipient.ticketId || null,
        escrowId: notification.metadata?.escrowId || null,
        createdAt: notification.createdAt
    };
    try { io.to(`user_${recipient.userId}`).emit('biz_notification', payload); }
    catch (err) { logger.warn({ err, notificationId: notification.id }, '[bizNotificationService] realtime emit failed'); }
};

const notifyOrderEvent = async (prisma, { escrowId, type, title, body, extraMetadata }) => {
    try {
        if (!escrowId) return null;
        const order = await prisma.businessOrder.findFirst({
            where: { escrowId },
            select: {
                id: true, businessProfileId: true, productId: true, ticketId: true,
                title: true, amountUsdc: true, orderRef: true,
                businessProfile: { select: { userId: true } }
            }
        });
        if (!order) return null;
        const copy = _defaultCopy(type, order);
        const notification = await createNotification(prisma, {
            businessProfileId: order.businessProfileId,
            type, title: title || copy.title, body: body || copy.body,
            metadata: { orderId: order.id, orderRef: order.orderRef, ticketId: order.ticketId, escrowId, productId: order.productId, amount: Number(order.amountUsdc), ...(extraMetadata || {}) }
        });
        if (notification) _emitNotificationSignal(notification, { userId: order.businessProfile.userId, orderId: order.id, orderRef: order.orderRef, ticketId: order.ticketId });
        return { notification, order };
    } catch (err) {
        logger.error({ err: err }, '[bizNotificationService.notifyOrderEvent]');
        return null;
    }
};

/** Persist and signal a business-facing dine-in lifecycle event. */
const notifyDineInEvent = async (prisma, {
    businessProfileId, tabId, type, title, body, totalAmount, extraMetadata, io,
}) => {
    try {
        if (!tabId) throw new Error('tabId is required.');
        if (!DINE_IN_TYPES.has(type)) throw new Error(`Invalid dine-in notification type: ${type}`);
        let businessId = businessProfileId;
        if (!businessId) {
            const tab = await prisma.dineInTab.findUnique({ where: { id: tabId }, select: { businessProfileId: true } });
            businessId = tab?.businessProfileId || null;
        }
        if (!businessId) return null;
        const business = await prisma.businessProfile.findUnique({ where: { id: businessId }, select: { id: true, userId: true } });
        if (!business) return null;
        const copy = _dineInCopy(type, { tabId, totalAmount });
        const notification = await createNotification(prisma, {
            businessProfileId: business.id, type, title: title || copy.title, body: body || copy.body,
            metadata: { tabId, ...(totalAmount != null ? { totalAmount: Number(totalAmount) } : {}), ...(extraMetadata || {}) }
        });
        if (notification) _emitNotificationSignal(notification, { userId: business.userId }, io);
        return notification;
    } catch (err) {
        logger.error({ err: err }, '[bizNotificationService.notifyDineInEvent]');
        return null;
    }
};

const _encodeCursor = ({ createdAt, id }) => Buffer.from(JSON.stringify({ createdAt: new Date(createdAt).toISOString(), id }), 'utf8').toString('base64url');
const _decodeCursor = (cursor) => {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (parsed && typeof parsed.id === 'string' && typeof parsed.createdAt === 'string') {
            const createdAt = new Date(parsed.createdAt);
            if (!Number.isNaN(createdAt.getTime())) return { id: parsed.id, createdAt };
        }
    } catch (_) {}
    return { id: cursor };
};

const getNotifications = async (prisma, businessProfileId, { limit, cursor, unreadOnly } = {}) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const where = { businessProfileId };
    if (unreadOnly === true || unreadOnly === 'true') where.isRead = false;
    let cursorFilter = {};
    if (cursor) {
        const decoded = _decodeCursor(cursor);
        const anchor = await prisma.businessNotification.findFirst({ where: { id: decoded.id, businessProfileId }, select: { id: true, createdAt: true } });
        if (!anchor) throw new Error('Notification cursor must reference an existing notification.');
        cursorFilter = { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] };
    }
    const pageWhere = cursor ? { AND: [where, cursorFilter] } : where;
    const [rows, unreadCount] = await Promise.all([
        prisma.businessNotification.findMany({ where: pageWhere, take: take + 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
        prisma.businessNotification.count({ where: { businessProfileId, isRead: false } })
    ]);
    const hasMore = rows.length > take;
    const notifications = hasMore ? rows.slice(0, take) : rows;
    const last = notifications[notifications.length - 1];
    return { notifications, hasMore, nextCursor: hasMore && last ? _encodeCursor(last) : null, unreadCount };
};

const getUnreadCount = async (prisma, businessProfileId) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');
    return prisma.businessNotification.count({ where: { businessProfileId, isRead: false } });
};
const markAsRead = async (prisma, notificationId, businessProfileId) => {
    if (!notificationId) throw new Error('notificationId is required.');
    if (!businessProfileId) throw new Error('businessProfileId is required.');
    const result = await prisma.businessNotification.updateMany({ where: { id: notificationId, businessProfileId }, data: { isRead: true } });
    if (result.count === 0) throw new Error('Notification not found.');
    return prisma.businessNotification.findUnique({ where: { id: notificationId } });
};
const markAllAsRead = async (prisma, businessProfileId) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');
    const result = await prisma.businessNotification.updateMany({ where: { businessProfileId, isRead: false }, data: { isRead: true } });
    return { updated: result.count };
};

module.exports = { createNotification, notifyOrderEvent, notifyDineInEvent, getNotifications, getUnreadCount, markAsRead, markAllAsRead, setSocketIO };
