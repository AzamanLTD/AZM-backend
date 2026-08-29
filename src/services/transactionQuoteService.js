'use strict';

const crypto = require('crypto');

const DEFAULT_QUOTE_TTL_SECONDS = 60;
const MAX_RATE_GHS_PER_USDC = 1000000;
const MIN_RATE_GHS_PER_USDC = 0.000001;

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function createTransactionQuote({
  amountGhs,
  rateGhsPerUsdc,
  feeGhs = 0,
  ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS,
  now = new Date(),
}) {
  if (!Number.isFinite(amountGhs) || amountGhs <= 0) {
    throw new Error('amountGhs must be greater than zero');
  }
  if (!Number.isFinite(rateGhsPerUsdc) || rateGhsPerUsdc < MIN_RATE_GHS_PER_USDC || rateGhsPerUsdc > MAX_RATE_GHS_PER_USDC) {
    throw new Error('rateGhsPerUsdc is outside the permitted range');
  }
  if (!Number.isFinite(feeGhs) || feeGhs < 0) {
    throw new Error('feeGhs must be zero or greater');
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
    throw new Error('ttlSeconds must be between 1 and 900 seconds');
  }

  const createdAt = new Date(now);
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
  const netGhs = Math.max(0, amountGhs - feeGhs);
  const usdcAmount = netGhs / rateGhsPerUsdc;

  return {
    id: crypto.randomUUID(),
    amountGhs: roundMoney(amountGhs),
    feeGhs: roundMoney(feeGhs),
    netGhs: roundMoney(netGhs),
    rateGhsPerUsdc,
    usdcAmount,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

async function getServerRateGhsPerUsdc({ prisma, marketOracle }) {
  if (!prisma) throw new Error('Quote service requires Prisma');

  const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
  const usdToGhs = Number(settings?.liveUsdToGhs);
  const usdcToUsd = Number(settings?.liveUsdcToUsd);

  if (!Number.isFinite(usdToGhs) || usdToGhs <= 0 || !Number.isFinite(usdcToUsd) || usdcToUsd <= 0) {
    throw new Error('A current USDC/GHS rate is not available');
  }

  // marketOracle is accepted as an explicit dependency so callers cannot
  // accidentally create a second rate source. The values are persisted by
  // the existing oracle service; the quote service reads that authoritative
  // server-side snapshot.
  void marketOracle;
  return usdToGhs / usdcToUsd;
}

async function createServerTransactionQuote({
  prisma,
  marketOracle,
  amountGhs,
  feeGhs = 0,
  ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS,
  now = new Date(),
}) {
  const rateGhsPerUsdc = await getServerRateGhsPerUsdc({ prisma, marketOracle });
  return createTransactionQuote({
    amountGhs,
    rateGhsPerUsdc,
    feeGhs,
    ttlSeconds,
    now,
  });
}

function assertQuoteActive(quote, now = new Date()) {
  if (!quote || !quote.id || !quote.expiresAt) {
    throw new Error('Invalid transaction quote');
  }
  if (new Date(now).getTime() >= new Date(quote.expiresAt).getTime()) {
    throw new Error('Transaction quote has expired');
  }
  return quote;
}

module.exports = {
  DEFAULT_QUOTE_TTL_SECONDS,
  createTransactionQuote,
  createServerTransactionQuote,
  getServerRateGhsPerUsdc,
  assertQuoteActive,
  roundMoney,
};
