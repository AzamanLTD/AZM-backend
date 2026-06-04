-- =============================================================================
-- Migration: User Preferences + Vendor Enhancement Fields
-- Adds theme selection, shortcut customization, and vendor portal preferences
-- =============================================================================

-- Add user preferences fields to User model
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "selectedTheme" TEXT DEFAULT 'dark';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "customShortcuts" JSONB;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "settingsPreferences" JSONB;
