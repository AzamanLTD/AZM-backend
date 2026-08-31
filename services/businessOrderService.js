// services/businessOrderService.js
const { emitWebhookEvent } = require('./webhookEmitter');
const { randomBytes } = require('crypto');

const _generateOrderRef = async (prisma) => {
    for (let i = 0; i < 5; i++) {
        const suffix = randomBytes(2).toString('hex').toUpperCase();
        const date = new Date().toISOString().slice(2, 10).replace(/-/g, '');
        const ref = `ORD-${date}-${suffix}`;
        const clash = await prisma.businessOrder.findUnique({ where: { orderRef: ref } });
        if (!clash) return ref;
    }
    throw new Error('Could not generate a unique order reference. Please retry.');
};

const ORDER_INCLUDE = {
    customer: { select: { id: true, username: true, profilePictureUrl: true, azamanId: true } },
    product: { select: { id: true, name: true, slug: true, imageUrls: true } },
    escrow: { select: { id: true, status: true, amountUsdc: true, feeUsdc: true, fundedAt: true, settledAt: true, payerSatisfied: true, payeeSatisfied: true } },
    ticket: { select: { id: true, name: true, status: true } }
};

const _ESCROW_TO_ORDER = {
    FUNDED: 'PAID', SETTLED: 'COMPLETED', RELEASED: 'COMPLETED',
    DISPUTED: 'DISPUTED', REFUNDED: 'REFUNDED', EXPIRED: 'REFUNDED'
};

const _ESCROW_ALLOWED_ORDER_STATES = {
    FUNDED: ['AWAITING_PAYMENT'],
    SETTLED: ['PAID', 'DELIVERED', 'DISPUTED'],
    RELEASED: ['PAID', 'DELIVERED', 'DISPUTED'],
    DISPUTED: ['AWAITING_PAYMENT', 'PAID', 'DELIVERED'],
    REFUNDED: ['AWAITING_PAYMENT', 'PAID', 'DELIVERED', 'DISPUTED'],
    EXPIRED: ['AWAITING_PAYMENT', 'PAID', 'DELIVERED', 'DISPUTED']
};

const _parseDate = (value, fieldName) => {
    if (value == null || value === '') return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`${fieldName} must be a valid date.`);
    return parsed;
};

const _cursorBoundary = async (prisma, cursor, scopeWhere) => {
    if (!cursor) return null;
    const row = await prisma.businessOrder.findFirst({
        where: { id: String(cursor), ...scopeWhere },
        select: { id: true, createdAt: true },
    });
    if (!row) throw new Error('cursor must reference an existing order in the requested scope.');
    return row;
};

const createOrder = async (prisma, { businessProfileId, customerId, productId, escrowId, ticketId, amountUsdc, title, description, customerNotes }) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');
    if (!customerId) throw new Error('customerId is required.');
    const amount = Number(amountUsdc);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amountUsdc must be a positive finite number.');
    const cleanTitle = String(title || '').trim();
    if (cleanTitle.length < 1 || cleanTitle.length > 200) throw new Error('title must be 1–200 chars.');

    const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { id: true, userId: true } });
    if (!business) throw new Error('Business profile not found.');

    if (productId) {
        const product = await prisma.businessProduct.findUnique({ where: { id: productId }, select: { id: true, businessProfileId: true, isActive: true } });
        if (!product || product.businessProfileId !== businessProfileId) throw new Error('Product not found.');
        if (!product.isActive) throw new Error('Product is not available.');
    }

    if (escrowId) {
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId }, select: { id: true, payerId: true, payeeId: true, amountUsdc: true } });
        if (!escrow) throw new Error('Escrow not found.');
        if (escrow.payerId !== customerId) throw new Error('Escrow payer does not match the customer.');
        if (escrow.payeeId !== business.userId) throw new Error('Escrow payee does not match the business owner.');
        if (Number(escrow.amountUsdc) !== amount) throw new Error('Escrow amount does not match the order amount.');
    }

    const orderRef = await _generateOrderRef(prisma);
    const order = await prisma.businessOrder.create({
        data: { businessProfileId, customerId, productId: productId || null, escrowId: escrowId || null, ticketId: ticketId || null, status: 'AWAITING_PAYMENT', orderRef, title: cleanTitle, description: description ? String(description).slice(0, 500) : null, amountUsdc: amount, customerNotes: customerNotes ? String(customerNotes).slice(0, 500) : null }
    });
    emitWebhookEvent(businessProfileId, 'order.created', { orderId: order.id, orderRef: order.orderRef, customerId, amount: order.amountUsdc, status: order.status });
    return order;
};

const getOrder = async (prisma, { orderId }) => prisma.businessOrder.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });

