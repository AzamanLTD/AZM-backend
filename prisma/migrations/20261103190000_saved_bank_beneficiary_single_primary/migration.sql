-- §P1-3 "primary" is a FACT, not a convention.
--
-- The service demotes the previous primary and then writes the new one, which
-- is correct one request at a time and wrong two at a time: both callers demote
-- nobody, both insert, and the customer ends up with two primary payees. A
-- partial unique index makes the invariant enforceable by the database, so any
-- writer — including a future one nobody has written yet — fails loudly instead
-- of quietly producing a second primary.
--
-- Pre-clean first: an existing duplicate would make the index creation fail and
-- block the migration. Keep the newest ACTIVE primary per user.

-- A non-active row cannot be primary at all.
UPDATE "SavedBankBeneficiary"
SET "isPrimary" = false
WHERE "isPrimary" = true
  AND "status" <> 'ACTIVE';

-- Among ACTIVE rows, keep the newest primary per user.
WITH ranked AS (
    SELECT "id",
           ROW_NUMBER() OVER (
               PARTITION BY "userId"
               ORDER BY "createdAt" DESC, "id"
           ) AS rn
    FROM "SavedBankBeneficiary"
    WHERE "isPrimary" = true
      AND "status" = 'ACTIVE'
)
UPDATE "SavedBankBeneficiary" AS b
SET "isPrimary" = false
FROM ranked AS r
WHERE b."id" = r."id"
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "SavedBankBeneficiary_one_primary_per_user"
    ON "SavedBankBeneficiary" ("userId")
    WHERE "isPrimary" = true AND "status" = 'ACTIVE';
