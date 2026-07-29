// controllers/multiCurrencyController.js
// =============================================================================
// AZAMAN V3 — Multi-Currency Wallets (Phase 5)
//
// Users can hold balances in multiple fiat currencies (GHS, NGN, KES, USD, EUR,
// GBP) alongside their USDC balance. Currency conversion uses platform FX
// rates with a 1.5% spread. Deposits/withdrawals route through the preferred
// currency wallet.
//
// Supported currencies: GHS, NGN, KES, USD, EUR, GBP, ZAR
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');

const SUPPORTED_CURRENCIES = ['GHS', 'NGN', 'KES', 'USD', 'EUR', 'GBP', 'ZAR'];
const FX_SPREAD = 0.015; // 1.5% spread on conversions
const MIN_CONVERSION = 1;

// ── Default FX rates (used if no FxRate record exists) ──────────────────────
// Rates are relative to USD
const BASE_RATES = {
  USD: 1,
  GHS: 15.5,
  NGN: 1580,
  KES: 129,
  EUR: 0.92,
  GBP: 0.79,
  ZAR: 18.5,
};

// ── Get wallet(s) ───────────────────────────────────────────────────────────
async function getWallets(req, res) {
  try {
    const wallets = await prisma.currencyWallet.findMany({
      where: { userId: req.user.id },
      orderBy: [{ isDefault: 'desc' }, { currency: 'asc' }],
    });

    return res.json({
      success: true,
      wallets,
      supportedCurrencies: SUPPORTED_CURRENCIES,
    });
  } catch (err) {
    logger.error({ err }, '[multiCurrency] getWallets error');
    return res.status(500).json({ success: false, message: 'Failed to load wallets.' });
  }
}

// ── Create / open a new currency wallet ────────────────────────────────────
async function createWallet(req, res) {
  try {
    const { currency } = req.body;
    const userId = req.user.id;

    if (!currency || !SUPPORTED_CURRENCIES.includes(currency.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Unsupported currency. Supported: ${SUPPORTED_CURRENCIES.join(', ')}`,
      });
    }

    const curr = currency.toUpperCase();

    // Check if wallet already exists
    const existing = await prisma.currencyWallet.findUnique({
      where: { userId_currency: { userId, currency: curr } },
    });

    if (existing) {
      return res.status(409).json({ success: false, message: 'Wallet already exists.' });
    }

    // Check if this is user's first wallet (make it default)
    const walletCount = await prisma.currencyWallet.count({ where: { userId } });

    const wallet = await prisma.currencyWallet.create({
      data: {
        userId,
        currency: curr,
        isDefault: walletCount === 0,
      },
    });

    return res.json({ success: true, wallet });
  } catch (err) {
    logger.error({ err }, '[multiCurrency] createWallet error');
    return res.status(500).json({ success: false, message: 'Failed to create wallet.' });
  }
}

// ── Set default wallet ──────────────────────────────────────────────────────
async function setDefaultWallet(req, res) {
  try {
    const { currency } = req.body;
    const userId = req.user.id;
    const curr = currency?.toUpperCase();

    const wallet = await prisma.currencyWallet.findUnique({
      where: { userId_currency: { userId, currency: curr } },
    });

    if (!wallet) {
      return res.status(404).json({ success: false, message: 'Wallet not found.' });
    }

    await prisma.$transaction([
      prisma.currencyWallet.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      }),
      prisma.currencyWallet.update({
        where: { id: wallet.id },
        data: { isDefault: true },
      }),
    ]);

    return res.json({ success: true, message: `${curr} set as default wallet.` });
  } catch (err) {
    logger.error({ err }, '[multiCurrency] setDefault error');
    return res.status(500).json({ success: false, message: 'Failed to set default.' });
  }
}

// ── Convert between currencies ────────────────────────────────────────────
async function convertCurrency(req, res) {
  try {
    const userId = req.user.id;
    const { fromCurrency, toCurrency, amount } = req.body;

    if (!fromCurrency || !toCurrency || !amount) {
      return res.status(400).json({ success: false, message: 'Missing parameters.' });
    }

    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();
    const amt = parseFloat(amount);

    if (!SUPPORTED_CURRENCIES.includes(from) || !SUPPORTED_CURRENCIES.includes(to)) {
      return res.status(400).json({ success: false, message: 'Unsupported currency pair.' });
    }

    if (amt < MIN_CONVERSION) {
      return res.status(400).json({ success: false, message: `Minimum conversion is ${MIN_CONVERSION}.` });
    }

    if (from === to) {
      return res.status(400).json({ success: false, message: 'Cannot convert to same currency.' });
    }

    // Get FX rate
    const rate = await getFxRate(from, to);
    if (!rate) {
      return res.status(503).json({ success: false, message: 'FX rate unavailable.' });
    }

    // Apply spread (user gets slightly less)
    const effectiveRate = rate * (1 - FX_SPREAD);
    const toAmount = amt * effectiveRate;

    // Check source wallet balance
    const sourceWallet = await prisma.currencyWallet.findUnique({
      where: { userId_currency: { userId, currency: from } },
    });

    if (!sourceWallet) {
      return res.status(404).json({ success: false, message: `${from} wallet not found.` });
    }

    const sourceBal = parseFloat(sourceWallet.balance.toString());
    if (sourceBal < amt) {
      return res.status(400).json({ success: false, message: 'Insufficient balance.' });
    }

    // Execute conversion
    const result = await prisma.$transaction(async (tx) => {
      // Debit source wallet
      await tx.currencyWallet.update({
        where: { id: sourceWallet.id },
        data: { balance: { decrement: amt } },
      });

      // Get or create destination wallet
      let destWallet = await tx.currencyWallet.findUnique({
        where: { userId_currency: { userId, currency: to } },
      });

      if (!destWallet) {
        destWallet = await tx.currencyWallet.create({
          data: { userId, currency: to, balance: 0 },
        });
      }

      // Credit destination wallet
      await tx.currencyWallet.update({
        where: { id: destWallet.id },
        data: { balance: { increment: toAmount } },
      });

      // Record conversion log
      const log = await tx.currencyConversion.create({
        data: {
          userId,
          fromCurrency: from,
          toCurrency: to,
          fromAmount: amt,
          toAmount,
          rate: effectiveRate,
          feeUsdc: 0, // fee is embedded in the spread
        },
      });

      return { log, toAmount };
    });

    // Socket emission
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${userId}`).emit('currency_converted', {
        fromCurrency: from,
        toCurrency: to,
        fromAmount: amt,
        toAmount: result.toAmount,
        rate: effectiveRate,
      });
    }

    return res.json({
      success: true,
      message: `Converted ${amt} ${from} to ${result.toAmount.toFixed(2)} ${to}.`,
      conversion: {
        fromCurrency: from,
        toCurrency: to,
        fromAmount: amt,
        toAmount: parseFloat(result.toAmount.toFixed(8)),
        rate: parseFloat(effectiveRate.toFixed(8)),
        fee: '1.5% spread',
      },
    });
  } catch (err) {
    logger.error({ err }, '[multiCurrency] convert error');
    return res.status(500).json({ success: false, message: 'Conversion failed.' });
  }
}

