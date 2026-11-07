-- §P.5-D one-way activation latch.
--
-- Nullable and additive: NULL means the authority was never activated, so the
-- legacy USDC pool semantics still hold. Once written the latch is never
-- cleared; authority mode is (flag OR latch != NULL).
ALTER TABLE "FiatLiquidityState"
  ADD COLUMN IF NOT EXISTS "authorityActivatedAt" TIMESTAMP(3);
