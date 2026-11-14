-- GlobalSettings.nativeGhsSettlementEnabled — additive, default OFF.
--
-- The column already exists in schema.prisma and in the release overlay
-- (infra/install-native-ghs-settlement-overlay.js), but no migration ever added
-- it, so a migrate-based provisioning path had a schema gap: the settlement
-- reader would fail closed to disabled (safe) and any write that sets the flag
-- would error. This closes that gap without changing behaviour.
--
-- Idempotent by construction: ADD COLUMN IF NOT EXISTS is a no-op on the
-- long-lived databases where the overlay already created the column.
-- Values are preserved because there is no UPDATE and no SET DEFAULT that
-- rewrites existing rows; the default applies only to future inserts.
ALTER TABLE "GlobalSettings"
  ADD COLUMN IF NOT EXISTS "nativeGhsSettlementEnabled" BOOLEAN NOT NULL DEFAULT false;
