-- Canonical rate alerts use USDC as settlement currency and GHS as the
-- user-facing local currency. Existing USD_GHS rows are intentionally left
-- unchanged for backward compatibility.
ALTER TABLE "RateAlert"
  ALTER COLUMN "ratePair" SET DEFAULT 'USDC_GHS';
