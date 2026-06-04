-- Add DAILY to the SusuFrequency enum (Susu Sprint follow-up, 2026-06-01).
-- Postgres requires ALTER TYPE ... ADD VALUE for enum extensions; this is a
-- forward-only, non-destructive change. `IF NOT EXISTS` makes it idempotent
-- so re-running the migration (or applying over an already-patched DB) is
-- safe.
ALTER TYPE "SusuFrequency" ADD VALUE IF NOT EXISTS 'DAILY' BEFORE 'WEEKLY';
