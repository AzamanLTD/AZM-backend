-- Durable, server-authoritative transaction quotes.
-- This table intentionally lives outside the generated Prisma client so the
-- existing large schema does not need a lossy rewrite. Runtime access uses
-- parameterized Prisma raw SQL in transactionQuoteService.

CREATE TABLE IF NOT EXISTS "TransactionQuote" (
  "id" UUID PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "purpose" TEXT NOT NULL CHECK ("purpose" IN ('deposit', 'usdc_purchase', 'withdrawal', 'local_wallet')),
  "amountGhs" DECIMAL(20,8) NOT NULL CHECK ("amountGhs" > 0),
  "feeGhs" DECIMAL(20,8) NOT NULL DEFAULT 0 CHECK ("feeGhs" >= 0),
  "netGhs" DECIMAL(20,8) NOT NULL CHECK ("netGhs" >= 0),
  "rateGhsPerUsdc" DECIMAL(20,8) NOT NULL CHECK ("rateGhsPerUsdc" > 0),
  "usdcAmount" DECIMAL(30,12) NOT NULL CHECK ("usdcAmount" >= 0),
  "rateSource" TEXT NOT NULL,
  "rateAsOf" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumedFor" TEXT,
  CONSTRAINT "TransactionQuote_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE INDEX IF NOT EXISTS "TransactionQuote_userId_createdAt_idx"
  ON "TransactionQuote" ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "TransactionQuote_expiresAt_consumedAt_idx"
  ON "TransactionQuote" ("expiresAt", "consumedAt");

CREATE INDEX IF NOT EXISTS "TransactionQuote_purpose_expiresAt_idx"
  ON "TransactionQuote" ("purpose", "expiresAt");
