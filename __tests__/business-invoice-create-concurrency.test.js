'use strict';

const boundary = require('../services/businessInvoiceCreationBoundary');
const invoiceService = require('../services/businessInvoiceService');

jest.mock('../services/businessInvoiceService', () => ({
  createInvoice: jest.fn(),
}));

describe('business invoice creation concurrency', () => {
  test('concurrent callers with one unique-key winner converge on one invoice', async () => {
    const invoice = {
      id: 'inv-1',
      businessProfileId: 'biz-1',
      customerId: 7,
      locationId: 'loc-1',
      tableId: 'table-1',
      businessNote: 'Lunch',
      lineItems: [{ description: 'Meal', quantity: 2, unitPrice: 20 }],
      taxLines: [],
    };

    let initialReads = 0;
    let releaseReads;
    const readsReleased = new Promise((resolve) => { releaseReads = resolve; });

    const findUnique = jest.fn(async () => {
      initialReads += 1;
      if (initialReads === 2) releaseReads();
      if (initialReads <= 2) {
        await readsReleased;
        return null;
      }
      return invoice;
    });

    const prisma = { businessInvoice: { findUnique } };

    let creationCalls = 0;
    invoiceService.createInvoice.mockImplementation(async () => {
      creationCalls += 1;
      if (creationCalls === 1) return invoice;
      throw { code: 'P2002', meta: { target: ['idempotencyKey'] } };
    });

    const args = {
      businessProfileId: 'biz-1',
      customerId: 7,
      locationId: 'loc-1',
      tableId: 'table-1',
      lineItems: [{ description: 'Meal', quantity: 2, unitPrice: 20 }],
      taxLines: [],
      businessNote: 'Lunch',
      idempotencyKey: 'invoice-create-concurrent-1',
    };

    const results = await Promise.all([
      boundary.createInvoice(prisma, args),
      boundary.createInvoice(prisma, args),
    ]);

    expect(results).toEqual([
      { invoice, replayed: expect.any(Boolean) },
      { invoice, replayed: expect.any(Boolean) },
    ]);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(creationCalls).toBe(2);
    expect(findUnique).toHaveBeenCalledTimes(3);
  });
});
