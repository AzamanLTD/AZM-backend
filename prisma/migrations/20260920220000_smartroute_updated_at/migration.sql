-- r16 P0-A lease sweep measures EXECUTING staleness from the last row
-- update, not creation. Backfill existing rows to their creation instant.
ALTER TABLE "SmartRouteRun" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now();
UPDATE "SmartRouteRun" SET "updatedAt" = "createdAt";
