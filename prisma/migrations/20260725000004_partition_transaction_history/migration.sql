-- ── TransactionHistory Table Partitioning by Month (Phase 2: Scalability) ───
-- Converts the TransactionHistory table to a PostgreSQL declarative partitioned
-- table, partitioned by createdAt month. This keeps queries fast even with
-- millions of rows — PostgreSQL can prune partitions based on date filters.
--
-- Strategy: rename → create partitioned → migrate data → drop old
-- The partitioning key is createdAt (range partitioning by month).

-- Step 1: Rename the existing table
ALTER TABLE "TransactionHistory" RENAME TO "TransactionHistory_old";

-- Step 2: Create the new partitioned table with the same schema
CREATE TABLE "TransactionHistory" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"         INTEGER NOT NULL,
  "type"           "TransactionType" NOT NULL,
  "amountUsdc"     DECIMAL(20,8) NOT NULL,
  "feeUsdc"        DECIMAL(20,8) NOT NULL DEFAULT 0,
  "txHash"         TEXT,
  "providerRef"    TEXT,
  "payerMsisdn"    TEXT,
  "initiatedByUserId" INTEGER,
  "metadata"       JSONB,
  "status"         "TransactionStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id", "createdAt"),
  UNIQUE ("txHash", "createdAt"),
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
) PARTITION BY RANGE ("createdAt");

-- Step 3: Create indexes on the partitioned table (applies to all partitions)
CREATE INDEX "TransactionHistory_userId_idx" ON "TransactionHistory" ("userId");
CREATE INDEX "TransactionHistory_userId_createdAt_idx" ON "TransactionHistory" ("userId", "createdAt" DESC);
CREATE INDEX "TransactionHistory_userId_type_idx" ON "TransactionHistory" ("userId", "type");
CREATE INDEX "TransactionHistory_status_idx" ON "TransactionHistory" ("status");
CREATE INDEX "TransactionHistory_type_createdAt_idx" ON "TransactionHistory" ("type", "createdAt" DESC);

-- Step 4: Create partitions for existing data + future months
-- Default partition catches anything outside the explicit ranges
CREATE TABLE "TransactionHistory_default" PARTITION OF "TransactionHistory" DEFAULT;

-- Current month (July 2026)
CREATE TABLE "TransactionHistory_2026_07" PARTITION OF "TransactionHistory"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Next month (August 2026)
CREATE TABLE "TransactionHistory_2026_08" PARTITION OF "TransactionHistory"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- September 2026
CREATE TABLE "TransactionHistory_2026_09" PARTITION OF "TransactionHistory"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- October 2026
CREATE TABLE "TransactionHistory_2026_10" PARTITION OF "TransactionHistory"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- November 2026
CREATE TABLE "TransactionHistory_2026_11" PARTITION OF "TransactionHistory"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

-- December 2026
CREATE TABLE "TransactionHistory_2026_12" PARTITION OF "TransactionHistory"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- Step 5: Migrate existing data (partition routing is automatic based on createdAt)
INSERT INTO "TransactionHistory" ("id", "userId", "type", "amountUsdc", "feeUsdc", "txHash", "providerRef", "payerMsisdn", "initiatedByUserId", "metadata", "status", "createdAt")
SELECT "id", "userId", "type", "amountUsdc", "feeUsdc", "txHash", "providerRef", "payerMsisdn", "initiatedByUserId", "metadata", "status", "createdAt"
FROM "TransactionHistory_old";

-- Step 6: Drop the old table
DROP TABLE "TransactionHistory_old";

-- ── Monthly partition creation function ─────────────────────────────────────
-- Automatically creates partitions for future months. Call from a monthly cron.
CREATE OR REPLACE FUNCTION create_transaction_history_partition(year INT, month INT)
RETURNS TEXT AS $$
DECLARE
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  partition_name := 'TransactionHistory_' || year || '_' || LPAD(month::text, 2, '0');
  start_date := DATE (year::text || '-' || LPAD(month::text, 2, '0') || '-01');
  end_date := start_date + INTERVAL '1 month';

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF "TransactionHistory" FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );

  RETURN format('Created partition %s', partition_name);
END;
$$ LANGUAGE plpgsql;
