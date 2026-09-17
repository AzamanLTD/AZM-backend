-- Custody execution boundary — financial architecture §P.2 (2026-09-17)
-- Additive and history-preserving. Production is db-push managed (schema.prisma
-- owns the base DDL); this file is the migration-deploy record AND the
-- idempotent installer input. It mirrors infra/install-custody-execution-overlay.js.

-- Idempotent base table (matches the schema.prisma model)
CREATE TABLE IF NOT EXISTS "CustodyExecution" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "refId" TEXT,
    "walletAddressId" TEXT,
    "userId" INTEGER,
    "network" VARCHAR(20) NOT NULL DEFAULT 'POLYGON',
    "asset" VARCHAR(20) NOT NULL DEFAULT 'USDC',
    "contractAddress" VARCHAR(42) NOT NULL,
    "fromAddress" VARCHAR(42) NOT NULL,
    "toAddress" VARCHAR(42) NOT NULL,
    "amountBaseUnits" BIGINT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 6,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "provider" VARCHAR(30) NOT NULL DEFAULT 'TATUM_KMS',
    "tatumPendingId" VARCHAR(100),
    "txHash" TEXT,
    "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "errorClass" VARCHAR(40),
    "errorMessage" VARCHAR(500),
    "feeChargeBaseUnits" BIGINT,
    "estimatedNetworkCostBaseUnits" BIGINT,
    "realizedNetworkCostBaseUnits" BIGINT,
    "submittedAt" TIMESTAMP(3),
    "broadcastAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustodyExecution_pkey" PRIMARY KEY ("id")
);

-- Durable execution identity: one external execution per idempotency key.
-- Duplicate concurrent claims collide here and converge on the committed row.
CREATE UNIQUE INDEX IF NOT EXISTS "CustodyExecution_idempotencyKey_key"
    ON "CustodyExecution"("idempotencyKey");

-- A tx hash may only ever be recorded once, and only from real evidence.
CREATE UNIQUE INDEX IF NOT EXISTS "CustodyExecution_txHash_key"
    ON "CustodyExecution"("txHash")
    WHERE "txHash" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "CustodyExecution_kind_refId_idx"
    ON "CustodyExecution"("kind", "refId");
CREATE INDEX IF NOT EXISTS "CustodyExecution_status_idx"
    ON "CustodyExecution"("status");
CREATE INDEX IF NOT EXISTS "CustodyExecution_walletAddressId_idx"
    ON "CustodyExecution"("walletAddressId");
CREATE INDEX IF NOT EXISTS "CustodyExecution_userId_idx"
    ON "CustodyExecution"("userId");

-- DB-enforced sweep-claim authority: at most ONE unresolved deposit sweep
-- per source WalletAddress, no matter how many worker processes/instances
-- overlap. RECONCILIATION_REQUIRED is deliberately included: an AMBIGUOUS
-- outcome must block any new sweep attempt for that address until a human
-- reconciles it — a blind retry could double-send the same balance. Only
-- COMPLETED / FAILED free the address for a later sweep (its balance may
-- legitimately change again). Prisma cannot express partial unique indexes;
-- db push may drop it, so boot reinstalls it.
CREATE UNIQUE INDEX IF NOT EXISTS "CustodyExecution_one_inflight_sweep_per_wallet_idx"
    ON "CustodyExecution"("walletAddressId")
    WHERE "kind" = 'DEPOSIT_SWEEP'
      AND "status" IN ('REQUESTED','RESERVING','SUBMITTED','SIGNING','BROADCAST','CONFIRMING','RECONCILIATION_REQUIRED');

-- No financial records are backfilled or rewritten by this migration.
