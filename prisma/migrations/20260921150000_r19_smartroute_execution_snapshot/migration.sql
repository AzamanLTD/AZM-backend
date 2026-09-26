-- r19 P0 (audit 2026-09-21): immutable Smart Route execution snapshot.
--
-- A claimed SmartRouteRun becomes an immutable economic snapshot: the
-- executors, crash recovery and settlement convergence read the run's OWN
-- columns after the claim, never the mutable parent SmartRoute. A route edit
-- between claim and execution can no longer change the amount, destination,
-- action or claimed occurrence of an already-claimed economic operation.
--
-- All columns are additive and nullable: existing rows (claimed before r19)
-- keep their pre-r19 behavior through the narrow legacy fallback paths, and
-- every run claimed after r19 carries the full snapshot.

ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "action" "SmartRouteAction";
ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destMomoNumber" TEXT;
ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destMomoProvider" TEXT;
ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destFriendUserId" INTEGER;
ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destSavingsGoalId" TEXT;
ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destVaultId" TEXT;
ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "frequency" "SmartRouteFrequency";
ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "dayOfMonth" INTEGER;
ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "claimedOccurrenceAt" TIMESTAMP(3);

-- Queryability for settlement convergence (reference → run lookup goes
-- through the canonical TransactionHistory txHash, so no extra index is
-- needed for that path; this covers run-side terminal scans).
CREATE INDEX IF NOT EXISTS "SmartRouteRun_status_routeId_idx"
    ON "SmartRouteRun"("status", "routeId");
