-- Phase 4: Webhook System for Businesses

-- WebhookEndpoint: business registers URLs to receive event deliveries
CREATE TABLE "WebhookEndpoint" (
    "id"            TEXT NOT NULL,
    "businessId"    TEXT NOT NULL,
    "url"           VARCHAR(500) NOT NULL,
    "secret"        VARCHAR(255) NOT NULL,
    "events"        TEXT[] NOT NULL DEFAULT '{}',
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "lastTriggered" TIMESTAMP(3),
    "failureCount"  INTEGER NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookEndpoint_businessId_idx" ON "WebhookEndpoint"("businessId");
CREATE INDEX "WebhookEndpoint_isActive_idx" ON "WebhookEndpoint"("isActive");

-- WebhookDelivery: tracks each delivery attempt with exponential backoff retry
CREATE TABLE "WebhookDelivery" (
    "id"            TEXT NOT NULL,
    "endpointId"    TEXT NOT NULL,
    "event"          TEXT NOT NULL,
    "payload"        JSONB NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'pending',
    "attempts"       INTEGER NOT NULL DEFAULT 0,
    "maxAttempts"   INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt"   TIMESTAMP(3),
    "responseCode"  INTEGER,
    "responseBody"  VARCHAR(2000),
    "deliveredAt"    TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookDelivery_endpointId_idx" ON "WebhookDelivery"("endpointId");
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");
CREATE INDEX "WebhookDelivery_nextRetryAt_idx" ON "WebhookDelivery"("nextRetryAt");

ALTER TABLE "WebhookDelivery"
  ADD CONSTRAINT "WebhookDelivery_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE;
