'use strict';

const boundary = require('../services/businessInvoiceCreationBoundary');
const invoiceService = require('../services/businessInvoiceService');

jest.mock('../services/businessInvoiceService', () => ({
  createInvoice: jest.fn(),
}));

describe('business invoice creation idempotency boundary', () => {
  const args = {
    businessProfileId: 'biz-1',
    customerId: 7,
    locationId: 'loc-1',
    tableId: 'table-1',
    lineItems: [{ description: 'Meal', quantity: 2, unitPrice: 20 }],
    taxLines: [],
    businessNote: 'Lunch',
    idempotencyKey: 'invoice-create-1',
  };

  beforeEach(() => jest.clearAllMocks());

  test('normalizes and passes a new idempotency key to the canonical service', async () => {
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
    const prisma = { businessInvoice: { findUnique: jest.fn().mockResolvedValue(null) } };
    invoiceService.createInvoice.mockResolvedValue(invoice);

    const result = await boundary.createInvoice(prisma, { ...args, idempotencyKey: '  invoice-create-1  ' });

    expect(result).toEqual({ invoice, replayed: false });
    expect(invoiceService.createInvoice).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ idempotencyKey: 'invoice-create-1' }),
    );
  });

  test('replays a committed invoice without invoking creation again', async () => {
    const invoice = {
      id: 'inv-existing',
      businessProfileId: 'biz-1',
      customerId: 7,
      locationId: 'loc-1',
      tableId: 'table-1',
      businessNote: 'Lunch',
      lineItems: [{ description: 'Meal', quantity: 2, unitPrice: 20 }],
      taxLines: [],
    };
    const prisma = { businessInvoice: { findUnique: jest.fn().mockResolvedValue(invoice) } };

    const result = await boundary.createInvoice(prisma, args);

    expect(result).toEqual({ invoice, replayed: true });
    expect(invoiceService.createInvoice).not.toHaveBeenCalled();
  });

  test('rejects reuse of a key for a materially different request', async () => {
    const invoice = {
      id: 'inv-existing',
      businessProfileId: 'biz-1',
      customerId: 7,
      locationId: 'loc-1',
      tableId: 'table-1',
      businessNote: 'Lunch',
      lineItems: [{ description: 'Meal', quantity: 2, unitPrice: 20 }],
      taxLines: [],
    };
    const prisma = { businessInvoice: { findUnique: jest.fn().mockResolvedValue(invoice) } };

    await expect(boundary.createInvoice(prisma, {
      ...args,
      lineItems: [{ description: 'Meal', quantity: 3, unitPrice: 20 }],
    })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_INTENT_MISMATCH',
      status: 409,
    });
  });

  test('recovers from a concurrent unique-key race with an exact replay', async () => {
    const invoice = {
      id: 'inv-race-winner',
      businessProfileId: 'biz-1',
      customerId: 7,
      locationId: 'loc-1',
      tableId: 'table-1',
      businessNote: 'Lunch',
      lineItems: [{ description: 'Meal', quantity: 2, unitPrice: 20 }],
      taxLines: [],
    };
    const findUnique = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(invoice);
    const prisma = { businessInvoice: { findUnique } };
    invoiceService.createInvoice.mockRejectedValueOnce({
      code: 'P2002',
      meta: { target: ['idempotencyKey'] },
    });

    const result = await boundary.createInvoice(prisma, args);

    expect(result).toEqual({ invoice, replayed: true });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  test('rejects a blank explicit key instead of silently disabling deduplication', async () => {
    const prisma = { businessInvoice: { findUnique: jest.fn() } };

    await expect(boundary.createInvoice(prisma, { ...args, idempotencyKey: '   ' }))
      .rejects.toMatchObject({ status: 400 });
    expect(invoiceService.createInvoice).not.toHaveBeenCalled();
  });
});
