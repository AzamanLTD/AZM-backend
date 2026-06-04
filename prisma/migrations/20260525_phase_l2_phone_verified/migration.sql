-- Phase L2: Add phoneVerified flag to User model
-- Gates SMS sends (withdrawal confirmations, future trade alerts) to only
-- OTP-verified phone numbers. Defaults to false for all existing rows.

ALTER TABLE "User" ADD COLUMN "phoneVerified" BOOLEAN NOT NULL DEFAULT false;
