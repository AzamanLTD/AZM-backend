-- §WP-I — the shared economic-use claim for a provider observation.
-- Idempotent: safe to run on every release, on an empty or populated database.
CREATE TABLE IF NOT EXISTS "ProviderObservationClaim" (
    "id"             TEXT        NOT NULL,
    "observationKey" TEXT        NOT NULL,
    "purpose"        TEXT        NOT NULL,
    "claimedByRef"   TEXT,
    "provider"       TEXT        NOT NULL,
    "accountKey"     TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderObservationClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderObservationClaim_observationKey_key"
    ON "ProviderObservationClaim" ("observationKey");
CREATE INDEX IF NOT EXISTS "ProviderObservationClaim_purpose_idx"
    ON "ProviderObservationClaim" ("purpose");
CREATE INDEX IF NOT EXISTS "ProviderObservationClaim_provider_createdAt_idx"
    ON "ProviderObservationClaim" ("provider", "createdAt");
