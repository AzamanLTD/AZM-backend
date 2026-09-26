-- Phase Q4: Ad Soft-Delete (Archive)
-- Adds archivedAt timestamp to the Ad table. NULL = active, SET = archived.
-- Archived ads are hidden from vendor lists and marketplace but retained
-- for audit trail, compliance, and dispute resolution.

ALTER TABLE "Ad" ADD COLUMN "archivedAt" TIMESTAMP(3);
