-- WS4: admin business moderation — suspend/unsuspend a BusinessProfile.
-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN     "isSuspended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "suspendReason" VARCHAR(500);
