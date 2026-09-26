-- =============================================================================
-- Phase ADMIN-CONTROL-2 — Add Missing Indexes (2026-06-06)
-- =============================================================================
-- Audit of all 40+ models against query patterns in controllers, services,
-- and workers. 16 models had zero or insufficient indexes. This migration
-- adds all missing indexes.
--
-- NOTE (2026-06-14): originally authored with CREATE INDEX CONCURRENTLY, but
-- Prisma Migrate (v6) wraps each migration's statements in a single
-- transaction, and CONCURRENTLY cannot run inside a transaction block
-- (Postgres error 25001). This made the migration impossible to apply via
-- both `migrate dev` (shadow DB) AND `migrate deploy` (P3018). CONCURRENTLY
-- has been removed so the migration applies. A plain CREATE INDEX takes a
-- brief lock per table; acceptable here, and IF NOT EXISTS keeps it
-- idempotent. For true zero-downtime index builds on a hot production table,
-- run CONCURRENTLY manually outside of Prisma Migrate.
--
-- IF NOT EXISTS guards every statement — safe to re-run on any environment.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. WITHDRAWAL — was ZERO indexes. Critical: every admin payout queue scan,
--    every user history fetch, every reconciliation worker hits this table.
-- ---------------------------------------------------------------------------

-- User withdrawal history (GET /api/wallet/history)
CREATE INDEX IF NOT EXISTS "Withdrawal_userId_createdAt_idx"
    ON "Withdrawal"("userId", "createdAt" DESC);

-- Admin payout queue / War Room (filter by status)
CREATE INDEX IF NOT EXISTS "Withdrawal_status_createdAt_idx"
    ON "Withdrawal"("status", "createdAt" DESC);

-- Reconciliation worker (PENDING + PROCESSING scans)
CREATE INDEX IF NOT EXISTS "Withdrawal_userId_status_idx"
    ON "Withdrawal"("userId", "status");

-- ---------------------------------------------------------------------------
-- 2. TRANSACTION HISTORY — had only bare userId. Missing composite and
--    type/status indexes that power every finance query.
-- ---------------------------------------------------------------------------

-- Cursor pagination on /api/transactions (userId + createdAt)
CREATE INDEX IF NOT EXISTS "TransactionHistory_userId_createdAt_idx"
    ON "TransactionHistory"("userId", "createdAt" DESC);

-- Filter by type (WITHDRAWAL_FIAT, P2P_TRADE, etc.)
CREATE INDEX IF NOT EXISTS "TransactionHistory_userId_type_idx"
    ON "TransactionHistory"("userId", "type");

-- Status filter (PENDING → sweep workers, FROZEN_DISPUTE → admin)
CREATE INDEX IF NOT EXISTS "TransactionHistory_status_idx"
    ON "TransactionHistory"("status");

-- Admin audit: all transactions of a given type across users
CREATE INDEX IF NOT EXISTS "TransactionHistory_type_createdAt_idx"
    ON "TransactionHistory"("type", "createdAt" DESC);

