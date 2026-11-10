-- WP-D: durable, atomic TOTP replay authority.
--
-- Redis SET NX is atomic but NOT durable: a Redis restart (or eviction) empties
-- the "used code" keys, and an instance without Redis had no shared state at
-- all. The anti-replay claim therefore lives in PostgreSQL, where the unique
-- (userId, step) index makes "exactly one winner" a database guarantee and the
-- row survives a process, container or cache restart.
--
-- Only the TOTP TIME-STEP index is stored — never the code, the secret or any
-- derived value that could be replayed.
CREATE TABLE IF NOT EXISTS "AppUnlockTotpClaim" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppUnlockTotpClaim_pkey" PRIMARY KEY ("id")
);

-- The claim itself: one accepted code per user per 30s step, enforced by the
-- database rather than by a read-then-write check in application code.
CREATE UNIQUE INDEX IF NOT EXISTS "AppUnlockTotpClaim_userId_step_key"
    ON "AppUnlockTotpClaim"("userId", "step");

-- Supports the bounded cleanup of claims older than the replay window.
CREATE INDEX IF NOT EXISTS "AppUnlockTotpClaim_userId_createdAt_idx"
    ON "AppUnlockTotpClaim"("userId", "createdAt");
