-- Phase Q8: Admin Autonomous Payouts
-- Adds auto-payout configuration fields to GlobalSettings

ALTER TABLE "GlobalSettings"
ADD COLUMN "autoPayoutEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "autoPayoutThresholdUsdc" DECIMAL(20,8) NOT NULL DEFAULT 500.00,
ADD COLUMN "autoPayoutMaxAmountUsdc" DECIMAL(20,8) NOT NULL DEFAULT 200.00,
ADD COLUMN "autoPayoutIntervalMs" INTEGER NOT NULL DEFAULT 120000;

-- autoPayoutEnabled: master switch for the batch worker
-- autoPayoutThresholdUsdc: fiat pool must have at least this much for auto-processing
-- autoPayoutMaxAmountUsdc: individual withdrawal must be <= this to auto-process
-- autoPayoutIntervalMs: how often the worker scans (default 2 min)

-- CHECK constraints
ALTER TABLE "GlobalSettings"
ADD CONSTRAINT "GlobalSettings_autoPayoutThresholdUsdc_gte0"
CHECK ("autoPayoutThresholdUsdc" >= 0);

ALTER TABLE "GlobalSettings"
ADD CONSTRAINT "GlobalSettings_autoPayoutMaxAmountUsdc_gte0"
CHECK ("autoPayoutMaxAmountUsdc" >= 0);

ALTER TABLE "GlobalSettings"
ADD CONSTRAINT "GlobalSettings_autoPayoutIntervalMs_gte10000"
CHECK ("autoPayoutIntervalMs" >= 10000);
