-- CreateTable: AdminApprovalRequest
CREATE TABLE "AdminApprovalRequest" (
    "id" SERIAL NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "entityId" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "description" VARCHAR(500) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "requestedBy" INTEGER NOT NULL,
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "approvals" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "approvedBy" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "rejectedBy" INTEGER,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminApprovalRequest_status_createdAt_idx" ON "AdminApprovalRequest"("status", "createdAt" DESC);
CREATE INDEX "AdminApprovalRequest_type_status_idx" ON "AdminApprovalRequest"("type", "status");

-- AddForeignKey
ALTER TABLE "AdminApprovalRequest" ADD CONSTRAINT "AdminApprovalRequest_requestedBy_fkey"
    FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
