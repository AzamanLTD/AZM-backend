-- WP-I: provider settlement witness table.
-- Idempotent by construction: safe on a clean database and on one that already
-- has the table from a `prisma db push`. Never drops or rewrites evidence.
CREATE TABLE IF NOT EXISTS "ProviderSettlementWitness" (
    "id" TEXT NOT NULL,
    "openingDedupKey" TEXT NOT NULL,
    "observationKey" TEXT,
    "provider" TEXT NOT NULL,
    "fundingType" TEXT NOT NULL,
    "witnessKind" TEXT NOT NULL,
    "walletAccount" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "netPesewas" BIGINT NOT NULL,
    "grossPesewas" BIGINT,
    "providerState" TEXT NOT NULL,
    "adapterRule" TEXT,
    "endpoint" TEXT NOT NULL,
    "requestParams" JSONB NOT NULL,
    "rawResponseDigest" TEXT NOT NULL,
    "rawResponse" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderSettlementWitness_pkey" PRIMARY KEY ("id")
);

-- Upgrade path: databases created before the adapter rule existed.
ALTER TABLE "ProviderSettlementWitness" ADD COLUMN IF NOT EXISTS "adapterRule" TEXT;

-- One opening, one witness. One provider observation, one opening.
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderSettlementWitness_openingDedupKey_key"
    ON "ProviderSettlementWitness"("openingDedupKey");
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderSettlementWitness_observationKey_key"
    ON "ProviderSettlementWitness"("observationKey");
CREATE INDEX IF NOT EXISTS "ProviderSettlementWitness_provider_openingDedupKey_idx"
    ON "ProviderSettlementWitness"("provider", "openingDedupKey");
