-- Phase Q2: Vendor Wallet Soft-Delete (Archive)
-- Trade accounts are NEVER permanently deleted. When a vendor "deletes" an
-- account, archivedAt is set and the record becomes invisible in the UI.
-- Retained for: audit trail, fraud investigation, compliance, dispute resolution.

ALTER TABLE "TradeAccount" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "TradeAccount" ADD COLUMN "archiveReason" TEXT;

-- Index for efficient filtering of active vs archived accounts
CREATE INDEX "TradeAccount_userId_archivedAt_idx"
    ON "TradeAccount"("userId", "archivedAt");
