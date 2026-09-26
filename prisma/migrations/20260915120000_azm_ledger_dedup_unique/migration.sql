-- AZM ledger idempotency (P0, 2026-09-15): creditAzm()/debitAzm() relied on a
-- read-then-write JSON-metadata pre-check with NO database-level uniqueness on
-- the dedup identity, so two concurrent identical requests could both miss the
-- pre-check and BOTH mutate User.azmBalance. This migration adds the dedicated
-- dedup column and the composite unique invariant that closes the race; the
-- service layer converges the resulting unique-conflict to the existing
-- idempotent result semantics (no raw P2002 surfaces to clients).
--
-- Additive only: no column drops, no ledger deletions, no financial mutation.

ALTER TABLE "AzmRewardLog" ADD COLUMN IF NOT EXISTS "dedupKey" TEXT;
ALTER TABLE "AzmSpendLog"    ADD COLUMN IF NOT EXISTS "dedupKey" TEXT;

-- Audit trail FIRST: count historical duplicate (userId, source, dedupKey)
-- identities from the legacy metadata location BEFORE backfilling, so the
-- duplicate population is recorded in the migration log rather than silently
-- disappearing once the column exists. Duplicates are PRESERVED — never
-- deleted and never rewritten.
DO $$
DECLARE
    dup_rewards INTEGER;
    dup_spends  INTEGER;
BEGIN
    SELECT COALESCE(SUM(c - 1), 0) INTO dup_rewards FROM (
        SELECT COUNT(*) AS c FROM "AzmRewardLog"
        WHERE metadata ? 'dedupKey'
        GROUP BY "userId", "source", metadata->>'dedupKey'
        HAVING COUNT(*) > 1
    ) d;
    SELECT COALESCE(SUM(c - 1), 0) INTO dup_spends FROM (
        SELECT COUNT(*) AS c FROM "AzmSpendLog"
        WHERE metadata ? 'dedupKey'
        GROUP BY "userId", "source", metadata->>'dedupKey'
        HAVING COUNT(*) > 1
    ) d;
    RAISE NOTICE 'AZM dedup backfill: % duplicate AzmRewardLog rows and % duplicate AzmSpendLog rows detected; earliest row per identity keeps the dedupKey claim, later rows keep full ledger history with dedupKey column NULL (never deleted, metadata untouched).', dup_rewards, dup_spends;
END $$;

-- First-occurrence-wins backfill: the EARLIEST row per (userId, source,
-- dedupKey) claims the dedicated column; later historical duplicates keep the
-- column NULL. This means:
--   * clean history -> identical to a full backfill, unique index builds clean;
--   * dirty history -> the index still builds (Postgres treats NULLs as
--     distinct, so multiple NULL dedupKeys are valid), every ledger row and
--     every metadata value is preserved byte-for-byte, and exactly-once is
--     enforced for every future dedup-bearing write.
WITH ranked AS (
    SELECT id, metadata->>'dedupKey' AS dk,
           ROW_NUMBER() OVER (
               PARTITION BY "userId", "source", metadata->>'dedupKey'
               ORDER BY "createdAt", id
           ) AS rn
    FROM "AzmRewardLog"
    WHERE metadata ? 'dedupKey' AND metadata->>'dedupKey' IS NOT NULL
)
UPDATE "AzmRewardLog" AS r
SET "dedupKey" = ranked.dk
FROM ranked
WHERE r.id = ranked.id AND ranked.rn = 1;

WITH ranked AS (
    SELECT id, metadata->>'dedupKey' AS dk,
           ROW_NUMBER() OVER (
               PARTITION BY "userId", "source", metadata->>'dedupKey'
               ORDER BY "createdAt", id
           ) AS rn
    FROM "AzmSpendLog"
    WHERE metadata ? 'dedupKey' AND metadata->>'dedupKey' IS NOT NULL
)
UPDATE "AzmSpendLog" AS r
SET "dedupKey" = ranked.dk
FROM ranked
WHERE r.id = ranked.id AND ranked.rn = 1;

-- Composite uniqueness invariant, matching the Prisma @@unique([userId,
-- source, dedupKey]) default index name so `prisma db push` (the established
-- prod/CI schema-management pattern) and `prisma migrate deploy` converge on
-- the exact same index.
CREATE UNIQUE INDEX IF NOT EXISTS "AzmRewardLog_userId_source_dedupKey_key"
    ON "AzmRewardLog"("userId", "source", "dedupKey");
CREATE UNIQUE INDEX IF NOT EXISTS "AzmSpendLog_userId_source_dedupKey_key"
    ON "AzmSpendLog"("userId", "source", "dedupKey");
