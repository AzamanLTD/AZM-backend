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
        'SELECT "id", "businessProfileId", "locationId", "customerId", "status" FROM "DineInTab" WHERE "id" = $1 FOR UPDATE',
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

const addItem = async (prisma, { tabId, productId, name, price, quantity, addedBy, io }) => {
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) throw new Error('price must be positive.');

    return prisma.$transaction(async (tx) => {
        const tab = await lockOpenTab(tx, tabId);
        let itemName = name;
        let authoritativePrice = priceNum;

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
