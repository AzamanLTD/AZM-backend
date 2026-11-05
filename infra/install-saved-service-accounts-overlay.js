#!/usr/bin/env node
// Saved service accounts: encrypted biller references with keyed fingerprints.
//
// Production (Neon) was provisioned with `prisma db push` and has no
// `_prisma_migrations` baseline, so `prisma migrate deploy` is NOT a release
// path here — the same reason every other finance table ships as an overlay
// installer. This file is the production counterpart of
// prisma/migrations/20261030120000_saved_service_accounts and
// prisma/migrations/20261030200000_saved_service_hardening, and must stay
// byte-equivalent to them in shape. Idempotent: safe to re-run on every deploy.
const { PrismaClient } = require('@prisma/client');

const ddl = [
`CREATE TABLE IF NOT EXISTS "SavedServiceAccount" (
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
);`,
`CREATE UNIQUE INDEX IF NOT EXISTS "SavedServiceAccount_userId_serviceCode_accountFingerprint_key"
  ON "SavedServiceAccount"("userId", "serviceCode", "accountFingerprint");`,
`CREATE INDEX IF NOT EXISTS "SavedServiceAccount_userId_serviceCode_createdAt_idx"
  ON "SavedServiceAccount"("userId", "serviceCode", "createdAt" DESC);`,
`CREATE UNIQUE INDEX IF NOT EXISTS "SavedServiceAccount_one_primary_per_service"
  ON "SavedServiceAccount"("userId", "serviceCode") WHERE "isPrimary" = true;`,
`ALTER TABLE "SavedServiceAccount" ADD COLUMN IF NOT EXISTS "serviceTemplateVersion" VARCHAR(16) NOT NULL DEFAULT '1';`,
// Constraint creation is not idempotent in PostgreSQL, so each one is guarded.
`DO $$ BEGIN
  ALTER TABLE "SavedServiceAccount" ADD CONSTRAINT "SavedServiceAccount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
`DO $$ BEGIN
  ALTER TABLE "SavedServiceAccount" ADD CONSTRAINT "SavedServiceAccount_verificationStatus_check"
    CHECK ("verificationStatus" IN ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
`DO $$ BEGIN
  ALTER TABLE "SavedServiceAccount" ADD CONSTRAINT "SavedServiceAccount_verifiedAt_check"
    CHECK (("verificationStatus" = 'VERIFIED') = ("verifiedAt" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
];

async function apply(prisma) {
    for (const statement of ddl) {
        await prisma.$executeRawUnsafe(statement);
    }
    // Fail the deploy loudly if the table did not reach the expected shape.
    const [{ count }] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'SavedServiceAccount'`);
    if (Number(count) !== 1) {
        throw new Error('saved-service-accounts overlay: SavedServiceAccount was not created');
    }
    return { installed: true };
}

if (require.main === module) {
    const prisma = new PrismaClient();
    apply(prisma)
        .then(() => console.log('[saved-service-accounts] installed'))
        .catch((err) => { console.error('[saved-service-accounts] failed:', err.message); process.exitCode = 1; })
        .finally(() => prisma.$disconnect());
}

module.exports = { ddl, apply };
