-- =============================================================================
-- SAVED MOMO ACCOUNTS  (Master Sprint v2, 2026-05-27)
-- =============================================================================
CREATE TABLE "SavedMomoAccount" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "nickname" VARCHAR(40) NOT NULL,
    "provider" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "accountName" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SavedMomoAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SavedMomoAccount_userId_phoneNumber_key" ON "SavedMomoAccount"("userId", "phoneNumber");
CREATE INDEX "SavedMomoAccount_userId_idx" ON "SavedMomoAccount"("userId");
ALTER TABLE "SavedMomoAccount" ADD CONSTRAINT "SavedMomoAccount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
