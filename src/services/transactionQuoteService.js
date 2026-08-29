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
  rateSource = 'AZM_ADMIN_MOCK',
  rateAsOf = now,
  id = crypto.randomUUID(),
  purpose = 'usdc_purchase',
  userId = null,
}) {
  if (!Number.isFinite(amountGhs) || amountGhs <= 0) throw new Error('amountGhs must be greater than zero');
  if (!Number.isFinite(rateGhsPerUsdc) || rateGhsPerUsdc < MIN_RATE_GHS_PER_USDC || rateGhsPerUsdc > MAX_RATE_GHS_PER_USDC) throw new Error('rateGhsPerUsdc is outside the permitted range');
  if (!Number.isFinite(feeGhs) || feeGhs < 0) throw new Error('feeGhs must be zero or greater');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new Error('ttlSeconds must be between 1 and 900 seconds');
  if (!userId || !Number.isInteger(Number(userId))) throw new Error('userId is required');

  const createdAt = new Date(now);
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
  const netGhs = Math.max(0, amountGhs - feeGhs);

  return {
    id,
    userId: Number(userId),
    purpose,
    amountGhs: roundMoney(amountGhs),
    feeGhs: roundMoney(feeGhs),
    netGhs: roundMoney(netGhs),
    rateGhsPerUsdc,
    usdcAmount: netGhs / rateGhsPerUsdc,
    rateSource,
    rateAsOf: new Date(rateAsOf).toISOString(),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

async function getServerRateGhsPerUsdc({ prisma, marketOracle }) {
  if (!prisma) throw new Error('Quote service requires Prisma');

  const settings = await prisma.globalSettings.findUnique({
    where: { id: 1 },
    select: { liveUsdToGhs: true, liveRateSource: true, lastRateSync: true },
  });
  const usdToGhs = Number(settings?.liveUsdToGhs);

  if (!Number.isFinite(usdToGhs) || usdToGhs <= 0) {
    throw new Error('A current USDC/GHS rate is not available');
  }

  void marketOracle;
  return {
    rateGhsPerUsdc: usdToGhs,
    rateSource: settings?.liveRateSource || 'AZM_ADMIN_MOCK',
    rateAsOf: settings?.lastRateSync || new Date(),
  };
}

async function persistTransactionQuote(prisma, quote) {
  if (!prisma?.$executeRaw) throw new Error('Quote service requires Prisma raw SQL support');

  await prisma.$executeRaw`
    INSERT INTO "TransactionQuote"
      ("id", "userId", "purpose", "amountGhs", "feeGhs", "netGhs",
       "rateGhsPerUsdc", "usdcAmount", "rateSource", "rateAsOf", "createdAt", "expiresAt")
    VALUES
      (${quote.id}::uuid, ${quote.userId}, ${quote.purpose}, ${quote.amountGhs}, ${quote.feeGhs}, ${quote.netGhs},
       ${quote.rateGhsPerUsdc}, ${quote.usdcAmount}, ${quote.rateSource}, ${new Date(quote.rateAsOf)},
       ${new Date(quote.createdAt)}, ${new Date(quote.expiresAt)})
  `;

  return quote;
}

async function createServerTransactionQuote({
  prisma,
  marketOracle,
  userId,
  purpose,
  amountGhs,
  feeGhs = 0,
  ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS,
  now = new Date(),
}) {
  const rate = await getServerRateGhsPerUsdc({ prisma, marketOracle });
  const quote = createTransactionQuote({
    userId,
    purpose,
    amountGhs,
    rateGhsPerUsdc: rate.rateGhsPerUsdc,
    rateSource: rate.rateSource,
    rateAsOf: rate.rateAsOf,
    feeGhs,
    ttlSeconds,
    now,
  });

  return persistTransactionQuote(prisma, quote);
}

async function consumeTransactionQuote({
  prisma,
  quoteId,
  userId,
  purpose,
  now = new Date(),
}) {
  if (!prisma?.$queryRaw) throw new Error('Quote service requires Prisma raw SQL support');
  if (!quoteId || !userId || !Number.isInteger(Number(userId))) throw new Error('quoteId and userId are required');

  const rows = await prisma.$queryRaw`
    UPDATE "TransactionQuote"
    SET "consumedAt" = ${new Date(now)},
        "consumedFor" = ${purpose || null}
    WHERE "id" = ${quoteId}::uuid
      AND "userId" = ${Number(userId)}
      AND (${purpose || null}::text IS NULL OR "purpose" = ${purpose})
      AND "consumedAt" IS NULL
      AND "expiresAt" > ${new Date(now)}
    RETURNING "id", "userId", "purpose", "amountGhs", "feeGhs", "netGhs",
              "rateGhsPerUsdc", "usdcAmount", "rateSource", "rateAsOf",
              "createdAt", "expiresAt", "consumedAt", "consumedFor"
  `;

  if (!rows.length) {
    throw new Error('Transaction quote is invalid, expired, already consumed, or not owned by this user');
  }

  const row = rows[0];
  return {
    id: row.id,
    userId: Number(row.userId),
    purpose: row.purpose,
    amountGhs: Number(row.amountGhs),
    feeGhs: Number(row.feeGhs),
    netGhs: Number(row.netGhs),
    rateGhsPerUsdc: Number(row.rateGhsPerUsdc),
    usdcAmount: Number(row.usdcAmount),
    rateSource: row.rateSource,
    rateAsOf: new Date(row.rateAsOf).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    consumedAt: new Date(row.consumedAt).toISOString(),
    consumedFor: row.consumedFor,
  };
}

function assertQuoteActive(quote, now = new Date()) {
  if (!quote || !quote.id || !quote.expiresAt) throw new Error('Invalid transaction quote');
  if (new Date(now).getTime() >= new Date(quote.expiresAt).getTime()) throw new Error('Transaction quote has expired');
  return quote;
}

module.exports = {
  DEFAULT_QUOTE_TTL_SECONDS,
  createTransactionQuote,
  createServerTransactionQuote,
  persistTransactionQuote,
  consumeTransactionQuote,
  getServerRateGhsPerUsdc,
  assertQuoteActive,
  roundMoney,
};
