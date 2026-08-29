'use strict';

const crypto = require('crypto');
const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

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

function normalizeVariantOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(option => {
    if (option && typeof option === 'object') {
      return String(option.label ?? option.value ?? option.name ?? '').trim();
    }
    return String(option ?? '').trim();
  }).filter(Boolean);
}

function validateVariants(product, selected) {
  const definition = product.variants;
  const selection = selected == null ? {} : selected;
  if (!selection || Array.isArray(selection) || typeof selection !== 'object') {
    return 'variants must be an object keyed by option group.';
  }

  const groups = definition && typeof definition === 'object' && !Array.isArray(definition)
    ? definition
    : {};
  const groupNames = Object.keys(groups);
  const selectedNames = Object.keys(selection);

  for (const group of selectedNames) {
    if (!Object.prototype.hasOwnProperty.call(groups, group)) {
      return `Unknown variant option group: ${group}.`;
    }
  }
  for (const group of groupNames) {
    const value = selection[group];
    if (value == null || String(value).trim() === '') {
      return `Variant option ${group} must be selected.`;
    }
    const allowed = normalizeVariantOptions(groups[group]);
    if (allowed.length > 0 && !allowed.includes(String(value))) {
      return `Invalid value for variant option ${group}.`;
    }
  }
  return null;
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

// This router intentionally sits before the legacy storefront router. It adds
// the security/integrity contract around the existing checkout implementation
// without duplicating its escrow/order lifecycle logic.
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
      select: { id: true, variants: true },
    });
    const productMap = new Map(products.map(product => [product.id, product]));

    for (const item of body.items) {
      const product = productMap.get(item.productId);
      if (!product) {
        return res.status(404).json({ success: false, message: `Product ${item.productId} not available.` });
      }
      const variantError = validateVariants(product, item.variants);
      if (variantError) {
        return res.status(400).json({ success: false, message: variantError });
      }
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
        return res.status(400).json({ success: false, message: `Invalid quantity for product ${item.productId}.` });
      }
    }

    const clientKey = body.idempotencyKey == null ? null : String(body.idempotencyKey).trim();
    const idempotencyKey = clientKey ? scopedIdempotencyKey(businessProfileId, userId, clientKey) : null;
    const requestHash = checkoutFingerprint(body);

    if (idempotencyKey) {
      const existing = await findExistingByScopedKey(prisma, businessProfileId, userId, idempotencyKey);
      if (existing) {
        if (existing.idempotencyRequestHash && existing.idempotencyRequestHash !== requestHash) {
          return res.status(409).json({
            success: false,
            message: 'This checkout idempotency key was already used for different cart contents.',
          });
        }
        const order = await prisma.businessOrder.findUnique({
          where: { id: existing.id },
          include: { items: true, escrow: true },
        });
        return res.status(200).json({ success: true, data: { order, idempotent: true } });
      }
    }

    // Preserve the existing checkout implementation and its authoritative
    // pricing/escrow behavior, but never pass the client-global key through.
    req.body = { ...body, ...(idempotencyKey ? { idempotencyKey } : {}) };

    const originalJson = res.json.bind(res);
    res.json = async payload => {
      try {
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
          for (let index = 0; index < returnedItems.length; index += 1) {
            const returnedItem = returnedItems[index];
            const sourceItem = body.items.find(item => item.productId === returnedItem.productId &&
              JSON.stringify(item.variants ?? {}) === JSON.stringify(returnedItem.variants ?? {}));
            if (!sourceItem || !returnedItem.id) continue;
            await prisma.$executeRaw`
              UPDATE "BusinessOrderItem"
              SET variants = ${JSON.stringify(sourceItem.variants ?? {})}::jsonb
              WHERE id = ${returnedItem.id} AND "orderId" = ${order.id}
            `;
            returnedItem.variants = sourceItem.variants ?? {};
          }
        }
      } catch (err) {
        // Do not turn a successfully-created order into an HTTP failure because
        // the non-financial snapshot persistence failed. Log via the app logger
        // if available; the next order retrieval can still expose the core line.
        req.app.get('logger')?.warn?.({ err }, 'Retail checkout snapshot persistence failed');
      }
      return originalJson(payload);
    };

    return next();
  } catch (err) {
    return next(err);
  }
});

// Customer-scoped order list. This deliberately returns line items so a
// multi-item checkout can be reconstructed without relying on BusinessOrder's
// legacy single-productId column.
router.get('/:businessProfileId/orders', protect, protectActive, async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const { businessProfileId } = req.params;
    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const [orders, total] = await Promise.all([
      prisma.businessOrder.findMany({
        where: { businessProfileId, customerId: req.user.id },
        include: { items: true, escrow: true },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      prisma.businessOrder.count({ where: { businessProfileId, customerId: req.user.id } }),
    ]);
    return res.json({ success: true, data: { orders, total, hasMore: skip + orders.length < total } });
  } catch (err) {
    return next(err);
  }
});

router.get('/:businessProfileId/orders/:orderId', protect, protectActive, async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const order = await prisma.businessOrder.findFirst({
      where: {
        id: req.params.orderId,
        businessProfileId: req.params.businessProfileId,
        customerId: req.user.id,
      },
      include: { items: true, escrow: true, ticket: true },
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    return res.json({ success: true, data: { order } });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
