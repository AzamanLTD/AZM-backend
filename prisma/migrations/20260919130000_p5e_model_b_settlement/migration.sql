-- §P.5-E Model B settlement / inventory cost-basis realization.
-- Additive only: the durable settlement economic identity + the GlobalSettings
-- rollout flag. GHS amounts are exact DECIMAL(20,2) (pesewas); USDC quantities
-- and cost-basis figures are DECIMAL(20,8), matching the ledger's exact-decimal
-- authority. InventoryLot/InventoryLotConsumption are untouched (P5-B closed).

ALTER TABLE "GlobalSettings"
    ADD COLUMN IF NOT EXISTS "modelBSettlementEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "ModelBSettlement" (
    "id" SERIAL NOT NULL,
    "reference" VARCHAR(140) NOT NULL,
    "transactionHistoryId" VARCHAR(36) NOT NULL,
    "quoteId" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "selectedRoute" TEXT,
    "routeProviderRail" TEXT,
    "routePolicyVersion" TEXT,
    "provider" VARCHAR(40) NOT NULL,
    "providerRef" TEXT,
    "evidenceDedupKey" VARCHAR(140) NOT NULL,
    "quotedGhs" DECIMAL(20,2) NOT NULL,
    "quotedRateGhsPerUsdc" DECIMAL(20,8) NOT NULL,
    "quotedUsdc" DECIMAL(20,8) NOT NULL,
    "settledGhs" DECIMAL(20,2) NOT NULL,
    "settledUsdc" DECIMAL(20,8) NOT NULL,
    "costBasisGhsTotal" DECIMAL(20,8) NOT NULL,
    "costAllocationResidualGhs" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "marginGhs" DECIMAL(20,8) NOT NULL,
    "providerFeeGhs" DECIMAL(20,2),
    "conversionIdentity" VARCHAR(140) NOT NULL,
    "conversionLedgerTxnId" VARCHAR(36) NOT NULL,
    "depositLedgerTxnId" VARCHAR(36) NOT NULL,
    "lotAllocations" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelBSettlement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ModelBSettlement_reference_key" ON "ModelBSettlement"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "ModelBSettlement_conversionIdentity_key" ON "ModelBSettlement"("conversionIdentity");
-- §P.5-E audit r13 (§8): consume-once quote + UNIQUE txHash ⇒ exactly-once
-- identity, DB-enforced (names match the prisma @@unique map names).
CREATE UNIQUE INDEX IF NOT EXISTS "ModelBSettlement_quoteId_key" ON "ModelBSettlement"("quoteId");
CREATE INDEX IF NOT EXISTS "ModelBSettlement_userId_idx" ON "ModelBSettlement"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "ModelBSettlement_transactionHistoryId_key" ON "ModelBSettlement"("transactionHistoryId");
CREATE INDEX IF NOT EXISTS "ModelBSettlement_evidenceDedupKey_idx" ON "ModelBSettlement"("evidenceDedupKey");

-- DB CHECKs Prisma cannot express (mirrored in the boot overlay installer).
-- Idempotency: Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard each
-- named CHECK with a DO block — re-running this migration on a database that
-- already enforces these checks is a no-op instead of an error.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ModelBSettlement_amounts_positive'
          AND conrelid = '"ModelBSettlement"'::regclass
    ) THEN
        ALTER TABLE "ModelBSettlement" ADD CONSTRAINT "ModelBSettlement_amounts_positive"
            CHECK ("quotedGhs" > 0 AND "settledGhs" > 0 AND "quotedUsdc" > 0 AND "settledUsdc" > 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ModelBSettlement_quote_consistency'
          AND conrelid = '"ModelBSettlement"'::regclass
    ) THEN
        ALTER TABLE "ModelBSettlement" ADD CONSTRAINT "ModelBSettlement_quote_consistency"
            CHECK ("quotedRateGhsPerUsdc" > 0);
    END IF;
END$$;

-- §P.5-E audit r1: structural inventory-authority gate. Eligibility is false
-- by default and granted by no production code path — only a future,
-- evidence-backed acquisition authority may set it. Model B settlement claims
-- ONLY eligible lots; quantity alone can never fund a customer liability.
ALTER TABLE "InventoryLot"
    ADD COLUMN IF NOT EXISTS "eligibleForModelBSettlement" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "InventoryLot_eligible_status_idx"
    ON "InventoryLot"("eligibleForModelBSettlement", "status");
