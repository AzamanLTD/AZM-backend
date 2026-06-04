-- Phase F2: P2P Architecture Correction
-- Adds tradeAccountId FK on Ad model (links ad to vendor's specific payment account)
-- Adds buyerPaymentDetails JSON on Trade model (captures buyer's recipient info for SELL ads)
-- Adds P2P_FEE_PCT to GlobalSettings (flat fee replacing GHS margin math)
-- Sets Trade.currency default to 'USD' (P2P trades are USDC↔USD, not GHS)

-- 1. Ad → TradeAccount FK (nullable for backwards compat with existing ads)
ALTER TABLE "Ad" ADD COLUMN "tradeAccountId" TEXT;
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_tradeAccountId_fkey"
  FOREIGN KEY ("tradeAccountId") REFERENCES "TradeAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Ad_tradeAccountId_idx" ON "Ad"("tradeAccountId");

-- 2. Trade.buyerPaymentDetails (buyer provides their recipient info for SELL ads)
ALTER TABLE "Trade" ADD COLUMN "buyerPaymentDetails" JSONB;

-- 3. GlobalSettings.p2pFeePct (flat % fee on P2P trades, default 2%)
ALTER TABLE "GlobalSettings" ADD COLUMN "p2pFeePct" DOUBLE PRECISION NOT NULL DEFAULT 0.02;

-- 4. Add CHECK constraint on p2pFeePct
ALTER TABLE "GlobalSettings" ADD CONSTRAINT "GlobalSettings_p2pFeePct_range"
  CHECK ("p2pFeePct" >= 0 AND "p2pFeePct" <= 1);
