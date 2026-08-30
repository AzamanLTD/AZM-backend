-- Durable external-provider identity for fiat settlement attempts.
-- TransactionHistory.txHash remains the Azaman idempotency/correlation key;
-- this table records the provider's own identity separately so reconciliation
-- never has to infer identity from user + amount + timestamp.

CREATE TABLE "ProviderSettlementAttempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transactionHistoryId" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "providerReference" VARCHAR(255) NOT NULL,
    "providerTransactionId" VARCHAR(255),
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "firstSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ,
    "failureReason" TEXT,
    "metadata" JSONB,

    CONSTRAINT "ProviderSettlementAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderSettlementAttempt_transactionHistoryId_fkey"
        FOREIGN KEY ("transactionHistoryId")
        REFERENCES "TransactionHistory"("id")
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX "ProviderSettlementAttempt_provider_providerReference_key"
    ON "ProviderSettlementAttempt"("provider", "providerReference");

CREATE INDEX "ProviderSettlementAttempt_transactionHistoryId_idx"
    ON "ProviderSettlementAttempt"("transactionHistoryId");

CREATE INDEX "ProviderSettlementAttempt_status_lastSeenAt_idx"
    ON "ProviderSettlementAttempt"("status", "lastSeenAt");

CREATE INDEX "ProviderSettlementAttempt_providerTransactionId_idx"
    ON "ProviderSettlementAttempt"("providerTransactionId");
