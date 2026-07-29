-- AlterTable: Add notificationPrefs column to User table
ALTER TABLE "User" ADD COLUMN "notificationPrefs" JSONB;
