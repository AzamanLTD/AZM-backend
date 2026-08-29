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
  assertQuoteActive,
  roundMoney,
};
