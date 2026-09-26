-- Phase Q14: Admin Dispute Resolution Workflow
-- Structured resolution flow: assign → review → rule → auto-execute

CREATE TABLE "DisputeResolution" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "tradeId" INTEGER NOT NULL,
    "adminId" INTEGER NOT NULL,
    "ruling" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "buyerAmount" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "vendorAmount" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "totalEscrow" DECIMAL(20, 8) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeResolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DisputeResolution_ruling_valid" CHECK ("ruling" IN ('BUYER_WINS', 'VENDOR_WINS', 'SPLIT')),
    CONSTRAINT "DisputeResolution_status_valid" CHECK ("status" IN ('PENDING', 'EXECUTED', 'FAILED')),
    CONSTRAINT "DisputeResolution_amounts_valid" CHECK ("buyerAmount" >= 0 AND "vendorAmount" >= 0),
    CONSTRAINT "DisputeResolution_tradeId_unique" UNIQUE ("tradeId")
);

-- Foreign keys
ALTER TABLE "DisputeResolution" ADD CONSTRAINT "DisputeResolution_tradeId_fkey"
    FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DisputeResolution" ADD CONSTRAINT "DisputeResolution_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "DisputeResolution_status" ON "DisputeResolution"("status");
CREATE INDEX "DisputeResolution_adminId" ON "DisputeResolution"("adminId");
CREATE INDEX "DisputeResolution_createdAt" ON "DisputeResolution"("createdAt" DESC);
