-- Phase Q15: App Version Gate
-- Admin controls minimum supported app version. Clients check on startup.

ALTER TABLE "GlobalSettings" ADD COLUMN "minAppVersion" TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE "GlobalSettings" ADD COLUMN "forceUpdateUrl" TEXT NOT NULL DEFAULT 'https://play.google.com/store/apps/details?id=com.azaman.app';
ALTER TABLE "GlobalSettings" ADD COLUMN "updateMessage" TEXT NOT NULL DEFAULT 'A new version of Azaman is available. Please update to continue.';
