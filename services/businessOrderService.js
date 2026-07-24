// services/businessOrderService.js
// =============================================================================
// AZAMAN — Business Order Service (2026-06-16)
//
// IMPORTANT: This service tracks order state only. It NEVER moves USDC. All
// financial mutations live in escrowService.js. Do NOT add $transaction blocks
// here.
//
// A BusinessOrder is the merchant-facing state mirror of a SmartEscrow. Escrow
// state changes are propagated here via updateOrderStatusFromEscrow, called
// exclusively from setImmediate hooks inside escrowService (Work Item 4).
// =============================================================================

const logger = require('../src/config/logger');
const { randomBytes } = require('crypto');

// ── private helpers ───────────────────────────────────────────────────────────

/** Generate a unique human-friendly order reference (e.g. ORD-260616-A3F2). */
const _generateOrderRef = async (prisma) => {
    for (let i = 0; i < 5; i++) {
        const suffix = randomBytes(2).toString('hex').toUpperCase(); // 4 hex chars
        const date   = new Date().toISOString().slice(2, 10).replace(/-/g, '');
        const ref    = `ORD-${date}-${suffix}`; // e.g. ORD-260616-A3F2
        const clash  = await prisma.businessOrder.findUnique({ where: { orderRef: ref } });
        if (!clash) return ref;
    }
    throw new Error('Could not generate a unique order reference. Please retry.');
};

// Shared include block (used by all order reads).
const ORDER_INCLUDE = {
    customer: { select: { id: true, username: true, profilePictureUrl: true, azamanId: true } },
    product:  { select: { id: true, name: true, slug: true, imageUrls: true } },
    escrow:   { select: { id: true, status: true, amountUsdc: true, feeUsdc: true,
                        fundedAt: true, settledAt: true, payerSatisfied: true,
                        payeeSatisfied: true } },
    ticket:   { select: { id: true, name: true, status: true } }
};

// Escrow status → order status mapping for updateOrderStatusFromEscrow.
const _ESCROW_TO_ORDER = {
    FUNDED:   'PAID',
    SETTLED:  'COMPLETED',
    RELEASED: 'COMPLETED',
    DISPUTED: 'DISPUTED',
    REFUNDED: 'REFUNDED',
    EXPIRED:  'REFUNDED'
};

// =============================================================================
// 1. CREATE ORDER — state record only, status AWAITING_PAYMENT.
// =============================================================================
const createOrder = async (prisma, {
    businessProfileId, customerId, productId, escrowId, ticketId,
    amountUsdc, title, description, customerNotes
}) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');
    if (!customerId) throw new Error('customerId is required.');

    const amount = Number(amountUsdc);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('amountUsdc must be a positive finite number.');
    }
    const cleanTitle = String(title || '').trim();
    if (cleanTitle.length < 1 || cleanTitle.length > 200) {
        throw new Error('title must be 1–200 chars.');
    }

    // If a product is referenced, it must belong to this business and be active.
    if (productId) {
        const product = await prisma.businessProduct.findUnique({
            where: { id: productId },
            select: { id: true, businessProfileId: true, isActive: true }
        });
        if (!product || product.businessProfileId !== businessProfileId) {
            throw new Error('Product not found.');
        }
        if (!product.isActive) {
            throw new Error('Product is not available.');
        }
    }

    const orderRef = await _generateOrderRef(prisma);

    return prisma.businessOrder.create({
        data: {
            businessProfileId,
            customerId,
            productId: productId || null,
            escrowId: escrowId || null,
            ticketId: ticketId || null,
            status: 'AWAITING_PAYMENT',
            orderRef,
            title: cleanTitle,
            description: description ? String(description).slice(0, 500) : null,
            amountUsdc: amount,
            customerNotes: customerNotes ? String(customerNotes).slice(0, 500) : null
        }
    });
};

// =============================================================================
// 2. GET ORDER — by id, with full projections.
// =============================================================================
const getOrder = async (prisma, { orderId }) =>
    prisma.businessOrder.findUnique({
        where: { id: orderId },
        include: ORDER_INCLUDE
    });

