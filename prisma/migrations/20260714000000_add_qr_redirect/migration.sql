-- Add QR redirect URL to GlobalSettings
ALTER TABLE "GlobalSettings" ADD COLUMN IF NOT EXISTS "qrRedirectUrl" TEXT NOT NULL DEFAULT 'https://startup.moolre.com/leaderboard/118';
ALTER TABLE "GlobalSettings" ADD COLUMN IF NOT EXISTS "qrLabel" TEXT NOT NULL DEFAULT 'Azaman Vote Page';
