const prismaMock = {};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => prismaMock),
}));

const { convertCurrency } = require('../controllers/multiCurrencyController');

describe('multi-currency conversion atomicity', () => {
  function setup({ debitCount = 1 } = {}) {
    const tx = {
      currencyWallet: {
        updateMany: jest.fn().mockResolvedValue({ count: debitCount }),
        upsert: jest.fn().mockResolvedValue({ id: 'dest', userId: 7, currency: 'GHS', balance: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      currencyConversion: {
        create: jest.fn().mockResolvedValue({ id: 'conv' }),
      },
    };

    prismaMock.fxRate = {
      findUnique: jest.fn().mockResolvedValue({ rate: 15 }),
    };
    prismaMock.currencyWallet = {
      findUnique: jest.fn().mockResolvedValue({ id: 'source', userId: 7, currency: 'USD', balance: 100 }),
    };
    prismaMock.$transaction = jest.fn(async (callback) => callback(tx));

    const req = {
      user: { id: 7 },
      body: { fromCurrency: 'USD', toCurrency: 'GHS', amount: '10' },
      app: {
        get: jest.fn((key) => (key === 'prisma' ? prismaMock : key === 'io' ? null : null)),
      },
    };
    const res = {
      status: jest.fn(() => res),
      json: jest.fn(() => res),
    };
    return { req, res, tx };
  }

  test('debits the source wallet conditionally and upserts the destination wallet', async () => {
    const { req, res, tx } = setup();

    await convertCurrency(req, res);

    expect(tx.currencyWallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'source', balance: { gte: 10 } },
      data: { balance: { decrement: 10 } },
    });
    expect(tx.currencyWallet.upsert).toHaveBeenCalledWith({
      where: { userId_currency: { userId: 7, currency: 'GHS' } },
      update: {},
      create: { userId: 7, currency: 'GHS', balance: 0 },
    });
    expect(tx.currencyConversion.create).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('does not credit destination or write a conversion when source debit loses the race', async () => {
    const { req, res, tx } = setup({ debitCount: 0 });

    await convertCurrency(req, res);

    expect(tx.currencyWallet.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.currencyWallet.upsert).not.toHaveBeenCalled();
    expect(tx.currencyConversion.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      message: 'Insufficient balance. Your wallet changed; please retry.',
    }));
  });
});
