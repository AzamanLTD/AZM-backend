-- Hardening for saved service accounts:
--  * record which service-template version validated the stored fields
--  * constrain verification state in the database, not just in application code

ALTER TABLE "SavedServiceAccount"
  ADD COLUMN "serviceTemplateVersion" VARCHAR(16) NOT NULL DEFAULT '1';

-- Accounts stay UNVERIFIED until a real provider lookup exists. The database
-- refuses anything outside the known ladder, so no code path can invent a
-- "VERIFIED" account by skipping the lookup.
ALTER TABLE "SavedServiceAccount"
  ADD CONSTRAINT "SavedServiceAccount_verificationStatus_check"
  CHECK ("verificationStatus" IN ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED'));

-- A verified row must carry the timestamp that proves when it happened.
ALTER TABLE "SavedServiceAccount"
  ADD CONSTRAINT "SavedServiceAccount_verifiedAt_check"
  CHECK (("verificationStatus" = 'VERIFIED') = ("verifiedAt" IS NOT NULL));
