-- Moolre collection on-ramp (2026-06-23)
-- Additive, nullable columns only. No backfill, no NOT NULL, no data loss.
--
-- Every statement is IF NOT EXISTS so this migration is idempotent and safe to
-- run on an environment already converged via `prisma db push` (AZM prod uses
-- db push; see the "db-push vs migrate divergence" note). Column + index names
-- match Prisma's own conventions so db-push and migrate-deploy stay in lockstep.

-- TransactionHistory: deposit provenance + flexible metadata
ALTER TABLE "TransactionHistory" ADD COLUMN IF NOT EXISTS "providerRef" TEXT;
ALTER TABLE "TransactionHistory" ADD COLUMN IF NOT EXISTS "payerMsisdn" TEXT;
ALTER TABLE "TransactionHistory" ADD COLUMN IF NOT EXISTS "initiatedByUserId" INTEGER;
ALTER TABLE "TransactionHistory" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- User + BusinessProfile: permanent Moolre Payment ID (*203*<id>#)
ALTER TABLE "User"            ADD COLUMN IF NOT EXISTS "moolrePaymentId" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "moolrePaymentId" TEXT;

-- @unique on the two payment-id columns (partial-free; NULLs are allowed and
-- never collide under a UNIQUE index in Postgres).
CREATE UNIQUE INDEX IF NOT EXISTS "User_moolrePaymentId_key"
  ON "User"("moolrePaymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessProfile_moolrePaymentId_key"
  ON "BusinessProfile"("moolrePaymentId");
