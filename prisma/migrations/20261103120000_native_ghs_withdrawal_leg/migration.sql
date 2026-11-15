-- Native-GHS withdrawal leg (issue #389) — ADDITIVE ONLY.
-- No existing column changes meaning; every legacy USDC row keeps NULL in the
-- new columns, which the application reads as "legacy semantics".

ALTER TABLE "GlobalSettings"
  ADD COLUMN IF NOT EXISTS "nativeGhsWithdrawalEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Authoritative exact-pesewa payout amount + explicit settlement asset.
ALTER TABLE "Withdrawal"
  ADD COLUMN IF NOT EXISTS "amountGhs" DECIMAL(20, 2),
  ADD COLUMN IF NOT EXISTS "settlementCurrency" TEXT;

ALTER TABLE "TransactionHistory"
  ADD COLUMN IF NOT EXISTS "amountGhs" DECIMAL(20, 2),
  ADD COLUMN IF NOT EXISTS "settlementCurrency" TEXT;

CREATE TABLE IF NOT EXISTS "SavedBankBeneficiary" (
  "id"                  TEXT NOT NULL,
  "userId"              INTEGER NOT NULL,
  "bankCode"            VARCHAR(16) NOT NULL,
  "bankName"            VARCHAR(80) NOT NULL,
  "accountName"         VARCHAR(120),
  "accountNumberEnc"    TEXT NOT NULL,
  "accountNumberMasked" VARCHAR(32) NOT NULL,
  "accountNumberHmac"   VARCHAR(64) NOT NULL,
  "nickname"            VARCHAR(40),
  "status"              TEXT NOT NULL DEFAULT 'ACTIVE',
  "isPrimary"           BOOLEAN NOT NULL DEFAULT false,
  "validatedAt"         TIMESTAMP(3),
  "keyId"               VARCHAR(32),
  "envelopeVersion"     INTEGER NOT NULL DEFAULT 2,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedBankBeneficiary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SavedBankBeneficiary_userId_accountNumberHmac_key"
  ON "SavedBankBeneficiary" ("userId", "accountNumberHmac");
CREATE INDEX IF NOT EXISTS "SavedBankBeneficiary_userId_status_idx"
  ON "SavedBankBeneficiary" ("userId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SavedBankBeneficiary_userId_fkey'
  ) THEN
    ALTER TABLE "SavedBankBeneficiary"
      ADD CONSTRAINT "SavedBankBeneficiary_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
