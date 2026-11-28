'use strict';

const {
    validateConfiguredProduct,
    configuredUnitPrice,
    normalizedSelection,
} = require('./storefrontProductConfigurationService');

const selectionLabel = (selection) => {
    const entries = Object.entries(selection || {});
    if (!entries.length) return '';
    return entries
        .map(([group, value]) => `${group}: ${(Array.isArray(value) ? value : [value]).join(', ')}`)
        .join(' · ');
};

const lockOpenTab = async (tx, tabId) => {
    const rows = await tx.$queryRawUnsafe(
        'SELECT "id", "businessProfileId", "locationId", "customerId", "status", "currency" FROM "DineInTab" WHERE "id" = $1 FOR UPDATE',
        tabId,
    );
    const tab = rows[0];
    if (!tab) throw new Error('Tab not found.');
    if (tab.status !== 'OPEN') throw new Error('Cannot mutate a tab that is not OPEN.');
    return tab;
};

const productWhereForTab = (tab, productId) => {
    const where = {
        id: productId,
        businessProfileId: tab.businessProfileId,
        isActive: true,
        isAvailable: true,
    };
    if (tab.locationId) where.OR = [{ locationId: null }, { locationId: tab.locationId }];
    else where.locationId = null;
    return where;
};


// ── Native-GHS lines ─────────────────────────────────────────────────────────
// A GHS tab's money lives in the cedi line columns (ck_dineintabitem_ghs_complete
// requires both). Its price comes ONLY from the merchant's confirmed GHS
// BusinessPrice for a product, or an exact 2dp cedi amount for a custom line —
// never a converted USDC price. The USDC line columns are NOT NULL in the
// schema; on a GHS line they carry 0 (the tab-level currency-shape constraint
// already forbids USDC money on a GHS tab, and every GHS reader uses the cedi
// columns).
const priceService = require('./businessPriceService');

const ghsFail = (code, message) => Object.assign(new Error(message), { code });

async function confirmedGhsPesewas(tx, productId) {
    const resolved = await priceService.resolveEffectiveGhsPrices(tx, [productId]);
    const row = resolved.get(productId);
    if (!row) {
        throw ghsFail('GHS_PRICE_UNAVAILABLE', 'This item has no confirmed GHS price. Set one before adding it to a cedi tab.');
    }
    return priceService.toPesewas(row.amountExact);
}

function customGhsPesewas(priceGhs) {
    if (typeof priceGhs !== 'string' || !/^\d+(\.\d{1,2})?$/.test(priceGhs.trim())) {
        throw ghsFail('INVALID_INPUT', 'priceGhs must be an exact GHS amount with at most 2 decimals, sent as a string.');
    }
    const pesewas = priceService.toPesewas(priceGhs.trim());
    if (pesewas <= 0n) throw ghsFail('INVALID_INPUT', 'priceGhs must be positive.');
    return pesewas;
}

function ghsLineData(unitPesewas, quantity) {
    return {
        unitPriceGhs: priceService.pesewasToGhsString(unitPesewas),
        lineTotalGhs: priceService.pesewasToGhsString(unitPesewas * BigInt(quantity)),
        unitPriceUsdc: 0,
        lineTotalUsdc: 0,
    };
}

