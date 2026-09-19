-- §P.5-D evidence-backed GHS liquidity authority.
-- Additive only: four new tables + the GlobalSettings rollout flag.
-- SystemFiatPool is preserved as a derived projection (never authority).
-- GHS amounts are exact DECIMAL(20,2) (pesewas).

ALTER TABLE "GlobalSettings"
    ADD COLUMN IF NOT EXISTS "fiatLiquidityAuthorityEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "FiatProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "rail" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerRef" TEXT,
    "dedupKey" TEXT NOT NULL,
    "amountGhs" DECIMAL(20,2) NOT NULL,
    "relatedReference" TEXT,
    "raw" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FiatProviderEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FiatProviderEvent_dedupKey_key" ON "FiatProviderEvent"("dedupKey");
CREATE INDEX "FiatProviderEvent_provider_providerRef_idx" ON "FiatProviderEvent"("provider", "providerRef");
CREATE INDEX "FiatProviderEvent_relatedReference_idx" ON "FiatProviderEvent"("relatedReference");
CREATE INDEX "FiatProviderEvent_direction_status_idx" ON "FiatProviderEvent"("direction", "status");

CREATE TABLE "FiatLiquidityReceipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "rail" TEXT,
    "providerRef" TEXT,
    "dedupKey" TEXT NOT NULL,
    "amountGhs" DECIMAL(20,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "route" TEXT,
    "relatedTransactionId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FiatLiquidityReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FiatLiquidityReceipt_dedupKey_key" ON "FiatLiquidityReceipt"("dedupKey");
CREATE INDEX "FiatLiquidityReceipt_status_idx" ON "FiatLiquidityReceipt"("status");
CREATE INDEX "FiatLiquidityReceipt_provider_providerRef_idx" ON "FiatLiquidityReceipt"("provider", "providerRef");
CREATE INDEX "FiatLiquidityReceipt_relatedTransactionId_idx" ON "FiatLiquidityReceipt"("relatedTransactionId");

CREATE TABLE "FiatLiquidityReservation" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountGhs" DECIMAL(20,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "provider" TEXT NOT NULL,
    "rail" TEXT,
    "destination" TEXT,
    "relatedTransactionId" TEXT,
    "providerRef" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FiatLiquidityReservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FiatLiquidityReservation_reference_key" ON "FiatLiquidityReservation"("reference");
CREATE INDEX "FiatLiquidityReservation_status_idx" ON "FiatLiquidityReservation"("status");
CREATE INDEX "FiatLiquidityReservation_provider_providerRef_idx" ON "FiatLiquidityReservation"("provider", "providerRef");

CREATE TABLE "FiatLiquidityState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "availableGhs" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "reservedGhs" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "inTransitGhs" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "paidOutGhs" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FiatLiquidityState_pkey" PRIMARY KEY ("id")
);

-- DB CHECKs Prisma cannot express (mirrored in the boot overlay installer).
ALTER TABLE "FiatProviderEvent" ADD CONSTRAINT "FiatProviderEvent_direction_valid"
    CHECK ("direction" IN ('INBOUND', 'OUTBOUND'));
ALTER TABLE "FiatLiquidityReceipt" ADD CONSTRAINT "FiatLiquidityReceipt_amount_positive"
    CHECK ("amountGhs" > 0);
ALTER TABLE "FiatLiquidityReceipt" ADD CONSTRAINT "FiatLiquidityReceipt_status_valid"
    CHECK ("status" IN ('RECEIVED', 'AVAILABLE', 'UNMATCHED', 'RECONCILIATION_REQUIRED', 'REVERSED'));
ALTER TABLE "FiatLiquidityReservation" ADD CONSTRAINT "FiatLiquidityReservation_amount_positive"
    CHECK ("amountGhs" > 0);
ALTER TABLE "FiatLiquidityReservation" ADD CONSTRAINT "FiatLiquidityReservation_status_valid"
    CHECK ("status" IN ('RESERVED', 'IN_TRANSIT', 'PAID_OUT', 'RELEASED', 'RECONCILIATION_REQUIRED'));
ALTER TABLE "FiatLiquidityState" ADD CONSTRAINT "FiatLiquidityState_totals_nonneg"
    CHECK ("availableGhs" >= 0 AND "reservedGhs" >= 0 AND "inTransitGhs" >= 0 AND "paidOutGhs" >= 0);

INSERT INTO "FiatLiquidityState" ("id", "availableGhs", "reservedGhs", "inTransitGhs", "paidOutGhs", "updatedAt")
    VALUES (1, 0, 0, 0, 0, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
