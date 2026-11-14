'use strict';

const crypto = require('crypto');
const logger = require('../../src/config/logger');
const { Prisma } = require('@prisma/client');
const ledger = require('../ledgerService');
const { computeTaxLinesExact, parseExactDecimal, toWire, toFixed8 } = require('../../utils/exactInvoiceMath');

// =============================================================================
// WP-POS-C0 — POS SETTLEMENT CONTAINMENT
//
// There is no truthful POS order-currency contract yet:
//   • BusinessOrder.amountUsdc is non-nullable and has no currency column, so a
//     GHS sale cannot be REPRESENTED — only a USDC-shaped number that the portal
//     then LABELS as GHS;
//   • the GHS price resolver cannot produce a GHS-denominated order total;
//   • AZM settlement spent the CASHIER's personal azmBalance for a CUSTOMER
//     sale, treating loyalty points as a settlement currency.
//
// Until those are fixed, every NEW POS order is refused regardless of payment
// method. This is a CODE gate on purpose, not a GlobalSettings row and not an
// environment flag: there is no runtime knob to flip, no secret to change and
// no production configuration involved. It is also deliberately TWO
// conditions — `enabled` alone cannot lift the refusal, because a contract with
// no currency still cannot represent a sale. Re-opening POS settlement requires
// a new order-currency contract, a schema change and a reviewed code change.
// =============================================================================
const POS_SETTLEMENT_CONTRACT = Object.freeze({
    enabled: false,
    orderCurrency: null,
});

const POS_SETTLEMENT_REFUSAL_CODE = 'POS_SETTLEMENT_NOT_ENABLED';
const POS_PAYMENT_METHOD_UNSUPPORTED_CODE = 'POS_PAYMENT_METHOD_UNSUPPORTED';
const POS_VALIDATION_CODE = 'POS_VALIDATION_ERROR';
const POS_INTERNAL_CODE = 'POS_INTERNAL_ERROR';

/** A typed, client-safe POS refusal. Carries the status the API must return. */
class PosOrderError extends Error {
    constructor(message, code, statusCode) {
        super(message);
        this.name = 'PosOrderError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

/** A request-shaped problem: the client sent something invalid. */
class PosOrderValidationError extends PosOrderError {
    constructor(message) {
        super(message, POS_VALIDATION_CODE, 400);
        this.name = 'PosOrderValidationError';
    }
}

/** POS settlement is unavailable. NOT a validation error, NOT a success. */
class PosSettlementNotEnabledError extends PosOrderError {
    constructor() {
        super(
            'POS settlement is not available: this deployment cannot yet record a POS sale in a '
            + 'truthful order currency. No order was created, no payment was taken and no stock was '
            + 'moved.',
            POS_SETTLEMENT_REFUSAL_CODE,
            422,
        );
        this.name = 'PosSettlementNotEnabledError';
    }
}

/** AZM is loyalty value, not a settlement currency, and stays unavailable. */
class PosPaymentMethodUnsupportedError extends PosOrderError {
    constructor(method) {
        super(
            `Payment method ${method} is not supported for POS settlement. AZM is loyalty value, `
            + 'not a settlement currency, and no AZM wallet, conversion or redemption exists for a '
            + 'POS sale.',
            POS_PAYMENT_METHOD_UNSUPPORTED_CODE,
            422,
        );
        this.name = 'PosPaymentMethodUnsupportedError';
        this.paymentMethod = method;
    }
}

const posValidation = (message) => new PosOrderValidationError(message);

/**
 * The single response contract for a POS order failure, shared by the canonical
 * router and the legacy delegation routes.
 *
 * Typed POS errors answer with their own status and stable code. Anything else
 * is an infrastructure/database failure and answers 500 — never 400, because a
 * broken database is not a client mistake — with no message, stack or secret
 * from the underlying error.
 */
function applyPosErrorResponse(res, err) {
    if (err instanceof PosOrderError) {
        const body = { success: false, code: err.code, message: err.message };
        if (err.code === POS_SETTLEMENT_REFUSAL_CODE) {
            body.settlement = { available: false, currency: null };
        }
        return res.status(err.statusCode).json(body);
    }
    logger.error({ err: err && err.message, code: err && err.code }, '[POS] unexpected order failure');
    return res.status(500).json({
        success: false,
        code: POS_INTERNAL_CODE,
        message: 'POS order could not be processed.',
    });
}

const isPosOrderError = (err) => err instanceof PosOrderError;

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;
const isSerializableConflict = (error) => error?.code === 'P2034';
const waitForRetry = (attempt) => new Promise((resolve) => setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt)));

