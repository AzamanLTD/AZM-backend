jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn() }));
jest.mock('../src/services/transactionQuoteService', () => ({
  createTransactionQuote: jest.fn(({ id, userId, purpose, amountGhs, rateGhsPerUsdc, rateSource, rateAsOf, ttlSeconds }) => ({
    id,
    userId,
    purpose,
    amountGhs,
    feeGhs: 0,
    rateGhsPerUsdc,
    rateSource,
    rateAsOf,
    ttlSeconds,
    usdcAmount: Number((amountGhs / rateGhsPerUsdc).toFixed(8)),
    expiresAt: '2026-09-04T12:00:00.000Z',
  })),
  persistTransactionQuote: jest.fn().mockResolvedValue(undefined),
  consumeTransactionQuote: jest.fn(),
  // 271C: the mounted Moolre initiation must source its rate through the
  // canonical fail-closed freshness gate, never a direct GlobalSettings read.
  getFreshServerRateGhsPerUsdc: jest.fn().mockResolvedValue({
    rateGhsPerUsdc: 13.42,
    rateSource: 'KOTANI_PAY',
    rateAsOf: new Date('2026-09-04T11:30:00.000Z'),
    externalAgeSeconds: 60,
    maxAgeSeconds: 1800,
  }),
  RateUnavailableError: class RateUnavailableError extends Error {
    constructor(message, code) { super(message); this.name = 'RateUnavailableError'; this.code = code; this.statusCode = 503; }
  },
}));

const { initiate } = require('../controllers/moolreQuoteDepositController');
const { createTransactionQuote, getFreshServerRateGhsPerUsdc } = require('../src/services/transactionQuoteService');

describe('moolreQuoteDeposit canonical retail FX contract', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses liveRetailRate before the legacy headline rate and records the canonical rail metadata', async () => {
    const transaction = { id: 'tx-1', txHash: 'MOOLRE-1' };
    const tx = {
      transactionHistory: {
        create: jest.fn().mockResolvedValue(transaction),
      },
    };
    const prisma = {
      // 271C: no direct GlobalSettings rate read is permitted on the mounted
      // initiation path anymore — the controller must delegate to the gate.
      globalSettings: { findUnique: jest.fn() },
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

    await initiate(req, res);

    // The rate snapshot came from the canonical 271C gate, not a direct read.
    expect(getFreshServerRateGhsPerUsdc).toHaveBeenCalledWith(expect.objectContaining({ prisma }));
    expect(prisma.globalSettings.findUnique).not.toHaveBeenCalled();
    expect(createTransactionQuote).toHaveBeenCalledWith(expect.objectContaining({
      amountGhs: 134.2,
      rateGhsPerUsdc: 13.42,
      rateSource: 'KOTANI_PAY',
      rateAsOf: new Date('2026-09-04T11:30:00.000Z'),
    }));
    expect(tx.transactionHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          rateAtInitiation: 13.42,
          rateSource: 'KOTANI_PAY',
          ratePair: 'USDC/GHS',
          settlementCurrency: 'USDC',
          displayCurrency: 'GHS',
        }),
      }),
    });
    expect(moolre.initiatePayment).toHaveBeenCalledWith({
      externalRef: 'MOOLRE-1',
      amountGhs: 134.2,
      payerPhone: '0241234567',
      network: 'MTN',
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