const addItem = async (prisma, { tabId, businessProfileId, productId, name, price, priceGhs, quantity, addedBy, io }) => {
    return prisma.$transaction(async (tx) => {
        const tab = await lockOpenTab(tx, tabId);
        // r32 item F: a business-side mutation may only touch a tab of the
        // caller's effective business. Refusal is indistinguishable from an
        // unknown tab id (no state leak).
        if (businessProfileId && tab.businessProfileId !== businessProfileId) {
            throw new Error('Tab not found.');
        }
        if (tab.currency === 'GHS') {
            let itemName = name;
            let unitPesewas;
            if (productId) {
                const product = await tx.businessProduct.findFirst({
                    where: productWhereForTab(tab, productId),
                    select: { id: true, name: true },
                });
                if (!product) throw new Error('Product is unavailable for this restaurant/location.');
                itemName = product.name;
                unitPesewas = await confirmedGhsPesewas(tx, product.id);
            } else {
                unitPesewas = customGhsPesewas(priceGhs);
            }
            if (!itemName) throw new Error('name is required.');
            const item = await tx.dineInTabItem.create({
                data: {
                    dineInTabId: tabId,
                    productId: productId || null,
                    name: String(itemName).slice(0, 200),
                    quantity,
                    ...ghsLineData(unitPesewas, quantity),
                    addedBy: addedBy || tab.customerId,
                },
            });
            io?.to(`user_${tab.customerId}`).emit('dine_in_item_added', { tabId, item });
            return item;
        }
        let itemName = name;
        let authoritativePrice = productId ? null : Number(price);

        if (productId) {
            const product = await tx.businessProduct.findFirst({
                where: productWhereForTab(tab, productId),
                select: { id: true, name: true, priceUsdc: true },
            });
            if (!product) throw new Error('Product is unavailable for this restaurant/location.');
            authoritativePrice = Number(product.priceUsdc);
            itemName = product.name;
        }
        if (!itemName) throw new Error('name is required.');
        if (!Number.isFinite(authoritativePrice) || authoritativePrice <= 0) throw new Error('price must be positive.');

        const item = await tx.dineInTabItem.create({
            data: {
                dineInTabId: tabId,
                productId: productId || null,
                name: String(itemName).slice(0, 200),
                unitPriceUsdc: authoritativePrice,
                quantity,
                lineTotalUsdc: authoritativePrice * quantity,
                addedBy: addedBy || tab.customerId,
            },
        });

        io?.to(`user_${tab.customerId}`).emit('dine_in_item_added', { tabId, item });
        return item;
    });
};

const addCustomerItem = async (prisma, { tabId, customerId, productId, selection, quantity, io }) => {
    return prisma.$transaction(async (tx) => {
        const tab = await lockOpenTab(tx, tabId);
        if (tab.customerId !== customerId) throw new Error('Not authorized to add items to this tab.');

        const product = await tx.businessProduct.findFirst({
            where: productWhereForTab(tab, productId),
            select: { id: true, name: true, priceUsdc: true, variants: true, modifierGroups: true },
        });
        if (!product) throw new Error('Product is unavailable for this restaurant/location.');

        const validation = validateConfiguredProduct(product, selection);
        if (validation.error) throw new Error(validation.error);
        const normalized = normalizedSelection(product, selection);
        const unitPrice = configuredUnitPrice(product, normalized);
        if (!(unitPrice > 0)) throw new Error('Product price must be positive.');
        const label = selectionLabel(normalized);
        if (tab.currency === 'GHS') {
            // Options are priced in USDC deltas today; a GHS delta has no
            // sanctioned write path yet. A selection that changes the price
            // is refused on a cedi tab rather than converted or ignored.
            if (unitPrice !== Number(product.priceUsdc)) {
                throw ghsFail('GHS_OPTION_PRICE_UNAVAILABLE', 'These options change the price and are not yet priced in GHS.');
            }
            const unitPesewas = await confirmedGhsPesewas(tx, product.id);
            const item = await tx.dineInTabItem.create({
                data: {
                    dineInTabId: tabId,
                    productId: product.id,
                    name: String(label ? `${product.name} — ${label}` : product.name).slice(0, 200),
                    quantity,
                    ...ghsLineData(unitPesewas, quantity),
                    addedBy: customerId,
                },
            });
            io?.to(`user_${tab.customerId}`).emit('dine_in_item_added', { tabId, item });
            return item;
        }

        const item = await tx.dineInTabItem.create({
            data: {
                dineInTabId: tabId,
                productId: product.id,
                name: String(label ? `${product.name} — ${label}` : product.name).slice(0, 200),
                unitPriceUsdc: unitPrice,
                quantity,
                lineTotalUsdc: unitPrice * quantity,
                addedBy: customerId,
            },
        });

        io?.to(`user_${tab.customerId}`).emit('dine_in_item_added', { tabId, item });
        return item;
    });
};

const removeItem = async (prisma, { tabId, itemId }) => {
    return prisma.$transaction(async (tx) => {
        const tab = await lockOpenTab(tx, tabId);
        const item = await tx.dineInTabItem.findUnique({ where: { id: itemId } });
        if (!item || item.dineInTabId !== tab.id) throw new Error('Item not found on this tab.');
        await tx.dineInTabItem.delete({ where: { id: itemId } });
        return { success: true };
    });
};

module.exports = {
    addItem,
    addCustomerItem,
    removeItem,
};