// r39/P0 — STRICT EXACT-DECIMAL money parsing for every client-supplied POS
// monetary input. Same authority as the dine-in cash close: exponent
// strings, whitespace padding, NaN/Infinity, negatives and >8dp fractional
// floats are all rejected BEFORE they can reach economic arithmetic.
const parsePosMoney = (value, field) => {
    if (value === null || value === undefined || value === '') return new Prisma.Decimal(0);
    if (typeof value === 'string' && value !== value.trim()) {
        throw posValidation(`${field}: whitespace-padded values are rejected.`);
    }
    try {
        return parseExactDecimal(value, field);
    } catch (e) {
        throw posValidation(`${field} must be a finite non-negative exact decimal (<= 8 decimals, no exponent, no padding).`);
    }
};

function buildIdempotencyFingerprint({ businessProfileId, actorId, normalizedItems, paymentMethod, cash, requestedAzm, source, locationId, tableId, requestedCustomerId, tipAmount }) {
    // r39/P0 — money fields enter the fingerprint as their EXACT 8dp decimal
    // string forms, so one idempotency key can never be replayed against a
    // value that differs in the 7th/8th decimal (a lossy Number/float64 JSON
    // encoding would hide exactly that difference).
    const canonical = {
        businessProfileId: String(businessProfileId),
        actorId: Number(actorId),
        items: [...normalizedItems]
            .map(({ productId, quantity }) => ({ productId: String(productId), quantity: Number(quantity) }))
            .sort((a, b) => a.productId.localeCompare(b.productId) || a.quantity - b.quantity),
        paymentMethod,
        cash: toFixed8(cash),
        requestedAzm: toFixed8(requestedAzm),
        source: source ?? null,
        locationId: locationId ?? null,
        tableId: tableId ?? null,
        customerId: requestedCustomerId ?? null,
        tipAmount: toFixed8(tipAmount),
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

class PosOrderService {
    constructor(prisma) { this.prisma = prisma; }

    async createOrder(args) {
        const {
            businessProfileId, actorId, items, paymentMethod = 'CASH', cashGiven,
            azmAmount, idempotencyKey, source, locationId, tableId, customerId,
            tipAmount,
        } = args;
        if (!businessProfileId) throw posValidation('Business context required.');
        if (!actorId) throw posValidation('Authentication required.');
        if (!Array.isArray(items) || items.length === 0) throw posValidation('Items are required.');

        const pm = String(paymentMethod || 'CASH').toUpperCase();
        if (!['CASH', 'AZM', 'SPLIT'].includes(pm)) throw posValidation(`Invalid payment method: ${pm}`);
        const normalizedItems = items.map((item) => ({ productId: item.productId, quantity: Number(item.qty ?? item.quantity ?? 1) }));
        for (const item of normalizedItems) {
            if (!item.productId || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) throw posValidation('Each item requires a valid productId and integer quantity from 1 to 50.');
        }
        // r39/P0 — EXACT MONEY: cash/AZM/tip enter as Prisma.Decimal through
        // the strict parser and NEVER round-trip through JS float arithmetic.
        const cash = parsePosMoney(cashGiven || 0, 'cashGiven');
        const requestedAzm = parsePosMoney(azmAmount || 0, 'azmAmount');
        // r32/I: tips are accepted ONLY through this validated path — a
        // non-negative, bounded amount that joins the fingerprint so one
        // idempotency key can never be replayed with a different tip.
        // The exact-decimal strictness is r39/P0; the DOMAIN error message
        // is pinned client contract ('Invalid tip amount.') and unchanged.
        let tip;
        try {
            tip = parsePosMoney(tipAmount || 0, 'tipAmount');
            if (tip.gt(new Prisma.Decimal(10000))) throw posValidation('Invalid tip amount.');
        } catch (e) {
            throw posValidation('Invalid tip amount.');
        }

        const requestedCustomerId = customerId == null ? null : Number(customerId);
        if (requestedCustomerId != null && (!Number.isInteger(requestedCustomerId) || requestedCustomerId < 1)) throw posValidation('Invalid customerId.');
        const idempotencyFingerprint = idempotencyKey
            ? buildIdempotencyFingerprint({
                businessProfileId, actorId, normalizedItems, paymentMethod: pm,
                cash, requestedAzm, source, locationId, tableId, requestedCustomerId, tipAmount: tip,
            })
            : null;
        // (1) COMMITTED-ORDER REPLAY RUNS FIRST. A cashier or customer recovering
        // the result of an order that is already committed must never be told
        // "unavailable" — that is the one path that still works, and it is
        // decided purely on the durable order row.
        const existing = await this._findIdempotentOrder(businessProfileId, idempotencyKey, idempotencyFingerprint);
        if (existing) return { order: existing, duplicate: true, computedSubtotal: null, computedTax: null, computedGrand: toWire(existing.amountUsdc || 0), change: toWire(existing.cashChange || 0) };

        // (2) AZM/SPLIT are permanently unsupported, not merely gated: there is
        // no AZM settlement currency and no AZM wallet to pay from.
        if (pm !== 'CASH') throw new PosPaymentMethodUnsupportedError(pm);

        // (3) CONTAINMENT GATE — before inventory, balance, order, ledger or any
        // provider/payment side effect. See POS_SETTLEMENT_CONTRACT.
        const racedCommitted = await this._refuseNewSettlement({ businessProfileId, idempotencyKey, idempotencyFingerprint });
        if (racedCommitted) return { order: racedCommitted, duplicate: true, computedSubtotal: null, computedTax: null, computedGrand: toWire(racedCommitted.amountUsdc || 0), change: toWire(racedCommitted.cashChange || 0) };

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
                    const taxResult = await this._computeTax(tx, businessProfileId, computed.subtotal);
                    const computedTax = taxResult.taxTotal;
                    const computedGrand = computed.subtotal.plus(computedTax).plus(tip);

                    // r39/P0 — ALL comparisons/settlement arithmetic run on
                    // Prisma.Decimal. The 7th/8th-decimal boundaries below are
                    // exact: a cash value of grand - 1e-8 is insufficient,
                    // grand exactly is sufficient.
                    // WP-POS-C0 — AZM SETTLEMENT REMOVED, NOT GATED.
                    // The previous code replaced the order's calculated amount
                    // with an AZM portion and debited the CASHIER's personal
                    // azmBalance to pay for a CUSTOMER sale, treating loyalty
                    // points as a settlement currency. That is gone: no AZM
                    // wallet, conversion, customer debit or redemption replaced
                    // it. This assertion exists so a future edit that reaches
                    // here with a non-CASH method fails loudly instead of
                    // silently settling something the schema cannot represent.
                    if (pm !== 'CASH') throw new PosPaymentMethodUnsupportedError(pm);

                    let cashChange = new Prisma.Decimal(0);
                    if (cash.lt(computedGrand)) throw posValidation('Insufficient cash received.');
                    cashChange = cash.minus(computedGrand);

                    await this._consumeInventory(tx, businessProfileId, computed.items);

                    const effectiveCustomerId = pm === 'CASH' ? (requestedCustomerId || actorId) : actorId;
                    if (pm === 'CASH' && requestedCustomerId) {
                        const customer = await tx.user.findUnique({ where: { id: requestedCustomerId }, select: { id: true } });
                        if (!customer) throw posValidation('Customer not found.');
                    }
                    const order = await tx.businessOrder.create({ data: {
                        businessProfileId, customerId: effectiveCustomerId, status: 'COMPLETED', orderRef,
                        title: `POS Sale (${pm})`, amountUsdc: computedGrand, paymentMethod: pm, idempotencyKey,
                        cashReceived: cash.isZero() ? null : cash, cashChange: cashChange.isZero() ? null : cashChange, completedAt: new Date(),
                    } });
                    if (tx.businessOrderItem?.createMany) await tx.businessOrderItem.createMany({ data: computed.items.map((item) => ({ orderId: order.id, productId: item.productId, name: item.name, unitPrice: item.unitPrice, quantity: item.quantity, lineTotal: item.lineTotal })) });
                    await tx.businessLedgerEntry.create({ data: {
                        businessProfileId, type: 'INCOME', category: 'SALES', description: `POS Sale (${orderRef} - ${pm})`, amount: computedGrand,
                        sourceType: 'POS_SALE', sourceId: order.id,
                        metadata: {
                            orderRef, paymentMethod: pm, subtotal: toFixed8(computed.subtotal), tax: toFixed8(computedTax), tipAmount: toFixed8(tip),
                            taxLines: taxResult.taxLines.map((l) => ({ name: l.name, type: l.type, value: l.value.toString(), computedAmount: toFixed8(l.computedAmount) })),
                            items: normalizedItems.length, locationId, tableId,
                            ...(idempotencyFingerprint ? { posIdempotencyFingerprint: idempotencyFingerprint } : {}),
                        },
                    } });
                    return { order, duplicate: false, computedSubtotal: computed.subtotal, computedTax, computedGrand, change: cashChange };
                }, { isolationLevel: 'Serializable' });
                logger.info({ businessProfileId, actorId, orderId: result.order.id, duplicate: result.duplicate }, '[POS] order settled atomically');
                if (result.duplicate) return { ...result, computedSubtotal: null, computedTax: null, computedGrand: toWire(result.order.amountUsdc || 0), change: toWire(result.order.cashChange || 0) };
                // Wire serialization ONLY at the response boundary: the
                // internal authority stays Decimal end-to-end.
                return {
                    ...result,
                    computedSubtotal: toWire(result.computedSubtotal),
                    computedTax: toWire(result.computedTax),
                    computedGrand: toWire(result.computedGrand),
                    change: toWire(result.change),
                };
            } catch (error) {
                if (error?.code === 'P2002' && idempotencyKey) {
                    const replay = await this._findIdempotentOrder(businessProfileId, idempotencyKey, idempotencyFingerprint);
                    if (replay) return { order: replay, duplicate: true, computedSubtotal: null, computedTax: null, computedGrand: toWire(replay.amountUsdc || 0), change: toWire(replay.cashChange || 0) };
                }
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) throw error;
                await waitForRetry(attempt);
            }
        }
        throw posValidation('Could not settle POS order after retries.');
    }

    /**
     * WP-POS-C0 — decide whether a NEW POS settlement may be created.
     *
     * Returns a COMMITTED order only in the narrow race where another writer
     * committed the same idempotency identity between the replay lookup above
     * and this call, so that recovery still wins over containment. Otherwise it
     * throws the typed refusal and the caller has written nothing: no order, no
     * ledger entry, no stock movement, no balance change and no idempotency
     * claim — this service deduplicates on the durable order row, so a refused
     * attempt leaves nothing behind that could look committed or in progress.
     */
    async _refuseNewSettlement({ businessProfileId, idempotencyKey, idempotencyFingerprint }) {
        const contract = POS_SETTLEMENT_CONTRACT;
        if (contract.enabled === true && typeof contract.orderCurrency === 'string' && contract.orderCurrency.length > 0) {
            return null;
        }
        if (idempotencyKey) {
            const committedMeanwhile = await this._findIdempotentOrder(businessProfileId, idempotencyKey, idempotencyFingerprint);
            if (committedMeanwhile) return committedMeanwhile;
        }
        throw new PosSettlementNotEnabledError();
    }

    async _computeTax(tx, businessProfileId, subtotal) {
        // Real Prisma transactions always expose BusinessTaxPreset. Keep unit
        // and compatibility adapters that predate the model usable by treating
        // an absent model delegate as "no configured tax" rather than crashing.
        // r39/P0: the subtotal is a Prisma.Decimal and the computation runs
        // through the exact tax authority — no float path at all.
        const taxPreset = tx.businessTaxPreset;
        if (!taxPreset?.findFirst) return computeTaxLinesExact([], subtotal);
        const defaultPreset = await taxPreset.findFirst({
            where: { businessProfileId, isDefault: true },
            orderBy: { createdAt: 'asc' },
            select: { name: true, type: true, value: true },
        });
        return computeTaxLinesExact(defaultPreset ? [defaultPreset] : [], subtotal);
    }

    async _findIdempotentOrder(businessProfileId, idempotencyKey, fingerprint = null, client = this.prisma) {
        if (!idempotencyKey) return null;
        const existing = await client.businessOrder.findFirst({ where: { idempotencyKey } });
        if (!existing) return null;
        if (existing.businessProfileId !== businessProfileId) throw posValidation('Idempotency key already belongs to another business.');
        if (fingerprint && client.businessLedgerEntry?.findFirst) {
            const ledger = await client.businessLedgerEntry.findFirst({ where: { sourceType: 'POS_SALE', sourceId: existing.id }, select: { metadata: true } });
            const storedFingerprint = ledger?.metadata?.posIdempotencyFingerprint;
            if (storedFingerprint && storedFingerprint !== fingerprint) throw posValidation('Idempotency key already used for a different POS request.');
        }
        return existing;
    }

    async _validateOrderContext(tx, businessProfileId, locationId, tableId) {
        if (tableId && !locationId) throw posValidation('tableId requires locationId.');
        if (locationId) {
            const location = await tx.businessLocation.findFirst({ where: { id: locationId, businessProfileId, isActive: true }, select: { id: true } });
            if (!location) throw posValidation('Invalid or inactive business location.');
        }
        if (tableId) {
            const table = await tx.businessTable.findFirst({ where: { id: tableId, locationId, isActive: true }, select: { id: true } });
            if (!table) throw posValidation('Invalid or inactive business table for location.');
        }
    }

    async _priceItems(tx, businessProfileId, items, locationId) {
        // r39/P0 — catalog prices enter financial arithmetic AS DECIMAL and
        // the subtotal/line totals are exact decimal sums/products. No Number()
        // conversion, no float multiplication, no rounding.
        let subtotal = new Prisma.Decimal(0);
        const priced = [];
        for (const item of items) {
            const where = { id: item.productId, businessProfileId, isActive: true, isAvailable: true };
            if (locationId) where.OR = [{ locationId: null }, { locationId }];
            else where.locationId = null;
            const product = await tx.businessProduct.findFirst({ where, select: { id: true, name: true, priceUsdc: true, stockQty: true } });
            if (!product) {
                throw posValidation(locationId ? `Invalid, unavailable, or out-of-location product: ${item.productId}` : `Invalid or unavailable global product: ${item.productId}`);
            }
            const price = new Prisma.Decimal(product.priceUsdc);
            if (!price.isFinite() || !price.isPositive() || price.decimalPlaces() > 8) {
                throw posValidation(`Invalid catalog price for product: ${product.name}`);
            }
            // quantity is a validated integer — price × qty is exact at 8dp.
            const lineTotal = price.times(item.quantity);
            subtotal = subtotal.plus(lineTotal);
            priced.push({ ...item, name: product.name, unitPrice: price, lineTotal, trackedStockQty: product.stockQty });
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
            // r39/P0 — recipe deduction arithmetic runs on Prisma.Decimal:
            // the Float column's shortest round-trip string is parsed exactly
            // (0.1 stays 0.1, never 0.10000000000000001) and the per-product
            // requirement is an exact decimal product with an integer count.
            // The ONLY conversion to Number is at the Float currentStock
            // column mutation boundary — the schema itself stores float4, so
            // that boundary is deliberate and documented (classified in the
            // r39 audit: schema-limited, not authority).
            let recipeQty;
            try {
                recipeQty = new Prisma.Decimal(String(Number(recipe.quantityRequired)));
            } catch (e) {
                throw new Error(`Invalid recipe quantity for product: ${recipe.productId}`);
            }
            if (!recipeQty.isFinite() || recipeQty.isNegative()) throw new Error(`Invalid recipe quantity for product: ${recipe.productId}`);
            if (recipeQty.decimalPlaces() > 8) throw new Error(`Invalid recipe quantity for product: ${recipe.productId}`);
            const required = recipeQty.times(productQty);
            requiredByInventory.set(recipe.inventoryItemId, (requiredByInventory.get(recipe.inventoryItemId) || new Prisma.Decimal(0)).plus(required));
        }
        for (const [inventoryItemId, required] of requiredByInventory.entries()) {
            if (required.isZero()) continue;
            const result = await tx.inventoryItem.updateMany({ where: { id: inventoryItemId, businessProfileId, isActive: true, currentStock: { gte: Number(required.toFixed(8)) } }, data: { currentStock: { decrement: Number(required.toFixed(8)) } } });
            if (result.count !== 1) throw new Error(`Insufficient ingredient stock: ${inventoryItemId}`);
        }
    }
}

module.exports = {
    PosOrderService,
    POS_SETTLEMENT_CONTRACT,
    POS_SETTLEMENT_REFUSAL_CODE,
    POS_PAYMENT_METHOD_UNSUPPORTED_CODE,
    POS_VALIDATION_CODE,
    POS_INTERNAL_CODE,
    PosOrderError,
    PosOrderValidationError,
    PosSettlementNotEnabledError,
    PosPaymentMethodUnsupportedError,
    applyPosErrorResponse,
    isPosOrderError,
};
