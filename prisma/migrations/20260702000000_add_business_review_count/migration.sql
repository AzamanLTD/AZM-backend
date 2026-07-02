ALTER TABLE "BusinessProfile" ADD COLUMN "reviewCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "BusinessProfile" bp
SET "reviewCount" = sub.cnt
FROM (
  SELECT "businessProfileId", COUNT(*)::int AS cnt
  FROM "BusinessReview"
  GROUP BY "businessProfileId"
) sub
WHERE bp.id = sub."businessProfileId";
