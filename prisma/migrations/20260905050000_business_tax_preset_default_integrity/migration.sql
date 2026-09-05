-- Ensure historical data converges to one deterministic default per business.
-- The oldest created preset (id as deterministic tie-breaker) wins; all later
-- defaults are cleared before the unique partial index is installed.
WITH ranked_defaults AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "businessProfileId"
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS row_num
    FROM "BusinessTaxPreset"
    WHERE "isDefault" = true
)
UPDATE "BusinessTaxPreset" AS p
SET "isDefault" = false,
    "updatedAt" = CURRENT_TIMESTAMP
FROM ranked_defaults AS r
WHERE p."id" = r."id"
  AND r.row_num > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessTaxPreset_businessProfileId_default_key"
    ON "BusinessTaxPreset" ("businessProfileId")
    WHERE "isDefault" = true;
