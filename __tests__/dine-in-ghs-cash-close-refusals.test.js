// __tests__/dine-in-ghs-cash-close-refusals.test.js
// =============================================================================
// A GHS cash close is only as true as its cedi prices.
//
// The close summed whichever line columns the CLIENT-chosen currency named. In
// GHS mode a line with no cedi price counted as zero, so the tab was marked
// PAID with a total equal to the tip. Now:
//   • a line with no exact GHS price refuses the close (GHS_PRICE_UNAVAILABLE),
//     nothing recorded;
//   • a requested currency that contradicts the tab's own currency refuses
//     (CURRENCY_MISMATCH);
//   • the currency is part of the replay fingerprint.
// =============================================================================
'use strict';

const { Prisma } = require('@prisma/client');
const { DineInCashCloseService } = require('../services/businessOS/dineInCashCloseService');

function prismaFor(tab) {
    const writes = [];
    const tx = new Proxy({
        dineInTab: {
            findUnique: jest.fn(async () => tab),
            findFirst: jest.fn(async () => null),
            updateMany: jest.fn(async () => { writes.push('dineInTab.updateMany'); return { count: 1 }; }),
            update: jest.fn(async () => { writes.push('dineInTab.update'); return tab; }),
        },
    }, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === 'then') return undefined;
            return new Proxy({}, { get: () => async () => { writes.push(String(prop)); return null; } });
        },
    });
    return { prisma: { $transaction: jest.fn(async (fn) => fn(tx)), dineInTab: tx.dineInTab }, writes };
}

const openTab = (over = {}) => ({
    id: 'tab-1', businessProfileId: 'biz-1', status: 'OPEN', currency: null,
    items: [{ id: 'i1', quantity: 2, unitPriceUsdc: new Prisma.Decimal('3.5'), lineTotalUsdc: new Prisma.Decimal('7'), unitPriceGhs: null, lineTotalGhs: null }],
    ...over,
});

test('a GHS close of a line with no cedi price is refused, nothing recorded', async () => {
    const { prisma, writes } = prismaFor(openTab());
    await expect(new DineInCashCloseService(prisma).closeTab({
        businessProfileId: 'biz-1', actorId: 9, tabId: 'tab-1', currency: 'GHS', tipAmount: '5',
    })).rejects.toMatchObject({ code: 'GHS_PRICE_UNAVAILABLE' });
    expect(writes).toEqual([]);
});

test('a requested currency that contradicts the tab is refused', async () => {
    const { prisma, writes } = prismaFor(openTab({ currency: 'USDC' }));
    await expect(new DineInCashCloseService(prisma).closeTab({
        businessProfileId: 'biz-1', actorId: 9, tabId: 'tab-1', currency: 'GHS',
    })).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    expect(writes).toEqual([]);
});

test('the requested currency changes the replay fingerprint', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/businessOS/dineInCashCloseService.js'), 'utf8');
    expect(src).toMatch(/fingerprintOf\(\{ businessProfileId, actorId, tabId, tip, cash, currency: requestedCurrency \}\)/);
});
