'use strict';

// Real-PostgreSQL proof for the wallet race that per-invoice idempotency cannot
// cover: the same customer attempts two DIFFERENT invoice payments at once.
// With 150 USDC available and two 100 USDC invoices, exactly one payment may
// commit. The conditional User UPDATE is the concurrency boundary.

const describeOrSkip = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeOrSkip('business invoice wallet race (real PostgreSQL)', () => {
  const { PrismaClient } = require('@prisma/client');
  const { seedUser, seedBusiness } = require('./helpers/factories');
  const { payInvoice } = require('../services/businessInvoiceService');

  let prisma;
  let customer;
  let businessOne;
  let businessTwo;
  let invoiceOne;
  let invoiceTwo;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    prisma = new PrismaClient();

    customer = await seedUser(prisma, { availableBalance: 150 });
    businessOne = await seedBusiness(prisma, { owner: { availableBalance: 0 } });
    businessTwo = await seedBusiness(prisma, { owner: { availableBalance: 0 } });

    const makeInvoice = (businessProfileId, suffix) => prisma.businessInvoice.create({
      data: {
        businessProfileId,
        customerId: customer.id,
        invoiceRef: `RACE-${Date.now()}-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'SENT',
        subtotalUsdc: 100,
        taxTotalUsdc: 0,
        billTotalUsdc: 100,
        sentAt: new Date(),
      },
    });

    [invoiceOne, invoiceTwo] = await Promise.all([
      makeInvoice(businessOne.biz.id, 'A'),
      makeInvoice(businessTwo.biz.id, 'B'),
    ]);
  });

  afterAll(async () => {
    if (prisma) {
      // The battery shares one database and may run twice; remove everything
      // this suite created so the trailing adapter suites' cleanups (which
      // sweep by the same "Test Business " / "user_" prefixes) stay reliable.
      const userIds = [customer.id, businessOne.owner.id, businessTwo.owner.id];
      await prisma.businessInvoice.deleteMany({ where: { id: { in: [invoiceOne.id, invoiceTwo.id] } } });
      await prisma.businessProfile.deleteMany({ where: { id: { in: [businessOne.biz.id, businessTwo.biz.id] } } });
      await prisma.transactionHistory.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
  });

  test('two different invoices cannot overspend one customer wallet', async () => {
    const outcomes = await Promise.allSettled([
      payInvoice(prisma, { invoiceId: invoiceOne.id, customerId: customer.id }),
      payInvoice(prisma, { invoiceId: invoiceTwo.id, customerId: customer.id }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe('INSUFFICIENT_FUNDS');

    const [customerAfter, first, second] = await Promise.all([
      prisma.user.findUnique({ where: { id: customer.id } }),
      prisma.businessInvoice.findUnique({ where: { id: invoiceOne.id } }),
      prisma.businessInvoice.findUnique({ where: { id: invoiceTwo.id } }),
    ]);

    expect(Number(customerAfter.availableBalance)).toBeCloseTo(50, 6);
    expect([first.status, second.status].filter((status) => status === 'PAID')).toHaveLength(1);
    expect([first.status, second.status].filter((status) => status === 'SENT')).toHaveLength(1);

    const [firstHistory, secondHistory] = await Promise.all([
      prisma.transactionHistory.count({ where: { txHash: { startsWith: `INV_PAY_${invoiceOne.id}` } } }),
      prisma.transactionHistory.count({ where: { txHash: { startsWith: `INV_PAY_${invoiceTwo.id}` } } }),
    ]);
    expect(firstHistory + secondHistory).toBe(2);
  });
});
