-- r15 R15-A: at most ONE AVAILABLE liquidity receipt per settled deposit.
-- Application-level read checks cannot serialize two concurrent
-- confirmReconciliationMatch claims (READ COMMITTED); this partial unique
-- index is the race authority. A second claim fails with a unique violation
-- BEFORE any availableGhs increment, so the loser can never mint GHS.
--
-- PRE-FLIGHT: if historical data already contains duplicate AVAILABLE
-- receipts for the same relatedTransactionId, this CREATE INDEX fails
-- loudly. That is deliberate (fail closed). Resolve contradictory rows by
-- evidence review — never auto-select a winner. The release installer
-- (infra/install-fiat-liquidity-overlay.js) surfaces the offending rows
-- read-only before attempting this DDL.
CREATE UNIQUE INDEX IF NOT EXISTS "FiatLiquidityReceipt_availableRelatedTx_unique"
  ON "FiatLiquidityReceipt"("relatedTransactionId")
  WHERE "status" = 'AVAILABLE' AND "relatedTransactionId" IS NOT NULL;
