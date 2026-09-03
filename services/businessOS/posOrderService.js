'use strict';

const crypto = require('crypto');
const logger = require('../../src/config/logger');

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;
const isSerializableConflict = (error) => error?.code === 'P2034';
const waitForRetry = (attempt) => new Promise((resolve) => setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt)));

function buildIdempotencyFingerprint({ businessProfileId, actorId, normalizedItems, paymentMethod, cash, requestedAzm, source, locationId, tableId, requestedCustomerId }) {
    const canonical = {
        businessProfileId: String(businessProfileId),
        actorId: Number(actorId),
        items: [...normalizedItems]
            .map(({ productId, quantity }) => ({ productId: String(productId), quantity: Number(quantity) }))
            .sort((a, b) => a.productId.localeCompare(b.productId) || a.quantity - b.quantity),
        paymentMethod,
        cash,
        requestedAzm,
        source: source ?? null,
        locationId: locationId ?? null,
        tableId: tableId ?? null,
        customerId: requestedCustomerId ?? null,
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

class PosOrderService {
    constructor(prisma) { this.prisma = prisma; }

    async createOrder(args) {
        const {
            businessProfileId, actorId, items, paymentMethod = 'CASH', cashGiven,
            azmAmount, idempotencyKey, source, locationId, tableId, customerId,
        } = args;
        if (!businessProfileId) throw new Error('Business context required.');
        if (!actorId) throw new Error('Authentication required.');
        if (!Array.isArray(items) || items.length === 0) throw new Error('Items are required.');

        const pm = String(paymentMethod || 'CASH').toUpperCase();
        if (!['CASH', 'AZM', 'SPLIT'].includes(pm)) throw new Error(`Invalid payment method: ${pm}`);
        const normalizedItems = items.map((item) => ({ productId: item.productId, quantity: Number(item.qty ?? item.quantity ?? 1) }));
        for (const item of normalizedItems) {
            if (!item.productId || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) throw new Error('Each item requires a valid productId and integer quantity from 1 to 50.');
        }
        const cash = Number(cashGiven || 0);
        const requestedAzm = Number(azmAmount || 0);
        if (!Number.isFinite(cash) || cash < 0) throw new Error('Invalid cash amount.');
        if (!Number.isFinite(requestedAzm) || requestedAzm < 0) throw new Error('Invalid AZM amount.');

        const requestedCustomerId = customerId == null ? null : Number(customerId);
        if (requestedCustomerId != null && (!Number.isInteger(requestedCustomerId) || requestedCustomerId < 1)) throw new Error('Invalid customerId.');
        const idempotencyFingerprint = idempotencyKey
            ? buildIdempotencyFingerprint({
                businessProfileId, actorId, normalizedItems, paymentMethod: pm,
                cash, requestedAzm, source, locationId, tableId, requestedCustomerId,
            })
            : null;
        const existing = await this._findIdempotentOrder(businessProfileId, idempotencyKey, idempotencyFingerprint);
        if (existing) return { order: existing, duplicate: true, computedSubtotal: null, computedTax: null, computedGrand: Number(existing.amountUsdc || 0), change: Number(existing.cashChange || 0) };

        const orderRef = `POS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
            try {
                const result = await this.prisma.$transaction(async (tx) => {
                    if (idempotencyKey) {
                        const txExisting = await this._findIdempotentOrder(businessProfileId, idempotencyKey, idempotencyFingerprint, tx);
                        if (txExisting) return { order: txExisting, duplicate: true };
                    }
                    await this._validateOrderContext(tx, businessProfileId, locationId, tableId);
                    const computed = await this._priceItems(tx, businessProfileId, normalizedItems, locationId);
                    const computedTax = computed.subtotal * 0.025;
                    const computedGrand = computed.subtotal + computedTax;

                    let azmPortion = 0;
                    let cashChange = 0;
                    if (pm === 'CASH') {
                        if (cash < computedGrand) throw new Error('Insufficient cash received.');
                        cashChange = cash - computedGrand;
                    } else if (pm === 'AZM') {
                        azmPortion = computedGrand;
                    } else {
                        azmPortion = requestedAzm;
                        if (azmPortion <= 0 || azmPortion > computedGrand) throw new Error('Invalid AZM portion.');
                        if (cash + azmPortion < computedGrand) throw new Error('Insufficient payment (cash + AZM).');
                        cashChange = Math.max(0, cash - (computedGrand - azmPortion));
                    }

                    await this._consumeInventory(tx, businessProfileId, computed.items);
                    if (azmPortion > 0) {
                        const debit = await tx.user.updateMany({ where: { id: actorId, azmBalance: { gte: azmPortion } }, data: { azmBalance: { decrement: azmPortion } } });
                        if (debit.count !== 1) throw new Error('Insufficient AZM balance.');
                        const userAfterDebit = await tx.user.findUnique({ where: { id: actorId }, select: { azmBalance: true } });
                        await tx.azmSpendLog.create({ data: { userId: actorId, amount: azmPortion, reason: `POS order (${source || 'POS'})`, source: 'POS_SALE', balanceAfter: Number(userAfterDebit?.azmBalance || 0), metadata: { orderRef, businessProfileId } } });
                    }

                    const effectiveCustomerId = pm === 'CASH' ? (requestedCustomerId || actorId) : actorId;
                    if (pm === 'CASH' && requestedCustomerId) {
                        const customer = await tx.user.findUnique({ where: { id: requestedCustomerId }, select: { id: true } });
                        if (!customer) throw new Error('Customer not found.');
                    }
                    const order = await tx.businessOrder.create({ data: {
                        businessProfileId, customerId: effectiveCustomerId, status: 'COMPLETED', orderRef,
                        title: `POS Sale (${pm})`, amountUsdc: computedGrand, paymentMethod: pm, idempotencyKey,
                        cashReceived: cash || null, cashChange: cashChange || null, completedAt: new Date(),
                    } });
                    if (tx.businessOrderItem?.createMany) await tx.businessOrderItem.createMany({ data: computed.items.map((item) => ({ orderId: order.id, productId: item.productId, name: item.name, unitPrice: item.unitPrice, quantity: item.quantity, lineTotal: item.unitPrice * item.quantity })) });
                    await tx.businessLedgerEntry.create({ data: {
                        businessProfileId, type: 'INCOME', category: 'SALES', description: `POS Sale (${orderRef} - ${pm})`, amount: computedGrand,
                        sourceType: 'POS_SALE', sourceId: order.id,
                        metadata: { orderRef, paymentMethod: pm, subtotal: computed.subtotal, tax: computedTax, items: normalizedItems.length, locationId, tableId, azmPortion, ...(idempotencyFingerprint ? { posIdempotencyFingerprint: idempotencyFingerprint } : {}) },
                    } });
                    return { order, duplicate: false, computedSubtotal: computed.subtotal, computedTax, computedGrand, change: cashChange };
                }, { isolationLevel: 'Serializable' });
                logger.info({ businessProfileId, actorId, orderId: result.order.id, duplicate: result.duplicate }, '[POS] order settled atomically');
                if (result.duplicate) return { ...result, computedSubtotal: null, computedTax: null, computedGrand: Number(result.order.amountUsdc || 0), change: Number(result.order.cashChange || 0) };
                return result;
            } catch (error) {
                if (error?.code === 'P2002' && idempotencyKey) {
                    const replay = await this._findIdempotentOrder(businessProfileId, idempotencyKey, idempotencyFingerprint);
                    if (replay) return { order: replay, duplicate: true, computedSubtotal: null, computedTax: null, computedGrand: Number(replay.amountUsdc || 0), change: Number(replay.cashChange || 0) };
                }
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) throw error;
                await waitForRetry(attempt);
            }
        }
        throw new Error('Could not settle POS order after retries.');
    }

    async _findIdempotentOrder(businessProfileId, idempotencyKey, fingerprint = null, client = this.prisma) {
        if (!idempotencyKey) return null;
        const existing = await client.businessOrder.findFirst({ where: { idempotencyKey } });
        if (!existing) return null;
        if (existing.businessProfileId !== businessProfileId) throw new Error('Idempotency key already belongs to another business.');
        // Legacy rows may not have a fingerprint; preserve their safe replay semantics.
        // New POS rows store the fingerprint in the atomic POS ledger entry.
        if (fingerprint && client.businessLedgerEntry?.findFirst) {
            const ledger = await client.businessLedgerEntry.findFirst({
                where: { sourceType: 'POS_SALE', sourceId: existing.id },
                select: { metadata: true },
            });
            const storedFingerprint = ledger?.metadata?.posIdempotencyFingerprint;
            if (storedFingerprint && storedFingerprint !== fingerprint) throw new Error('Idempotency key already used for a different POS request.');
        }
        return existing;
    }

    async _validateOrderContext(tx, businessProfileId, locationId, tableId) {
        if (tableId && !locationId) throw new Error('tableId requires locationId.');
        if (locationId) {
            const location = await tx.businessLocation.findFirst({ where: { id: locationId, businessProfileId, isActive: true }, select: { id: true } });
            if (!location) throw new Error('Invalid or inactive business location.');
        }
        if (tableId) {
            const table = await tx.businessTable.findFirst({ where: { id: tableId, locationId, isActive: true }, select: { id: true } });
            if (!table) throw new Error('Invalid or inactive business table for location.');
        }
    }

    async _priceItems(tx, businessProfileId, items, locationId) {
        let subtotal = 0;
        const priced = [];
        for (const item of items) {
            const where = { id: item.productId, businessProfileId, isActive: true, isAvailable: true };
            if (locationId) where.OR = [{ locationId: null }, { locationId }];
            const product = await tx.businessProduct.findFirst({ where, select: { id: true, name: true, priceUsdc: true, stockQty: true } });
            if (!product) {
                throw new Error(locationId ? `Invalid, unavailable, or out-of-location product: ${item.productId}` : `Invalid or unavailable product: ${item.productId}`);
            }
            const price = Number(product.priceUsdc);
            if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid catalog price for product: ${product.name}`);
            subtotal += price * item.quantity;
            priced.push({ ...item, name: product.name, unitPrice: price, trackedStockQty: product.stockQty });
        }
        return { subtotal, items: priced };
    }

    async _consumeInventory(tx, businessProfileId, items) {
        for (const item of items) {
            if (item.trackedStockQty != null) {
                const result = await tx.businessProduct.updateMany({ where: { id: item.productId, businessProfileId, isActive: true, isAvailable: true, stockQty: { gte: item.quantity } }, data: { stockQty: { decrement: item.quantity } } });
                if (result.count !== 1) throw new Error(`Insufficient stock for product: ${item.name}`);
            }
        }
        const recipes = await tx.recipeIngredient.findMany({ where: { productId: { in: items.map((item) => item.productId) } }, select: { productId: true, inventoryItemId: true, quantityRequired: true } });
        if (recipes.length === 0) return;
        const quantityByProduct = new Map();
        for (const item of items) quantityByProduct.set(item.productId, (quantityByProduct.get(item.productId) || 0) + item.quantity);
        const requiredByInventory = new Map();
        for (const recipe of recipes) {
            const productQty = quantityByProduct.get(recipe.productId) || 0;
            const required = Number(recipe.quantityRequired) * productQty;
            if (!Number.isFinite(required) || required < 0) throw new Error(`Invalid recipe quantity for product: ${recipe.productId}`);
            requiredByInventory.set(recipe.inventoryItemId, (requiredByInventory.get(recipe.inventoryItemId) || 0) + required);
        }
        for (const [inventoryItemId, required] of requiredByInventory.entries()) {
            if (required === 0) continue;
            const result = await tx.inventoryItem.updateMany({ where: { id: inventoryItemId, businessProfileId, isActive: true, currentStock: { gte: required } }, data: { currentStock: { decrement: required } } });
            if (result.count !== 1) throw new Error(`Insufficient ingredient stock: ${inventoryItemId}`);
        }
    }
}

module.exports = { PosOrderService };
