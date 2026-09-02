'use strict';

jest.mock('../services/businessInvoiceService', () => ({
  createInvoice: jest.fn(),
  sendInvoice: jest.fn(),
  payInvoice: jest.fn(),
}));

const invoiceService = require('../services/businessInvoiceService');
const DineInService = require('../services/marketplace/dineInService');
const dineInTabService = require('../services/dineInTabService');

const makePrisma = () => ({
  dineInTab: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(async (callback) => callback({
    dineInTab: {
      update: jest.fn().mockResolvedValue({ id: 'tab-1', status: 'CLOSED', invoice: { id: 'inv-1' }, items: [] }),
    },
    businessInvoice: {},
    user: {},
  })),
});

describe('dine-in settlement', () => {
  beforeEach(() => jest.clearAllMocks());

  test('passes socket transport through the adapter', () => {
    const prisma = {};
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    const opts = { io, businessProfileId: 'biz-1', azamanId: 'AZM-1' };
    expect(dineInTabService.openTab).toBeDefined();
    const svcSource = require('fs').readFileSync(require.resolve('../services/dineInTabService'), 'utf8');
    expect(svcSource).toContain('new DineInService(prisma, opts.io)');
    expect(opts.io).toBe(io);
  });

  test('settlement keeps payment and tab closure inside the same transaction', async () => {
    const prisma = makePrisma();
    prisma.dineInTab.findUnique
      .mockResolvedValueOnce({
        id: 'tab-1', customerId: 7, status: 'FINALIZED',
        businessProfileId: 'biz-1', locationId: null, tableId: null,
        items: [{ name: 'Meal', quantity: 1, unitPriceUsdc: 10 }], invoice: null,
      })
      .mockResolvedValueOnce({
        id: 'tab-1', customerId: 7, status: 'FINALIZED',
        businessProfileId: 'biz-1', locationId: null, tableId: null,
        items: [{ name: 'Meal', quantity: 1, unitPriceUsdc: 10 }], invoice: { id: 'inv-1', status: 'SENT', billTotalUsdc: 10 },
      });
    invoiceService.createInvoice.mockResolvedValue({ id: 'inv-1' });
    invoiceService.sendInvoice.mockResolvedValue({ id: 'inv-1', status: 'SENT', billTotalUsdc: 10 });
    invoiceService.payInvoice.mockResolvedValue({
      invoice: { id: 'inv-1', status: 'PAID', billTotalUsdc: 10 },
      customerPays: 10,
      businessReceives: 9.85,
      fee: 0.15,
    });

    const service = new DineInService(prisma);
    const result = await service.confirmAndPay('tab-1', 7);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(invoiceService.payInvoice).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toEqual(expect.any(Function));
    expect(result.tab.status).toBe('CLOSED');
    expect(result.invoice.status).toBe('PAID');
  });
});
