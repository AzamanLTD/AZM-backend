-- CreateTable: RoundUpSettings
CREATE TABLE "RoundUpSettings" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"          INTEGER      NOT NULL,
    "enabled"         BOOLEAN      NOT NULL DEFAULT false,
    "targetVaultId"   TEXT,
    "totalSavedUsdc"  DOUBLE PRECISION NOT NULL DEFAULT 0,
    "multiplier"      DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoundUpSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoundUpSettings_userId_key" ON "RoundUpSettings"("userId");
CREATE UNIQUE INDEX "RoundUpSettings_targetVaultId_key" ON "RoundUpSettings"("targetVaultId");
CREATE INDEX "RoundUpSettings_userId_idx" ON "RoundUpSettings"("userId");

-- AddForeignKey
ALTER TABLE "RoundUpSettings" ADD CONSTRAINT "RoundUpSettings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "RoundUpSettings" ADD CONSTRAINT "RoundUpSettings_targetVaultId_fkey"
    FOREIGN KEY ("targetVaultId") REFERENCES "Vault"("id") ON DELETE SET NULL;

-- AddEnumValue: ROUND_UP to VaultDepositType
ALTER TYPE "VaultDepositType" ADD VALUE IF NOT EXISTS 'ROUND_UP';