// =============================================================================
// 3. LIST ORDERS FOR BUSINESS — filtered + paginated, with total count.
// =============================================================================
const listOrdersForBusiness = async (prisma, {
    businessProfileId, status, limit, cursor, customerId, productId, dateFrom, dateTo
}) => {
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

    const where = { businessProfileId };
    if (status) where.status = status;
    if (customerId) where.customerId = parseInt(customerId, 10);
    if (productId) where.productId = productId;
    if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) where.createdAt.gte = new Date(dateFrom);
        if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    // Count + page in parallel. The count is a SEPARATE count() call — not
    // groupBy, not raw SQL (per the hard constraint).
    const [total, rows] = await Promise.all([
        prisma.businessOrder.count({ where }),
        prisma.businessOrder.findMany({
            where,
            take: take + 1,
            orderBy: { createdAt: 'desc' },
            include: ORDER_INCLUDE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        })
    ]);

    const hasMore = rows.length > take;
    const orders = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? orders[orders.length - 1].id : null;

    return { orders, hasMore, nextCursor, total };
};

// =============================================================================
// 4. LIST ORDERS FOR CUSTOMER — the caller's own purchase history.
// =============================================================================
const listOrdersForCustomer = async (prisma, { customerId, status, limit, cursor }) => {
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

    const where = { customerId };
    if (status) where.status = status;

    const rows = await prisma.businessOrder.findMany({
        where,
        take: take + 1,
        orderBy: { createdAt: 'desc' },
        include: ORDER_INCLUDE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasMore = rows.length > take;
    const orders = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? orders[orders.length - 1].id : null;

    return { orders, hasMore, nextCursor };
};

// =============================================================================
// 5. MARK DELIVERED — business signals delivery (PAID → DELIVERED).
// =============================================================================
const markDelivered = async (prisma, { orderId, businessProfileId, deliveryNotes }) => {
    const order = await prisma.businessOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new Error('Order not found.');
    if (order.businessProfileId !== businessProfileId) {
        throw new Error('You do not own this order.');
    }
    if (order.status !== 'PAID') {
        throw new Error(`Order must be in PAID status to mark as delivered. Current status: ${order.status}.`);
    }

    return prisma.businessOrder.update({
        where: { id: orderId },
        data: {
            status: 'DELIVERED',
            deliveredAt: new Date(),
            deliveryNotes: deliveryNotes ? String(deliveryNotes).slice(0, 500) : null
        }
    });
};

// =============================================================================
// 6. UPDATE ORDER STATUS FROM ESCROW — called ONLY from escrowService hooks.
//    Never call directly from controllers. Returns null silently when no order
//    is linked to the escrow (P2P trades have no order).
// =============================================================================
const updateOrderStatusFromEscrow = async (prisma, escrowId, escrowStatus) => {
    const mapped = _ESCROW_TO_ORDER[escrowStatus];
    if (!mapped) return null; // unmapped escrow status (e.g. DRAFT/IN_PROGRESS) — no-op

    const order = await prisma.businessOrder.findFirst({
        where: { escrowId },
        select: { id: true }
    });
    if (!order) return null; // not every escrow has an order

    const data = { status: mapped };
    if (mapped === 'COMPLETED') data.completedAt = new Date();

    return prisma.businessOrder.update({ where: { id: order.id }, data });
};

// =============================================================================
// 7. GET BUSINESS STATS — dashboard aggregates (all counts in parallel).
// =============================================================================
const getBusinessStats = async (prisma, { businessProfileId }) => {
    const [
        totalOrders,
        completedOrders,
        pendingOrders,
        disputedOrders,
        cancelledOrders,
        revenueAgg,
        recentOrders
    ] = await Promise.all([
        prisma.businessOrder.count({ where: { businessProfileId } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: 'COMPLETED' } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: { in: ['AWAITING_PAYMENT', 'PAID', 'DELIVERED'] } } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: 'DISPUTED' } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: { in: ['REFUNDED', 'CANCELLED'] } } }),
        prisma.businessOrder.aggregate({
            where: { businessProfileId, status: 'COMPLETED' },
            _sum: { amountUsdc: true }
        }),
        prisma.businessOrder.findMany({
            where: { businessProfileId },
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: ORDER_INCLUDE
        })
    ]);

    const totalRevenue = Number(revenueAgg._sum.amountUsdc || 0);
    const avgOrderValue = completedOrders > 0 ? totalRevenue / completedOrders : 0;

    return {
        totalOrders,
        completedOrders,
        pendingOrders,
        disputedOrders,
        cancelledOrders,
        totalRevenue,
        avgOrderValue,
        recentOrders
    };
};

module.exports = {
    createOrder,
    getOrder,
    listOrdersForBusiness,
    listOrdersForCustomer,
    markDelivered,
    updateOrderStatusFromEscrow,
    getBusinessStats
};
