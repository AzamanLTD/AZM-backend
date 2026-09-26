'use strict';

const assert = require('node:assert/strict');
const {
    addItem,
    addCustomerItem,
    removeItem,
} = require('../services/dineInTabMutationService');

function prismaForTab(tab, product = null, item = null) {
    const calls = [];
    const tx = {
        $queryRawUnsafe: async (...args) => {
            calls.push(['lock', ...args]);
            return tab ? [tab] : [];
        },
        businessProduct: {
            findFirst: async () => product,
        },
        dineInTabItem: {
            create: async ({ data }) => {
                calls.push(['create', data]);
                return { id: 'created-item', ...data };
            },
            findUnique: async () => item,
            delete: async () => {
                calls.push(['delete', item?.id]);
                return item;
            },
        },
    };
    return {
        calls,
        $transaction: async (callback) => callback(tx),
    };
}

describe('dine-in tab mutation integrity', () => {
    test('item add takes a row lock before checking OPEN and writing', async () => {
        const prisma = prismaForTab({
            id: 'tab-1', businessProfileId: 'biz-1', locationId: null, customerId: 7, status: 'OPEN',
        });
        const item = await addItem(prisma, {
            tabId: 'tab-1', name: 'Water', price: 1.5, quantity: 2, addedBy: 7,
        });
        assert.equal(item.quantity, 2);
        assert.equal(prisma.calls[0][0], 'lock');
        assert.equal(prisma.calls[1][0], 'create');
    });

    test('item add is rejected after the row lock observes FINALIZED', async () => {
        const prisma = prismaForTab({
            id: 'tab-1', businessProfileId: 'biz-1', locationId: null, customerId: 7, status: 'FINALIZED',
        });
        await assert.rejects(
            addItem(prisma, {
                tabId: 'tab-1', name: 'Water', price: 1.5, quantity: 1, addedBy: 7,
            }),
            /not OPEN/,
        );
        assert.equal(prisma.calls.filter(([kind]) => kind === 'create').length, 0);
    });

    test('customer item mutation cannot bypass customer ownership after locking the row', async () => {
        const prisma = prismaForTab({
            id: 'tab-1', businessProfileId: 'biz-1', locationId: null, customerId: 7, status: 'OPEN',
        }, {
            id: 'product-1', businessProfileId: 'biz-1', locationId: null,
            isActive: true, isAvailable: true, name: 'Rice', priceUsdc: 4,
            variants: [], modifierGroups: [],
        });
        await assert.rejects(
            addCustomerItem(prisma, {
                tabId: 'tab-1', customerId: 8, productId: 'product-1', selection: {}, quantity: 1,
            }),
            /Not authorized/,
        );
        assert.equal(prisma.calls.filter(([kind]) => kind === 'create').length, 0);
    });

    test('remove also locks the parent tab before deleting a line', async () => {
        const item = { id: 'item-1', dineInTabId: 'tab-1' };
        const prisma = prismaForTab({
            id: 'tab-1', businessProfileId: 'biz-1', locationId: null, customerId: 7, status: 'OPEN',
        }, null, item);
        const result = await removeItem(prisma, { tabId: 'tab-1', itemId: 'item-1' });
        assert.equal(result.success, true);
        assert.equal(prisma.calls[0][0], 'lock');
        assert.deepEqual(prisma.calls[1], ['delete', 'item-1']);
    });
});
