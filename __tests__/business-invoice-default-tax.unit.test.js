'use strict';

const assert = require('node:assert/strict');
const { createInvoice } = require('../services/businessInvoiceService');

describe('business invoice default tax contract', () => {
  test('omitted taxLines use the business default preset', async () => {
    const prisma = {
      businessTaxPreset: { findFirst: async () => ({ name: 'VAT', type: 'PERCENTAGE', value: 12.5 }) },
      user: { findUnique: async () => ({ id: 7, username: 'customer' }) },
      businessInvoice: {
        findUnique: async () => null,
        create: async ({ data }) => ({ id: 'inv-1', ...data, lineItems: data.lineItems.create, taxLines: data.taxLines.create }),
      },
    };

    const invoice = await createInvoice(prisma, {
      businessProfileId: 'biz-1',
      customerId: 7,
      lineItems: [{ description: 'Meal', quantity: 2, unitPrice: 20 }],
      idempotencyKey: 'inv-default-1',
    });

    assert.equal(invoice.subtotalUsdc, 40);
    assert.equal(invoice.taxTotalUsdc, 5);
    assert.equal(invoice.billTotalUsdc, 45);
    assert.deepEqual(invoice.taxLines, [{ name: 'VAT', type: 'PERCENTAGE', value: 12.5, computedAmount: 5 }]);
  });

  test('explicit empty taxLines remain tax-free', async () => {
    let defaultLookups = 0;
    const prisma = {
      businessTaxPreset: { findFirst: async () => { defaultLookups += 1; return { name: 'VAT', type: 'PERCENTAGE', value: 12.5 }; } },
      user: { findUnique: async () => ({ id: 7, username: 'customer' }) },
      businessInvoice: {
        findUnique: async () => null,
        create: async ({ data }) => ({ id: 'inv-2', ...data, lineItems: data.lineItems.create, taxLines: data.taxLines.create }),
      },
    };

    const invoice = await createInvoice(prisma, {
      businessProfileId: 'biz-1',
      customerId: 7,
      lineItems: [{ description: 'Meal', quantity: 1, unitPrice: 20 }],
      taxLines: [],
      idempotencyKey: 'inv-explicit-tax-free-1',
    });

    assert.equal(invoice.taxTotalUsdc, 0);
    assert.equal(invoice.billTotalUsdc, 20);
    assert.deepEqual(invoice.taxLines, []);
    assert.equal(defaultLookups, 0);
  });
});