-- ---------------------------------------------------------------------------
-- 3. ADMIN PROFIT LOG — zero indexes. Revenue dashboard queries this
--    grouped by source and date range constantly.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "AdminProfitLog_source_createdAt_idx"
    ON "AdminProfitLog"("source", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "AdminProfitLog_createdAt_idx"
    ON "AdminProfitLog"("createdAt" DESC);

CREATE INDEX IF NOT EXISTS "AdminProfitLog_isSubsidized_idx"
    ON "AdminProfitLog"("isSubsidized");

-- ---------------------------------------------------------------------------
-- 4. SAVED WALLET — zero indexes. Queried on every withdrawal screen load
--    and every wallet picker (GET /api/wallet/saved).
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "SavedWallet_userId_idx"
    ON "SavedWallet"("userId");

CREATE INDEX IF NOT EXISTS "SavedWallet_userId_createdAt_idx"
    ON "SavedWallet"("userId", "createdAt" DESC);

-- ---------------------------------------------------------------------------
-- 5. REVIEW — had only @@unique([tradeId, reviewerId]). Vendor profile
--    queries fetch all reviews for a revieweeId — was a full table scan.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "Review_revieweeId_idx"
    ON "Review"("revieweeId");

CREATE INDEX IF NOT EXISTS "Review_reviewerId_idx"
    ON "Review"("reviewerId");

CREATE INDEX IF NOT EXISTS "Review_revieweeId_createdAt_idx"
    ON "Review"("revieweeId", "createdAt" DESC);

-- ---------------------------------------------------------------------------
-- 6. SUSU CONTRIBUTION — had userId and status but missing the composite
--    (cycleId, status) that the cycle-runner uses on every collection tick.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "SusuContribution_cycleId_status_idx"
    ON "SusuContribution"("cycleId", "status");

CREATE INDEX IF NOT EXISTS "SusuContribution_cycleId_userId_idx"
    ON "SusuContribution"("cycleId", "userId");

-- ---------------------------------------------------------------------------
-- 7. SUSU CYCLE — had (status, collectionDate) and payoutUserId, but missing
--    (susuGroupId, status) which every group dashboard fetches.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "SusuCycle_susuGroupId_status_idx"
    ON "SusuCycle"("susuGroupId", "status");

CREATE INDEX IF NOT EXISTS "SusuCycle_susuGroupId_cycleNumber_idx"
    ON "SusuCycle"("susuGroupId", "cycleNumber");

-- ---------------------------------------------------------------------------
-- 8. SMART ROUTE RUN — had (routeId, createdAt) and (userId, createdAt)
--    but missing status index used by the failed-run sweep worker.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "SmartRouteRun_status_idx"
    ON "SmartRouteRun"("status");

CREATE INDEX IF NOT EXISTS "SmartRouteRun_status_createdAt_idx"
    ON "SmartRouteRun"("status", "createdAt" DESC);

-- ---------------------------------------------------------------------------
-- 9. GROUP MESSAGE — had (groupId, createdAt) and senderId, but missing
--    type filter used for media gallery and system-event queries.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "GroupMessage_groupId_type_idx"
    ON "GroupMessage"("groupId", "type");

-- ---------------------------------------------------------------------------
-- 10. VOUCHER SLASH LOG — had voucherId and (susuGroupId, cycleId) but
--     missing vouchedUserId which the trust-rating dashboard filters on.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "VoucherSlashLog_vouchedUserId_idx"
    ON "VoucherSlashLog"("vouchedUserId");

CREATE INDEX IF NOT EXISTS "VoucherSlashLog_vouchedUserId_appliedAt_idx"
    ON "VoucherSlashLog"("vouchedUserId", "appliedAt" DESC);

-- ---------------------------------------------------------------------------
-- 11. LIABILITY ACCEPTANCE — had susuGroupId and voucherUserId, missing
--     contractVersion for compliance audits and version-specific queries.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "LiabilityAcceptance_contractVersion_idx"
    ON "LiabilityAcceptance"("contractVersion");

CREATE INDEX IF NOT EXISTS "LiabilityAcceptance_userId_susuGroupId_idx"
    ON "LiabilityAcceptance"("userId", "susuGroupId");

-- ---------------------------------------------------------------------------
-- 12. ADMIN WAR ROOM ALERT — had (acknowledgedAt, createdAt) and susuGroupId,
--     missing alertType index for the War Room type-filtered queue.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "AdminWarRoomAlert_alertType_idx"
    ON "AdminWarRoomAlert"("alertType");

CREATE INDEX IF NOT EXISTS "AdminWarRoomAlert_alertType_acknowledgedAt_idx"
    ON "AdminWarRoomAlert"("alertType", "acknowledgedAt");

-- ---------------------------------------------------------------------------
-- 13. TRADE QUEUE — had bare buyerId, adId, status. Missing composite
--     (adId, status) that processNextInQueue hits on every trade completion.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "TradeQueue_adId_status_idx"
    ON "TradeQueue"("adId", "status");

CREATE INDEX IF NOT EXISTS "TradeQueue_buyerId_status_idx"
    ON "TradeQueue"("buyerId", "status");

-- ---------------------------------------------------------------------------
-- 14. COLD STORAGE LOG — zero indexes. Admin ledger filtered by adminId
--     and date range for treasury audit trail.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "ColdStorageLog_adminId_createdAt_idx"
    ON "ColdStorageLog"("adminId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "ColdStorageLog_createdAt_idx"
    ON "ColdStorageLog"("createdAt" DESC);

-- ---------------------------------------------------------------------------
-- 15. VENDOR APPLICATION — no @@index directives. Admin KYC review queue
--     filters by status; vendor fetches their own by userId.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "VendorApplication_userId_idx"
    ON "VendorApplication"("userId");

CREATE INDEX IF NOT EXISTS "VendorApplication_status_createdAt_idx"
    ON "VendorApplication"("status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "VendorApplication_reviewedBy_idx"
    ON "VendorApplication"("reviewedBy");

-- ---------------------------------------------------------------------------
-- 16. SAVINGS DEPOSIT — had goalId and userId, but missing composite
--     (userId, createdAt) for the transaction-style history feed.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "SavingsDeposit_userId_createdAt_idx"
    ON "SavingsDeposit"("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "SavingsDeposit_goalId_createdAt_idx"
    ON "SavingsDeposit"("goalId", "createdAt" DESC);