const listOrdersForBusiness = async (prisma, { businessProfileId, status, limit, cursor, customerId, productId, dateFrom, dateTo }) => {
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const from = _parseDate(dateFrom, 'dateFrom');
    const to = _parseDate(dateTo, 'dateTo');
    if (from && to && from > to) throw new Error('dateFrom must be earlier than or equal to dateTo.');
    const where = { businessProfileId };
    if (status) where.status = status;
    if (customerId) where.customerId = parseInt(customerId, 10);
    if (productId) where.productId = productId;
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = from; if (to) where.createdAt.lte = to; }
    const boundary = await _cursorBoundary(prisma, cursor, where);
    const pageWhere = { ...where };
    if (boundary) pageWhere.AND = [{ OR: [{ createdAt: { lt: boundary.createdAt } }, { createdAt: boundary.createdAt, id: { lt: boundary.id } }] }];
    const [total, rows] = await Promise.all([
        prisma.businessOrder.count({ where }),
        prisma.businessOrder.findMany({ where: pageWhere, take: take + 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: ORDER_INCLUDE })
    ]);
    const hasMore = rows.length > take;
    const orders = hasMore ? rows.slice(0, take) : rows;
    return { orders, hasMore, nextCursor: hasMore ? orders[orders.length - 1].id : null, total };
};

const listOrdersForCustomer = async (prisma, { customerId, status, limit, cursor }) => {
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const scope = { customerId };
    if (status) scope.status = status;
    const boundary = await _cursorBoundary(prisma, cursor, scope);
    const where = { ...scope };
    if (boundary) where.AND = [{ OR: [{ createdAt: { lt: boundary.createdAt } }, { createdAt: boundary.createdAt, id: { lt: boundary.id } }] }];
    const rows = await prisma.businessOrder.findMany({ where, take: take + 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: ORDER_INCLUDE });
    const hasMore = rows.length > take;
    const orders = hasMore ? rows.slice(0, take) : rows;
    return { orders, hasMore, nextCursor: hasMore ? orders[orders.length - 1].id : null };
};

const markDelivered = async (prisma, { orderId, businessProfileId, deliveryNotes }) => {
    const updated = await prisma.businessOrder.updateMany({ where: { id: orderId, businessProfileId, status: 'PAID' }, data: { status: 'DELIVERED', deliveredAt: new Date(), deliveryNotes: deliveryNotes ? String(deliveryNotes).slice(0, 500) : null } });
    if (updated.count === 0) {
        const order = await prisma.businessOrder.findUnique({ where: { id: orderId }, select: { businessProfileId: true, status: true } });
        if (!order) throw new Error('Order not found.');
        if (order.businessProfileId !== businessProfileId) throw new Error('You do not own this order.');
        throw new Error(`Order must be in PAID status to mark as delivered. Current status: ${order.status}.`);
    }
    const order = await prisma.businessOrder.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (order) {
        emitWebhookEvent(businessProfileId, 'order.delivered', {
            orderId: order.id,
            orderRef: order.orderRef,
            amount: Number(order.amountUsdc),
            status: order.status,
        });
    }
    return order;
};

const updateOrderStatusFromEscrow = async (prisma, escrowId, escrowStatus) => {
    const mapped = _ESCROW_TO_ORDER[escrowStatus];
    if (!mapped) return null;
    const order = await prisma.businessOrder.findFirst({
        where: { escrowId },
        select: { id: true, status: true, businessProfileId: true, orderRef: true, amountUsdc: true }
    });
    if (!order) return null;
    if (!_ESCROW_ALLOWED_ORDER_STATES[escrowStatus]?.includes(order.status)) return order;
    const data = { status: mapped };
    if (mapped === 'COMPLETED') data.completedAt = new Date();
    const transitioned = await prisma.businessOrder.updateMany({ where: { id: order.id, status: order.status }, data });
    if (transitioned.count === 0) return prisma.businessOrder.findUnique({ where: { id: order.id }, select: { id: true, status: true, completedAt: true, cancelledAt: true } });
    const updated = await prisma.businessOrder.findUnique({ where: { id: order.id }, select: { id: true, status: true, completedAt: true, cancelledAt: true, orderRef: true, amountUsdc: true } });
    if (mapped === 'COMPLETED' && updated?.status === 'COMPLETED') {
        emitWebhookEvent(order.businessProfileId, 'order.completed', {
            orderId: updated.id,
            orderRef: updated.orderRef || order.orderRef,
            amount: Number(updated.amountUsdc ?? order.amountUsdc),
            status: updated.status,
        });
    }
    return updated;
};

const getBusinessStats = async (prisma, { businessProfileId }) => {
    const [totalOrders, completedOrders, pendingOrders, disputedOrders, cancelledOrders, revenueAgg, recentOrders] = await Promise.all([
        prisma.businessOrder.count({ where: { businessProfileId } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: 'COMPLETED' } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: { in: ['AWAITING_PAYMENT', 'PAID', 'DELIVERED'] } } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: 'DISPUTED' } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: { in: ['REFUNDED', 'CANCELLED'] } } }),
        prisma.businessOrder.aggregate({ where: { businessProfileId, status: 'COMPLETED' }, _sum: { amountUsdc: true } }),
        prisma.businessOrder.findMany({ where: { businessProfileId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5, include: ORDER_INCLUDE })
    ]);
    const totalRevenue = Number(revenueAgg._sum.amountUsdc || 0);
    return { totalOrders, completedOrders, pendingOrders, disputedOrders, cancelledOrders, totalRevenue, avgOrderValue: completedOrders > 0 ? totalRevenue / completedOrders : 0, recentOrders };
};

module.exports = { createOrder, getOrder, listOrdersForBusiness, listOrdersForCustomer, markDelivered, updateOrderStatusFromEscrow, getBusinessStats };