-- Phase Q1: Admin Fee Profiles — Dynamic Margin/Split Control
-- Allows the admin to create fee profiles that override default platform
-- fee percentages and admin/vendor split ratios.

CREATE TABLE "AdminFeeProfile" (
    "id"              TEXT NOT NULL DEFAULT gen_random_uuid(),
    "name"            TEXT NOT NULL,
    "targetScope"     TEXT NOT NULL,
    "targetValue"     TEXT,
    "platformFeePct"  DECIMAL(5,4) NOT NULL,
    "adminSplitPct"   DECIMAL(5,4) NOT NULL,
    "vendorSplitPct"  DECIMAL(5,4) NOT NULL,
    "exitFeePct"      DECIMAL(5,4) NOT NULL,
    "priority"        INTEGER NOT NULL DEFAULT 0,
    "isActive"        BOOLEAN NOT NULL DEFAULT true,
    "validFrom"       TIMESTAMP(3),
    "validUntil"      TIMESTAMP(3),
    "createdBy"       INTEGER,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminFeeProfile_pkey" PRIMARY KEY ("id")
);

-- Indexes for profile resolution queries
CREATE INDEX "AdminFeeProfile_isActive_priority_idx"
    ON "AdminFeeProfile"("isActive", "priority" DESC);

CREATE INDEX "AdminFeeProfile_targetScope_targetValue_idx"
    ON "AdminFeeProfile"("targetScope", "targetValue");

-- Seed the system default profile (priority 0, scope ALL)
-- This ensures the resolution logic always finds at least one profile.
INSERT INTO "AdminFeeProfile" (
    "id", "name", "targetScope", "platformFeePct", "adminSplitPct",
    "vendorSplitPct", "exitFeePct", "priority", "isActive"
) VALUES (
    'default-fee-profile',
    'System Default',
    'ALL',
    0.0200,  -- 2% platform fee
    0.6000,  -- 60% admin split (trades < $1k)
    0.4000,  -- 40% vendor split (trades < $1k)
    0.0200,  -- 2% exit fee
    0,       -- lowest priority
    true
);

-- CHECK constraints
ALTER TABLE "AdminFeeProfile"
    ADD CONSTRAINT "AdminFeeProfile_platformFeePct_range" CHECK ("platformFeePct" >= 0 AND "platformFeePct" <= 1),
    ADD CONSTRAINT "AdminFeeProfile_adminSplitPct_range" CHECK ("adminSplitPct" >= 0 AND "adminSplitPct" <= 1),
    ADD CONSTRAINT "AdminFeeProfile_vendorSplitPct_range" CHECK ("vendorSplitPct" >= 0 AND "vendorSplitPct" <= 1),
    ADD CONSTRAINT "AdminFeeProfile_exitFeePct_range" CHECK ("exitFeePct" >= 0 AND "exitFeePct" <= 1),
    ADD CONSTRAINT "AdminFeeProfile_split_sum" CHECK ("adminSplitPct" + "vendorSplitPct" BETWEEN 0.9999 AND 1.0001);
