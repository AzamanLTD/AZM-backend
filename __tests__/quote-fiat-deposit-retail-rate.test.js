jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn() }));
jest.mock('../src/services/transactionQuoteService', () => ({
  createTransactionQuote: jest.fn(({ id, userId, purpose, amountGhs, rateGhsPerUsdc, rateSource, rateAsOf, ttlSeconds }) => ({
    id, userId, purpose, amountGhs, feeGhs: 0, rateGhsPerUsdc, rateSource, rateAsOf, ttlSeconds,
    usdcAmount: Number((amountGhs / rateGhsPerUsdc).toFixed(8)),
    expiresAt: '2026-09-04T12:00:00.000Z',
  })),
  createServerTransactionQuote: jest.fn(),
  persistTransactionQuote: jest.fn().mockResolvedValue(undefined),
  consumeTransactionQuote: jest.fn(),
}));

const { initiateMoolre } = require('../controllers/quoteFiatDepositController');
const { createTransactionQuote } = require('../src/services/transactionQuoteService');

describe('quoteFiatDeposit Moolre retail FX contract', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses liveRetailRate before the legacy headline rate', async () => {
    const transaction = { id: 'tx-1', txHash: 'MOOLRE-1' };
    const tx = {
      transactionHistory: {
        create: jest.fn().mockResolvedValue(transaction),
      },
    };
    const prisma = {
      globalSettings: {
        findUnique: jest.fn().mockResolvedValue({
          liveRetailRate: 13.42,
          liveUsdToGhs: 13.10,
          liveRateSource: 'KOTANI_PAY',
          lastRateSync: '2026-09-04T11:30:00.000Z',
        }),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
      transactionHistory: {
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const moolre = {
      initiatePayment: jest.fn().mockResolvedValue({ requiresOtp: true, providerRef: 'provider-1' }),
    };
    const req = {
      app: {
        get(key) {
          if (key === 'prisma') return prisma;
          if (key === 'moolreCollectionService') return moolre;
          return null;
        },
      },
      user: { id: 7 },
      body: {
        amountGhs: 134.20,
        provider: 'MTN_MOMO',
        phoneNumber: '0241234567',
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await initiateMoolre(req, res);

    expect(createTransactionQuote).toHaveBeenCalledWith(expect.objectContaining({
      amountGhs: 134.2,
      rateGhsPerUsdc: 13.42,
      rateSource: 'KOTANI_PAY',
    }));
    expect(tx.transactionHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          rateAtInitiation: 13.42,
          ratePair: 'USDC/GHS',
          settlementCurrency: 'USDC',
          displayCurrency: 'GHS',
        }),
      }),
    }));
    expect(moolre.initiatePayment).toHaveBeenCalledWith(expect.objectContaining({
      amountGhs: 134.2,
      network: 'MTN',
    }));
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
