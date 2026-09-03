'use strict';

const logger = require('../../src/config/logger');

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;
const isSerializableConflict = (error) => error?.code === 'P2034';
const waitForRetry = (attempt) => new Promise((resolve) => setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt)));

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
            if (!item.productId || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
                throw new Error('Each item requires a valid productId and integer quantity from 1 to 50.');
            }
        }

        const computed = await this._priceItems(businessProfileId, normalizedItems);
        const computedTax = computed.subtotal * 0.025;
        const computedGrand = computed.subtotal + computedTax;
        const cash = Number(cashGiven || 0);
        const requestedAzm = Number(azmAmount || 0);
        let azmPortion = 0;
        let cashChange = 0;
        if (pm === 'CASH') {
            if (cash < computedGrand) throw new Error('Insufficient cash received.');
            cashChange = cash - computedGrand;
        } else if (pm === 'AZM') {
            azmPortion = computedGrand;
        } else {
            azmPortion = requestedAzm;
            if (!Number.isFinite(azmPortion) || azmPortion <= 0 || azmPortion > computedGrand) throw new Error('Invalid AZM portion.');
            if (cash + azmPortion < computedGrand) throw new Error('Insufficient payment (cash + AZM).');
            cashChange = Math.max(0, cash - (computedGrand - azmPortion));
        }

        const existing = await this._findIdempotentOrder(businessProfileId, idempotencyKey);
        if (existing) return { order: existing, duplicate: true, computedSubtotal: computed.subtotal, computedTax, computedGrand, change: Number(existing.cashChange || 0) };

        const orderRef = `POS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        const effectiveCustomerId = pm === 'CASH' ? (customerId || actorId) : actorId;

        for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
            try {
                const result = await this.prisma.$transaction(async (tx) => {
                    if (idempotencyKey) {
                        const txExisting = await tx.businessOrder.findFirst({ where: { idempotencyKey } });
                        if (txExisting) {
                            if (txExisting.businessProfileId !== businessProfileId) throw new Error('Idempotency key already belongs to another business.');
                            return { order: txExisting, duplicate: true };
                        }
                    }

                    if (azmPortion > 0) {
                        const debit = await tx.user.updateMany({
                            where: { id: actorId, azmBalance: { gte: azmPortion } },
                            data: { azmBalance: { decrement: azmPortion } },
                        });
                        if (debit.count !== 1) throw new Error('Insufficient AZM balance.');
                        const userAfterDebit = await tx.user.findUnique({ where: { id: actorId }, select: { azmBalance: true } });
                        await tx.azmSpendLog.create({
                            data: {
                                userId: actorId,
                                amount: azmPortion,
                                reason: `POS order (${source || 'POS'})`,
                                source: 'POS_SALE',
                                balanceAfter: Number(userAfterDebit?.azmBalance || 0),
                                metadata: { orderRef, businessProfileId },
                            },
                        });
                    }

                    const order = await tx.businessOrder.create({
                        data: {
                            businessProfileId,
                            customerId: effectiveCustomerId,
                            status: 'COMPLETED',
                            orderRef,
                            title: `POS Sale (${pm})`,
                            amountUsdc: computedGrand,
                            paymentMethod: pm,
                            idempotencyKey,
                            cashReceived: cash || null,
                            cashChange: cashChange || null,
                            completedAt: new Date(),
                        },
                    });

                    await tx.businessLedgerEntry.create({
                        data: {
                            businessProfileId,
                            type: 'INCOME',
                            category: 'SALES',
                            description: `POS Sale (${orderRef} - ${pm})`,
                            amount: computedGrand,
                            amountGhs: computedGrand,
                            sourceType: 'POS_SALE',
                            sourceId: order.id,
                            metadata: { orderRef, paymentMethod: pm, items: normalizedItems.length, locationId, tableId, azmPortion },
                        },
                    });
                    return { order, duplicate: false };
                }, { isolationLevel: 'Serializable' });
                logger.info({ businessProfileId, actorId, orderId: result.order.id, duplicate: result.duplicate }, '[POS] order settled atomically');
                return { ...result, computedSubtotal: computed.subtotal, computedTax, computedGrand, change: result.duplicate ? Number(result.order.cashChange || 0) : cashChange };
            } catch (error) {
                if (error?.code === 'P2002' && idempotencyKey) {
                    const replay = await this._findIdempotentOrder(businessProfileId, idempotencyKey);
                    if (replay) return { order: replay, duplicate: true, computedSubtotal: computed.subtotal, computedTax, computedGrand, change: Number(replay.cashChange || 0) };
                }
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) throw error;
                await waitForRetry(attempt);
            }
        }
        throw new Error('Could not settle POS order after retries.');
    }

    async _findIdempotentOrder(businessProfileId, idempotencyKey) {
        if (!idempotencyKey) return null;
        const existing = await this.prisma.businessOrder.findFirst({ where: { idempotencyKey } });
        if (!existing) return null;
        if (existing.businessProfileId !== businessProfileId) throw new Error('Idempotency key already belongs to another business.');
        return existing;
    }

    async _priceItems(businessProfileId, items) {
        let subtotal = 0;
        const priced = [];
        for (const item of items) {
            const product = await this.prisma.businessProduct.findFirst({
                where: { id: item.productId, businessProfileId, isActive: true, isAvailable: true },
                select: { id: true, name: true, priceUsdc: true },
            });
            if (!product) throw new Error(`Invalid or unavailable product: ${item.productId}`);
            const price = Number(product.priceUsdc);
            if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid catalog price for product: ${product.name}`);
            subtotal += price * item.quantity;
            priced.push({ ...item, name: product.name, unitPrice: price });
        }
        return { subtotal, items: priced };
    }
}

module.exports = { PosOrderService };
