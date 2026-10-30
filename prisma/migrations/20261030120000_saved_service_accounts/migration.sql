-- Saved service accounts: encrypted account references, keyed fingerprints.
CREATE TABLE "SavedServiceAccount" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "serviceCode" VARCHAR(64) NOT NULL,
    "providerCode" VARCHAR(64) NOT NULL,
    "nickname" VARCHAR(64) NOT NULL,
    "accountDataCiphertext" TEXT NOT NULL,
    "accountDataKeyVersion" VARCHAR(16) NOT NULL,
    "accountFingerprint" CHAR(64) NOT NULL,
    "accountMask" VARCHAR(32) NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SavedServiceAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SavedServiceAccount_userId_serviceCode_accountFingerprint_key"
  ON "SavedServiceAccount"("userId", "serviceCode", "accountFingerprint");
CREATE INDEX "SavedServiceAccount_userId_serviceCode_createdAt_idx"
  ON "SavedServiceAccount"("userId", "serviceCode", "createdAt" DESC);
-- At most one primary per member per service, enforced by the database so two
-- concurrent "make primary" calls cannot both win.
CREATE UNIQUE INDEX "SavedServiceAccount_one_primary_per_service"
  ON "SavedServiceAccount"("userId", "serviceCode") WHERE "isPrimary" = true;

ALTER TABLE "SavedServiceAccount" ADD CONSTRAINT "SavedServiceAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
