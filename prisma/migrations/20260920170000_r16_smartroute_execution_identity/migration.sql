-- r16 P0-A (audit 2026-09-20): durable smart-route execution identity.
--
-- A due scheduled occurrence claims exactly ONE run row through the unique
-- executionKey; the database — not an application read — decides the single
-- winner between the scheduler, /run-now and concurrent workers. PENDING
-- covers the claimed-but-not-yet-finalized window (finalization commits in
-- the same transaction as the financial mutation, so a stale PENDING row
-- guarantees its money never moved).
--
-- VaultDeposit.idempotencyKey: retry convergence for smart-route vault
-- deposits — a crashed execution re-driven by the recovery sweep converges on
-- the committed deposit instead of moving money twice.

-- Additive enum value (idempotent).
DO $$ BEGIN
  ALTER TYPE "SmartRouteRunStatus" ADD VALUE IF NOT EXISTS 'PENDING';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "executionKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "SmartRouteRun_executionKey_key"
  ON "SmartRouteRun"("executionKey");

ALTER TABLE "VaultDeposit" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "VaultDeposit_idempotencyKey_key"
  ON "VaultDeposit"("idempotencyKey");
