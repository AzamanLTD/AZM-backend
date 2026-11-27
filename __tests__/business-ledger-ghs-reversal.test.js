// __tests__/business-ledger-ghs-reversal.test.js
// =============================================================================
// A ledger reversal is the exact negation IN THE ENTRY'S OWN CURRENCY.
//
// Native-GHS rows carry cedis in amountGhs with amount NULL
// (ck_businessledgerentry_currency_shape). The reversal used to read
// `new Prisma.Decimal(original.amount)`, which throws on NULL, so no GHS entry
// could be reversed; and it wrote only `amount`, which would also have broken
// the GHS shape check. USDC / legacy rows reverse exactly as before.
// =============================================================================
'use strict';

const { Prisma } = require('@prisma/client');
const mod = require('../services/businessOS/businessLedgerService');
const Service = mod.BusinessLedgerService || mod;

function serviceWith(original) {
    const created = [];
    const tx = {
        businessLedgerEntry: {
            findUnique: jest.fn(async () => original),
            create: jest.fn(async ({ data }) => { created.push(data); return { id: 'rev-1', ...data }; }),
        },
    };
    const prisma = { $transaction: jest.fn(async (fn) => fn(tx)) };
    return { svc: new Service(prisma), created };
}

const base = { businessProfileId: 'biz-1', type: 'INCOME', category: 'POS Sales', description: 'Cash close', sourceType: 'ORDER', sourceId: 'o1', reversalOfId: null, metadata: {} };

test('a GHS entry reverses in cedis, with amount NULL', async () => {
    const { svc, created } = serviceWith({ ...base, id: 'e1', currency: 'GHS', amount: null, amountGhs: new Prisma.Decimal('120.50') });
    await svc.createReversalEntry({ businessProfileId: 'biz-1', entryId: 'e1', reason: 'mistake' });
    expect(created).toHaveLength(1);
    expect(created[0].currency).toBe('GHS');
    expect(created[0].amount).toBeNull();
    expect(created[0].amountGhs.toFixed(2)).toBe('-120.50');
    expect(created[0].metadata).toMatchObject({ reversalOf: 'e1', reversedCurrency: 'GHS', reversedAmount: '120.50000000' });
});

test('a USDC / legacy entry reverses its amount exactly as before', async () => {
    const { svc, created } = serviceWith({ ...base, id: 'e2', currency: null, amount: new Prisma.Decimal('45.12345678'), amountGhs: null });
    await svc.createReversalEntry({ businessProfileId: 'biz-1', entryId: 'e2' });
    expect(created[0].amount.toFixed(8)).toBe('-45.12345678');
    expect(created[0].currency).toBeNull();
    expect(created[0].amountGhs).toBeUndefined();
});

test('a GHS entry with no cedi amount is refused, nothing written', async () => {
    const { svc, created } = serviceWith({ ...base, id: 'e3', currency: 'GHS', amount: null, amountGhs: null });
    await expect(svc.createReversalEntry({ businessProfileId: 'biz-1', entryId: 'e3' })).rejects.toMatchObject({ code: 'NOT_REVERSIBLE' });
    expect(created).toHaveLength(0);
});
