// __tests__/dine-in-ghs-items.test.js
// =============================================================================
// A cedi (GHS) dine-in tab prices its lines ONLY in cedis.
//
//   • a product line takes the merchant's confirmed GHS BusinessPrice, exact,
//     into unitPriceGhs / lineTotalGhs (both, as the DB constraint requires);
//   • a product with no confirmed GHS price is refused GHS_PRICE_UNAVAILABLE,
//     nothing written;
//   • a custom merchant line needs an exact 2dp priceGhs STRING;
//   • a customer selection whose options change the price is refused
//     (options are not priced in GHS yet) — never converted;
//   • a USDC/legacy tab is unchanged.
// =============================================================================
'use strict';

const { Prisma } = require('@prisma/client');
const priceService = require('../services/businessPriceService');
const { addItem, addCustomerItem } = require('../services/dineInTabMutationService');

function prismaFor({ currency, product, ghsPrice }) {
    const created = [];
    const tx = {
        $queryRawUnsafe: jest.fn(async () => [{ id: 'tab-1', businessProfileId: 'biz-1', locationId: null, customerId: 42, status: 'OPEN', currency }]),
        businessProduct: { findFirst: jest.fn(async () => product) },
        dineInTabItem: { create: jest.fn(async ({ data }) => { created.push(data); return { id: 'item-1', ...data }; }) },
    };
    jest.spyOn(priceService, 'resolveEffectiveGhsPrices').mockImplementation(async (_c, ids) => {
        const m = new Map();
        if (ghsPrice != null) m.set(ids[0], { amountExact: new Prisma.Decimal(ghsPrice) });
        return m;
    });
    return { prisma: { $transaction: async (fn) => fn(tx) }, created };
}

afterEach(() => jest.restoreAllMocks());

const product = { id: 'p1', name: 'Jollof', priceUsdc: new Prisma.Decimal('2.5'), variants: null, modifierGroups: null };

test('a GHS tab prices a product line from its confirmed GHS price, exactly', async () => {
    const { prisma, created } = prismaFor({ currency: 'GHS', product, ghsPrice: '35.50' });
    await addItem(prisma, { tabId: 'tab-1', businessProfileId: 'biz-1', productId: 'p1', quantity: 3, addedBy: 7 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ unitPriceGhs: '35.50', lineTotalGhs: '106.50', unitPriceUsdc: 0, lineTotalUsdc: 0, name: 'Jollof' });
});

test('a product with no confirmed GHS price is refused, nothing written', async () => {
    const { prisma, created } = prismaFor({ currency: 'GHS', product, ghsPrice: null });
    await expect(addItem(prisma, { tabId: 'tab-1', businessProfileId: 'biz-1', productId: 'p1', quantity: 1 }))
        .rejects.toMatchObject({ code: 'GHS_PRICE_UNAVAILABLE' });
    expect(created).toHaveLength(0);
});

test('a custom GHS line needs an exact 2dp string', async () => {
    const { prisma, created } = prismaFor({ currency: 'GHS', product: null, ghsPrice: null });
    for (const bad of [12.5, '12.555', '-1', '1e2', undefined]) {
        await expect(addItem(prisma, { tabId: 'tab-1', businessProfileId: 'biz-1', name: 'Water', priceGhs: bad, quantity: 1 }))
            .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await addItem(prisma, { tabId: 'tab-1', businessProfileId: 'biz-1', name: 'Water', priceGhs: '4.00', quantity: 2 });
    expect(created[0]).toMatchObject({ unitPriceGhs: '4.00', lineTotalGhs: '8.00' });
});

test('a customer selection that changes the price is refused on a GHS tab', async () => {
    const withOptions = {
        ...product,
        modifierGroups: [{ name: 'Add-ons', max: 2, options: [{ name: 'Chicken', priceDelta: 1.5 }] }],
    };
    const { prisma, created } = prismaFor({ currency: 'GHS', product: withOptions, ghsPrice: '35.50' });
    await expect(addCustomerItem(prisma, {
        tabId: 'tab-1', customerId: 42, productId: 'p1', selection: { 'Add-ons': ['Chicken'] }, quantity: 1,
    })).rejects.toMatchObject({ code: 'GHS_OPTION_PRICE_UNAVAILABLE' });
    expect(created).toHaveLength(0);
});

test('a customer line with no price-changing options takes the GHS price', async () => {
    const { prisma, created } = prismaFor({ currency: 'GHS', product, ghsPrice: '35.50' });
    await addCustomerItem(prisma, { tabId: 'tab-1', customerId: 42, productId: 'p1', selection: {}, quantity: 2 });
    expect(created[0]).toMatchObject({ unitPriceGhs: '35.50', lineTotalGhs: '71.00', unitPriceUsdc: 0 });
});

test('a legacy USDC tab is unchanged', async () => {
    const { prisma, created } = prismaFor({ currency: null, product, ghsPrice: '35.50' });
    await addItem(prisma, { tabId: 'tab-1', businessProfileId: 'biz-1', productId: 'p1', quantity: 2 });
    expect(created[0].unitPriceGhs).toBeUndefined();
    expect(created[0].unitPriceUsdc).toBe(2.5);
});
