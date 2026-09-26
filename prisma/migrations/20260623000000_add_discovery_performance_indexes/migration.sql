-- =============================================================================
-- Foundation Sprint — Discovery & Order-List Performance Indexes (2026-06-23)
-- =============================================================================
-- Adds the composite indexes that back the two highest-fanout read paths in the
-- business marketplace surface. Audited against the ACTUAL query shapes (not the
-- design-doc's generic suggestions):
--
--   • businessService.searchBusinesses — public discovery. Always filters
--     isSuspended=false, optionally category, and ORDERs BY totalEscrows DESC.
--     Existing single-column indexes ([category], [isVerified], …) cannot serve
--     the filter+sort together, forcing a scan + in-memory sort that worsens as
--     the marketplace grows.
--
--   • businessOrderService.listOrdersForBusiness / listOrdersForCustomer —
--     owner and customer order history. Both ORDER BY createdAt DESC with an
--     optional status filter. The pre-existing [businessProfileId, status] and
--     bare [customerId] indexes don't carry createdAt, so pagination re-sorts.
--
-- Naming matches Prisma's auto-generated identifiers (verified via
-- `prisma migrate diff`) so schema introspection and migrate state stay in sync.
--
-- Style follows 20260606120000_add_missing_indexes: plain CREATE INDEX (NOT
-- CONCURRENTLY — Prisma wraps each migration in one transaction, and
-- CONCURRENTLY can't run in a transaction block), with IF NOT EXISTS so the
-- statement is idempotent and safe on environments already converged via
-- `prisma db push`. For zero-downtime builds on a hot table, create these
-- CONCURRENTLY by hand outside Prisma Migrate first; the IF NOT EXISTS guard
-- then makes this migration a no-op.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- BusinessProfile — public discovery (filter isSuspended[, category] + sort)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "BusinessProfile_isSuspended_totalEscrows_idx"
    ON "BusinessProfile"("isSuspended", "totalEscrows" DESC);

CREATE INDEX IF NOT EXISTS "BusinessProfile_isSuspended_category_totalEscrows_idx"
    ON "BusinessProfile"("isSuspended", "category", "totalEscrows" DESC);

-- ---------------------------------------------------------------------------
-- BusinessOrder — paginated order history (filter[, status] + createdAt sort)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "BusinessOrder_businessProfileId_status_createdAt_idx"
    ON "BusinessOrder"("businessProfileId", "status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "BusinessOrder_customerId_status_createdAt_idx"
    ON "BusinessOrder"("customerId", "status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "BusinessOrder_customerId_createdAt_idx"
    ON "BusinessOrder"("customerId", "createdAt" DESC);
