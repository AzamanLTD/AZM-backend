'use strict';

const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const {
  validateConfiguredProduct,
  configuredUnitPrice,
  normalizedSelection,
} = require('../services/storefrontProductConfigurationService');

const ORDER_STATUSES = new Set([
  'AWAITING_PAYMENT', 'PAID', 'DELIVERED', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'CANCELLED',
]);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scopedIdempotencyKey(businessProfileId, userId, clientKey) {
  return `v1:${businessProfileId}:${userId}:${sha256(String(clientKey)).slice(0, 48)}`;
}

function checkoutFingerprint(body) {
  return sha256(stableJson({
    items: (body.items || []).map(item => ({
      productId: item.productId,
      quantity: item.quantity,
      notes: item.notes ?? null,
      variants: item.variants ?? {},
    })),
    customerNotes: body.customerNotes ?? null,
    deliveryNotes: body.deliveryNotes ?? null,
    paymentMode: String(body.paymentMode || 'DIRECT').toUpperCase(),
  }));
}

async function findExistingByScopedKey(prisma, businessProfileId, customerId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const rows = await prisma.$queryRaw`
    SELECT id, "orderRef", status, "idempotencyRequestHash"
    FROM "BusinessOrder"
    WHERE "businessProfileId" = ${businessProfileId}
      AND "customerId" = ${customerId}
      AND "idempotencyKey" = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function attachVariantSnapshots(prisma, order) {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) return order;
  const rows = await prisma.$queryRaw`
    SELECT id, variants
    FROM "BusinessOrderItem"
    WHERE "orderId" = ${order.id}
  `;
  const byId = new Map(rows.map(row => [row.id, row.variants ?? {}]));
  order.items = order.items.map(item => ({ ...item, variants: byId.get(item.id) ?? {} }));
  return order;
}

async function attachVariantSnapshotsToOrders(prisma, orders) {
  if (!orders.length) return orders;
  const orderIds = orders.map(order => order.id);
  const rows = await prisma.$queryRaw`
    SELECT id, "orderId", variants
    FROM "BusinessOrderItem"
    WHERE "orderId" IN (${Prisma.join(orderIds)})
  `;
  const byOrder = new Map();
  for (const row of rows) {
    if (!byOrder.has(row.orderId)) byOrder.set(row.orderId, new Map());
    byOrder.get(row.orderId).set(row.id, row.variants ?? {});
  }
  for (const order of orders) {
    const byId = byOrder.get(order.id) || new Map();
    order.items = (order.items || []).map(item => ({ ...item, variants: byId.get(item.id) ?? {} }));
  }
  return orders;
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!decoded?.createdAt || !decoded?.id) return null;
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: String(decoded.id) };
  } catch (_) {
    return null;
  }
}

function encodeCursor(order) {
  return Buffer.from(JSON.stringify({ createdAt: order.createdAt.toISOString(), id: order.id })).toString('base64url');
}

function persistenceFailure(res, originalStatus, originalJson, logger, err) {
  logger?.error?.({ err }, 'Storefront checkout configuration persistence failed');
  originalStatus(503);
  return originalJson({
    success: false,
    message: 'Checkout completed but configuration data could not be finalized. Please retry safely.',
    retryable: true,
  });
}

async function finalizeConfiguredCheckout(prisma, order, preparedItems, paymentMode, logger) {
  if (!order?.id || !Array.isArray(preparedItems) || preparedItems.length === 0) return order;

  const currentItems = Array.isArray(order.items) ? order.items : [];
  const configuredTotals = preparedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const baseTotals = currentItems.reduce((sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 0), 0);
  const revenueAdjustments = new Map();

  const updated = await prisma.$transaction(async tx => {
    for (let index = 0; index < currentItems.length && index < preparedItems.length; index += 1) {
      const returnedItem = currentItems[index];
      const prepared = preparedItems[index];
      const lineTotal = Number((prepared.unitPrice * prepared.quantity).toFixed(6));
      const baseLineTotal = Number((Number(returnedItem.unitPrice || 0) * Number(returnedItem.quantity || 0)).toFixed(6));
      const delta = Number((lineTotal - baseLineTotal).toFixed(6));
      if (delta !== 0) revenueAdjustments.set(prepared.productId, (revenueAdjustments.get(prepared.productId) || 0) + delta);

      await tx.$executeRaw`
        UPDATE "BusinessOrderItem"
        SET "unitPrice" = ${prepared.unitPrice},
            "lineTotal" = ${lineTotal},
            variants = ${JSON.stringify(prepared.selection)}::jsonb
        WHERE id = ${returnedItem.id}
          AND "orderId" = ${order.id}
      `;

      returnedItem.unitPrice = prepared.unitPrice;
      returnedItem.lineTotal = lineTotal;
      returnedItem.variants = prepared.selection;
    }

    const authoritativeTotal = Number(configuredTotals.toFixed(6));
    await tx.$executeRaw`
      UPDATE "BusinessOrder"
      SET "amountUsdc" = ${authoritativeTotal}
      WHERE id = ${order.id}
    `;
    order.amountUsdc = authoritativeTotal;

    for (const [productId, delta] of revenueAdjustments.entries()) {
      await tx.businessProduct.updateMany({
        where: { id: productId },
        data: { totalRevenue: { increment: delta } },
      });
    }

    if (String(paymentMode || 'DIRECT').toUpperCase() === 'ESCROW') {
      let feePct = null;
      const settings = await tx.globalSettings.findUnique({ where: { id: 1 }, select: { smartEscrowFeePct: true } });
      if (settings?.smartEscrowFeePct != null) feePct = Number(settings.smartEscrowFeePct);
      if (!Number.isFinite(feePct)) feePct = 0.01;
      const feeUsdc = Number((authoritativeTotal * feePct).toFixed(6));
      if (order.escrow?.id) {
        await tx.$executeRaw`
          UPDATE "SmartEscrow"
          SET "amountUsdc" = ${authoritativeTotal},
              "feeUsdc" = ${feeUsdc}
          WHERE id = ${order.escrow.id}
        `;
        order.escrow.amountUsdc = authoritativeTotal;
        order.escrow.feeUsdc = feeUsdc;
      }
      if (order.ticketId) {
        await tx.$executeRaw`
          UPDATE "Ticket"
          SET "targetAmount" = ${authoritativeTotal}
          WHERE id = ${order.ticketId}
        `;
      }
    }

    return order;
  });

  if (configuredTotals !== baseTotals) {
    logger?.info?.({ orderId: updated.id, baseTotals, configuredTotals }, 'Storefront checkout amount reconciled from authoritative product configuration');
  }
  return updated;
}

router.post('/:businessProfileId/checkout', protect, protectActive, async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const { businessProfileId } = req.params;
    const userId = req.user.id;
    const body = req.body || {};

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ success: false, message: 'items array is required and must not be empty.' });
    }
    if (body.items.length > 50) {
      return res.status(400).json({ success: false, message: 'Maximum 50 items per order.' });
    }

    const productIds = body.items.map(item => item?.productId).filter(Boolean);
    if (productIds.length !== body.items.length) {
      return res.status(400).json({ success: false, message: 'All items must have a productId.' });
    }

    const products = await prisma.businessProduct.findMany({
      where: { id: { in: productIds }, businessProfileId, isActive: true, isAvailable: true },
      select: { id: true, priceUsdc: true, variants: true, modifierGroups: true },
    });
    const productMap = new Map(products.map(product => [product.id, product]));
    const preparedItems = [];

    for (const item of body.items) {
      const product = productMap.get(item.productId);
      if (!product) {
        return res.status(404).json({ success: false, message: `Product ${item.productId} not available.` });
      }

      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
        return res.status(400).json({ success: false, message: `Invalid quantity for product ${item.productId}.` });
      }

      const validation = validateConfiguredProduct(product, item.variants);
      if (validation.error) return res.status(400).json({ success: false, message: validation.error });

      preparedItems.push({
        productId: product.id,
        quantity,
        unitPrice: configuredUnitPrice(product, item.variants),
        selection: normalizedSelection(product, item.variants),
      });
    }

    const clientKey = body.idempotencyKey == null ? null : String(body.idempotencyKey).trim();
    const idempotencyKey = clientKey ? scopedIdempotencyKey(businessProfileId, userId, clientKey) : null;
    const requestHash = checkoutFingerprint(body);

    if (idempotencyKey) {
      const existing = await findExistingByScopedKey(prisma, businessProfileId, userId, idempotencyKey);
      if (existing) {
        if (existing.idempotencyRequestHash && existing.idempotencyRequestHash !== requestHash) {
          return res.status(409).json({ success: false, message: 'This checkout idempotency key was already used for different cart contents.' });
        }
        try {
          const order = await prisma.businessOrder.findUnique({ where: { id: existing.id }, include: { items: true, escrow: true } });
          await attachVariantSnapshots(prisma, order);
          return res.status(200).json({ success: true, data: { order, idempotent: true } });
        } catch (err) {
          return persistenceFailure(res, res.status.bind(res), res.json.bind(res), req.app.get('logger'), err);
        }
      }
    }

    req.body = { ...body, ...(idempotencyKey ? { idempotencyKey } : {}) };
    req._storefrontConfiguredItems = preparedItems;

    let statusCode = 200;
    const originalStatus = res.status.bind(res);
    const originalJson = res.json.bind(res);
    res.status = code => {
      statusCode = code;
      return originalStatus(code);
    };
    res.json = async payload => {
      try {
        if (statusCode === 400 && idempotencyKey && typeof payload?.message === 'string' && payload.message.includes('idempotencyKey')) {
          const existing = await findExistingByScopedKey(prisma, businessProfileId, userId, idempotencyKey);
          if (existing) {
            if (existing.idempotencyRequestHash && existing.idempotencyRequestHash !== requestHash) {
              originalStatus(409);
              return originalJson({ success: false, message: 'This checkout idempotency key was already used for different cart contents.' });
            }
            try {
              const order = await prisma.businessOrder.findUnique({ where: { id: existing.id }, include: { items: true, escrow: true } });
              await attachVariantSnapshots(prisma, order);
              originalStatus(200);
              return originalJson({ success: true, data: { order, idempotent: true } });
            } catch (err) {
              return persistenceFailure(res, originalStatus, originalJson, req.app.get('logger'), err);
            }
          }
        }

        const order = payload?.data?.order;
        if (payload?.success && order?.id) {
          if (idempotencyKey) {
            await prisma.$executeRaw`
              UPDATE "BusinessOrder"
              SET "idempotencyRequestHash" = ${requestHash}
              WHERE id = ${order.id}
                AND "businessProfileId" = ${businessProfileId}
                AND "customerId" = ${userId}
            `;
          }

          const returnedItems = Array.isArray(order.items) ? order.items : [];
          const configuredOrder = await finalizeConfiguredCheckout(
            prisma,
            order,
            req._storefrontConfiguredItems,
            body.paymentMode,
            req.app.get('logger'),
          );

          if (configuredOrder?.items) payload.data.order = configuredOrder;
        }
      } catch (err) {
        return persistenceFailure(res, originalStatus, originalJson, req.app.get('logger'), err);
      }
      return originalJson(payload);
    };

    return next();
  } catch (err) {
    return next(err);
  }
});

router.get('/me/orders', protect, protectActive, async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const cursorRaw = req.query.cursor ? String(req.query.cursor) : null;
    const cursor = decodeCursor(cursorRaw);
    if (cursorRaw && !cursor) return res.status(400).json({ success: false, message: 'Invalid order history cursor.' });
    const status = req.query.status ? String(req.query.status).trim().toUpperCase() : null;
    if (status && !ORDER_STATUSES.has(status)) return res.status(400).json({ success: false, message: 'Invalid order status filter.' });

    const where = {
      customerId: req.user.id,
      ...(status ? { status } : {}),
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
    };
    const rows = await prisma.businessOrder.findMany({
      where,
      include: { items: true, escrow: true, businessProfile: { select: { id: true, businessName: true, category: true, logoUrl: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const orders = hasMore ? rows.slice(0, take) : rows;
    await attachVariantSnapshotsToOrders(prisma, orders);
    return res.json({ success: true, data: { orders, hasMore, nextCursor: hasMore ? encodeCursor(orders[orders.length - 1]) : null } });
  } catch (err) {
    return next(err);
  }
});

router.get('/me/orders/:orderId', protect, protectActive, async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const order = await prisma.businessOrder.findFirst({
      where: { id: req.params.orderId, customerId: req.user.id },
      include: { items: true, escrow: true, ticket: true, businessProfile: { select: { id: true, businessName: true, category: true, logoUrl: true } } },
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    await attachVariantSnapshots(prisma, order);
    return res.json({ success: true, data: { order } });
  } catch (err) {
    return next(err);
  }
});

router.get('/:businessProfileId/orders', protect, protectActive, async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const { businessProfileId } = req.params;
    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const [orders, total] = await Promise.all([
      prisma.businessOrder.findMany({ where: { businessProfileId, customerId: req.user.id }, include: { items: true, escrow: true }, orderBy: { createdAt: 'desc' }, take, skip }),
      prisma.businessOrder.count({ where: { businessProfileId, customerId: req.user.id } }),
    ]);
    await attachVariantSnapshotsToOrders(prisma, orders);
    return res.json({ success: true, data: { orders, total, hasMore: skip + orders.length < total } });
  } catch (err) {
    return next(err);
  }
});

router.get('/:businessProfileId/orders/:orderId', protect, protectActive, async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const order = await prisma.businessOrder.findFirst({ where: { id: req.params.orderId, businessProfileId: req.params.businessProfileId, customerId: req.user.id }, include: { items: true, escrow: true, ticket: true } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    await attachVariantSnapshots(prisma, order);
    return res.json({ success: true, data: { order } });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