// ── Get FX rate ────────────────────────────────────────────────────────────
async function getFxRate(from, to) {
  // Try database first
  const dbRate = await prisma.fxRate.findUnique({
    where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
  });

  if (dbRate) {
    return parseFloat(dbRate.rate.toString());
  }

  // Fall back to base rates via USD cross
  if (BASE_RATES[from] && BASE_RATES[to]) {
    // rate = (1 USD in `to`) / (1 USD in `from`)
    return BASE_RATES[to] / BASE_RATES[from];
  }

  return null;
}

// ── GET /api/multi-currency/rates ──────────────────────────────────────────
async function getRates(req, res) {
  try {
    const rates = [];
    for (const from of SUPPORTED_CURRENCIES) {
      for (const to of SUPPORTED_CURRENCIES) {
        if (from === to) continue;
        const rate = await getFxRate(from, to);
        if (rate) {
          rates.push({
            from,
            to,
            rate: parseFloat(rate.toFixed(6)),
            effectiveRate: parseFloat((rate * (1 - FX_SPREAD)).toFixed(6)),
            spread: `${(FX_SPREAD * 100).toFixed(1)}%`,
          });
        }
      }
    }
    return res.json({ success: true, rates, supportedCurrencies: SUPPORTED_CURRENCIES });
  } catch (err) {
    logger.error({ err }, '[multiCurrency] rates error');
    return res.status(500).json({ success: false, message: 'Failed to load rates.' });
  }
}

// ── Admin: update FX rate ─────────────────────────────────────────────────
async function updateFxRate(req, res) {
  try {
    // Only admins
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'Admin access required.' });
    }

    const { fromCurrency, toCurrency, rate } = req.body;
    const from = fromCurrency?.toUpperCase();
    const to = toCurrency?.toUpperCase();
    const r = parseFloat(rate);

    if (!SUPPORTED_CURRENCIES.includes(from) || !SUPPORTED_CURRENCIES.includes(to)) {
      return res.status(400).json({ success: false, message: 'Unsupported currency.' });
    }

    if (!r || r <= 0) {
      return res.status(400).json({ success: false, message: 'Rate must be positive.' });
    }

    const updated = await prisma.fxRate.upsert({
      where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
      update: { rate: r, source: 'manual', fetchedAt: new Date() },
      create: { fromCurrency: from, toCurrency: to, rate: r, source: 'manual' },
    });

    return res.json({ success: true, message: `Rate updated: 1 ${from} = ${r} ${to}.` });
  } catch (err) {
    logger.error({ err }, '[multiCurrency] updateRate error');
    return res.status(500).json({ success: false, message: 'Failed to update rate.' });
  }
}

module.exports = {
  getWallets,
  createWallet,
  setDefaultWallet,
  convertCurrency,
  getRates,
  updateFxRate,
  getFxRate,
  SUPPORTED_CURRENCIES,
};
