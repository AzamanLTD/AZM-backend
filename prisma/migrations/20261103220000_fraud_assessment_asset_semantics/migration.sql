-- §P1 ASSET SEMANTICS FOR RISK ASSESSMENTS
--
-- FraudAssessment.amountUsdc is denominated in USDC and is read as such by the
-- admin surface. Native-GHS payout assessments were writing a GHS figure into
-- it, so the same column carried two different currencies depending on which
-- rail produced the row: 5,000 GHS looked like 5,000 USDC, an error of the whole
-- FX rate.
--
-- This migration keeps every historical row's meaning intact (they were USDC
-- rows and default to asset = 'USDC'), and adds the asset-aware representation
-- new assessments write. Nothing is backfilled, nothing is reinterpreted:
-- amountUsdc keeps its old value and its old meaning for old rows.
ALTER TABLE "FraudAssessment"
  ADD COLUMN IF NOT EXISTS "asset" VARCHAR(10) NOT NULL DEFAULT 'USDC',
  ADD COLUMN IF NOT EXISTS "amountExact" DECIMAL(30, 8) NOT NULL DEFAULT 0;

-- The asset-aware amount of a historical row IS its USDC amount, so the new
-- column starts truthful for existing data rather than zero.
UPDATE "FraudAssessment"
   SET "amountExact" = "amountUsdc"
 WHERE "amountExact" = 0 AND "amountUsdc" <> 0;

CREATE INDEX IF NOT EXISTS "FraudAssessment_asset_createdAt_idx"
  ON "FraudAssessment" ("asset", "createdAt" DESC);
