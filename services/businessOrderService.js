// services/businessOrderService.js
const { emitWebhookEvent } = require('./webhookEmitter');
const { sumOrdersByCurrency, averageOrderValue } = require('../src/lib/businessRevenueAggregate');
const { randomBytes } = require('crypto');
const { Prisma } = require('@prisma/client');
const { OrderCurrencyError, CODES: CURRENCY_CODES } = require('../src/lib/businessOrderCurrency');

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

const _getRevenueByDay = async (prisma, businessProfileId) => {
    const to = new Date();
    const from = new Date(to);
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - 29);

    // PARTITIONED BY CURRENCY, NEVER MERGED (local-fiat-first).
    //
    // This series used to be COALESCE(SUM("amountUsdc"), 0) per day. A native-GHS
    // order carries NO USDC amount at all (the CHECK enforces the pairing), so a
    // merchant who takes only cedis saw a chart of zeros while their money was
    // real. A total that omits the customer's money is not a display nuance, it
    // is a wrong number. Merging the two would be wrong the other way: it would
    // present cedis as dollars.
    //
    // Rules this shape encodes:
    //  - GHS comes from "amountGhs" (exact pesewas), never from a valuation.
    //  - USDC comes from "amountUsdc". Rows written before the currency contract
    //    carry a USDC amount and a NULL currency; they count as USDC, which is
    //    what they are, and are never re-labelled as cedis.
    //  - A currency with no activity that day is null, not 0: a merchant with no
    //    USDC takings simply has no USDC reading. That is the normal state.
    //  - Sums come back ::text so no value passes through a JS float.
    //  - a corrupt row (both amounts, or neither for a tagged order, or an
    //    unknown currency) does NOT get counted into a total and does NOT get
    //    skipped. The per-order reader refuses such a row outright, and this
    //    series refuses with it: two different answers to "what is this row
    //    worth" is how a chart quietly disagrees with a total.
    const rows = await prisma.$queryRaw`
        SELECT DATE_TRUNC('day', "createdAt") AS date,
               COALESCE(SUM(CASE WHEN "currency" = 'GHS' THEN "amountGhs" ELSE 0 END), 0)::text AS ghs,
               COUNT(*) FILTER (WHERE "currency" = 'GHS') AS ghs_count,
               COALESCE(SUM(CASE WHEN ("currency" IS NULL OR "currency" = 'USDC') THEN "amountUsdc" ELSE 0 END), 0)::text AS usdc,
               COUNT(*) FILTER (WHERE "currency" IS NULL OR "currency" = 'USDC') AS usdc_count,
               COUNT(*) FILTER (
                   WHERE ("currency" = 'GHS'  AND ("amountGhs" IS NULL OR "amountUsdc" IS NOT NULL))
                      OR ("currency" = 'USDC' AND "amountUsdc" IS NULL)
                      OR ("currency" IS NOT NULL AND "currency" NOT IN ('GHS', 'USDC'))
               ) AS corrupt
        FROM "BusinessOrder"
        WHERE "businessProfileId" = ${businessProfileId}
          AND status = 'COMPLETED'
          AND "createdAt" >= ${from}
        GROUP BY 1
        ORDER BY 1 ASC
    `;

    const byDate = new Map();
    for (const row of rows) {
        byDate.set(new Date(row.date).toISOString().slice(0, 10), row);
    }

    const corruptDays = rows.filter((row) => Number(row.corrupt) > 0);
    if (corruptDays.length > 0) {
        // Same refusal as sumOrdersByCurrency / readOrderAmount. A row that
        // cannot be read must never be guessed at, silently counted, or quietly
        // left out of the money the merchant sees.
        throw new OrderCurrencyError(
            CURRENCY_CODES.CORRUPT,
            `Revenue series contains ${corruptDays.length} day(s) with unreadable order amounts.`,
            { days: corruptDays.map((r) => new Date(r.date).toISOString().slice(0, 10)) }
        );
    }

    const result = [];
    for (let cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        const key = cursor.toISOString().slice(0, 10);
        const label = new Intl.DateTimeFormat('en', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
        }).format(cursor);

        const row = byDate.get(key);
        const ghsCount = row ? Number(row.ghs_count) : 0;
        const usdcCount = row ? Number(row.usdc_count) : 0;
        // A caller-supplied row is read defensively: the legacy series contract
        // was {date, revenue}, and a double that still returns exactly that must
        // not crash the endpoint. Missing partitions simply mean no reading.
        const ghs = row ? new Prisma.Decimal(row.ghs ?? '0') : null;
        const usdc = row ? new Prisma.Decimal(row.usdc ?? '0') : null;

        result.push({
            date: key,
            label,
            // Legacy USDC scalar, unchanged meaning, kept for existing clients.
            revenue: row && row.revenue !== undefined
                ? Number(row.revenue)
                : (usdc ? Number(usdc) : 0),
            byCurrency: {
                GHS: ghsCount > 0 ? ghs.toFixed(2) : null,
                USDC: usdcCount > 0 ? usdc.toFixed(8) : null,
            },
        });
    }
    return result;
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
    const [totalOrders, completedOrders, pendingOrders, disputedOrders, cancelledOrders, revenueAgg, revenueRows, recentOrders, revenueByDay, invoiceSent, invoicePaid, invoiceRevenue] = await Promise.all([
        prisma.businessOrder.count({ where: { businessProfileId } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: 'COMPLETED' } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: { in: ['AWAITING_PAYMENT', 'PAID', 'DELIVERED'] } } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: 'DISPUTED' } }),
        prisma.businessOrder.count({ where: { businessProfileId, status: { in: ['REFUNDED', 'CANCELLED'] } } }),
        // Legacy USDC scalar. SQL SUM ignores NULLs, so this counts only orders
        // that actually carry a USDC amount — which is what it has always meant.
        prisma.businessOrder.aggregate({ where: { businessProfileId, status: 'COMPLETED' }, _sum: { amountUsdc: true } }),
        // Currency-partitioned totals, added alongside it (never merged).
        // See src/lib/businessRevenueAggregate.js.
        prisma.businessOrder.findMany({
            where: { businessProfileId, status: 'COMPLETED' },
            select: { currency: true, amountUsdc: true, amountGhs: true },
        }),
        prisma.businessOrder.findMany({ where: { businessProfileId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5, include: ORDER_INCLUDE }),
        _getRevenueByDay(prisma, businessProfileId),
        prisma.businessInvoice.count({ where: { businessProfileId, status: 'SENT' } }),
        prisma.businessInvoice.count({ where: { businessProfileId, status: 'PAID' } }),
        prisma.businessInvoice.aggregate({ where: { businessProfileId, status: 'PAID' }, _sum: { billTotalUsdc: true } }),
    ]);
    const revenue = sumOrdersByCurrency(revenueRows);

    // The single figure a dashboard can show without lying. Native GHS wins
    // whenever the merchant has taken cedis, because GHS is the primary rail and
    // for many merchants the only one. USDC appears only when it is the sole
    // activity. This is a CHOICE BETWEEN the two, never a sum of them, and it is
    // null when there is no revenue at all rather than 0.00 of some assumed
    // currency.
    const headline = revenue.counts.GHS > 0
        ? { currency: 'GHS', amount: revenue.GHS }
        : (revenue.counts.USDC > 0 ? { currency: 'USDC', amount: revenue.USDC } : null);
    // `totalRevenue` is kept for existing clients and means USDC revenue ONLY
    // (the SUM above ignores NULL USDC amounts, so GHS orders never enter it).
    // It must never become a merged GHS+USDC figure.
    const totalRevenue = Number(revenueAgg._sum.amountUsdc || 0);
    return {
        totalOrders,
        completedOrders,
        pendingOrders,
        disputedOrders,
        cancelledOrders,
        totalRevenue,
        revenue,
        headline,
        revenueBasis: 'PER_CURRENCY',
        avgOrderValueByCurrency: averageOrderValue(revenue),
        avgOrderValue: completedOrders > 0 ? totalRevenue / completedOrders : 0,
        recentOrders,
        revenueByDay,
        revenueByDayBasis: 'PER_CURRENCY',
        invoiceStats: {
            sent: invoiceSent,
            paid: invoicePaid,
            paidRevenue: Number(invoiceRevenue._sum.billTotalUsdc || 0),
        },
    };
};

module.exports = { createOrder, getOrder, listOrdersForBusiness, listOrdersForCustomer, markDelivered, updateOrderStatusFromEscrow, getBusinessStats };