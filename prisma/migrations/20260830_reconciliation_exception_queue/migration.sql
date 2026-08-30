-- Durable operational queue for reconciliation states that cannot be safely
-- correlated or automatically repaired. Financial truth remains in the
-- canonical ledger; this table records work that requires investigation.

CREATE TABLE "ReconciliationException" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(255) NOT NULL,
    "reference" VARCHAR(255),
    "reason" VARCHAR(128) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    "details" JSONB,
    "firstSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ,
    "resolvedBy" INTEGER,

    CONSTRAINT "ReconciliationException_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReconciliationException_entity_reason_open_key"
    ON "ReconciliationException"("entityType", "entityId", "reason")
    WHERE "status" = 'OPEN';

CREATE INDEX "ReconciliationException_status_lastSeenAt_idx"
    ON "ReconciliationException"("status", "lastSeenAt");

CREATE INDEX "ReconciliationException_reference_idx"
    ON "ReconciliationException"("reference");

CREATE INDEX "ReconciliationException_entity_idx"
    ON "ReconciliationException"("entityType", "entityId");
