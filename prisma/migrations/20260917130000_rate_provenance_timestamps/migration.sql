-- Rate provenance timestamps (issue #271 / PR 271B): truthful rate
-- provenance/freshness.
--
-- Additive only: three nullable provenance columns on GlobalSettings.
--   lastExternalSync → most recent successful EXTERNAL market observation
--                      (oracle or gateway LIVE Kotani). Canonical freshness
--                      field for the future 271C stale-rate gate.
--   lastAdminSetAt   → most recent manual admin rate override (provenance
--                      label only — never refreshes external freshness).
--   lastEchoAt       → most recent MOCK gateway echo (cached-value copy —
--                      never refreshes external freshness).
--
-- Deliberately NOT backfilled: historical lastRateSync values may be
-- contaminated by the pre-271B MOCK echo / admin re-stamp, so manufacturing
-- external timestamps from them would fabricate freshness. Existing rows keep
-- lastExternalSync = NULL until a genuine external observation succeeds.
--
-- No historical quote rows are rewritten, no balances or financial records
-- are touched, and all existing positivity CHECK constraints are preserved.

ALTER TABLE "GlobalSettings" ADD COLUMN "lastExternalSync" TIMESTAMP(3);
ALTER TABLE "GlobalSettings" ADD COLUMN "lastAdminSetAt" TIMESTAMP(3);
ALTER TABLE "GlobalSettings" ADD COLUMN "lastEchoAt" TIMESTAMP(3);
