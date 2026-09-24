#!/usr/bin/env node
// infra/install-e2ee-server-blind-overlay.js
// =============================================================================
// Idempotent DDL overlay for the r40 E2EE architecture (production uses
// `prisma db push` without a migration baseline — see install-business-os-overlay.js).
//
//   • Creates the public-key-only directory: E2EEDevice, E2EEOneTimePreKey
//   • Adds Message.e2eeEnvelope (JSONB)
//   • DROPS the pre-r40 tables that stored SERVER-SIDE PRIVATE key material
//     (E2EEPreKeyBundle, old E2EEOneTimePreKey, E2EESession). This is the
//     security purpose of the overlay: after it runs, no private identity,
//     prekey, root or chain key material exists anywhere in the database.
//     (No production client consumed the old API — the old client/server key
//     models were incompatible — so dropping is data-safe and audited in the PR.)
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STATEMENTS = [
    // Pre-r40 private-material tables: dropped unconditionally (nothing but
    // private keys ever lived in them; no production client consumed them).
    `DROP TABLE IF EXISTS "E2EESession"`,
    `DROP TABLE IF EXISTS "E2EEPreKeyBundle"`,
    // The pre-r40 one-time prekey table has the SAME name as the new public-only
    // table but a different shape (it carried "privateKey"). Drop it ONLY when
    // the old shape is present so re-runs never destroy live claimed keys.
    `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'E2EEOneTimePreKey' AND column_name = 'privateKey') THEN
            DROP TABLE "E2EEOneTimePreKey";
        END IF;
    END $$;`,
    `CREATE TABLE IF NOT EXISTS "E2EEDevice" (
        "id" TEXT NOT NULL,
        "userId" INTEGER NOT NULL,
        "deviceId" VARCHAR(128) NOT NULL,
        "signingPublicKey" VARCHAR(100) NOT NULL,
        "identityPublicKey" VARCHAR(100) NOT NULL,
        "bindingSignature" VARCHAR(200) NOT NULL,
        "signedPreKeyId" INTEGER NOT NULL,
        "signedPreKeyPublicKey" VARCHAR(100) NOT NULL,
        "signedPreKeySignature" VARCHAR(200) NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "E2EEDevice_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "E2EEDevice_userId_deviceId_key"
       ON "E2EEDevice"("userId", "deviceId")`,
    `CREATE INDEX IF NOT EXISTS "E2EEDevice_userId_isActive_idx"
       ON "E2EEDevice"("userId", "isActive")`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'E2EEDevice_userId_fkey') THEN
            ALTER TABLE "E2EEDevice" ADD CONSTRAINT "E2EEDevice_userId_fkey"
              FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
        END IF;
    END $$;`,
    `CREATE TABLE IF NOT EXISTS "E2EEOneTimePreKey" (
        "id" TEXT NOT NULL,
        "userId" INTEGER NOT NULL,
        "keyId" INTEGER NOT NULL,
        "publicKey" VARCHAR(100) NOT NULL,
        "isUsed" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "usedAt" TIMESTAMP(3),
        CONSTRAINT "E2EEOneTimePreKey_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "E2EEOneTimePreKey_userId_keyId_key"
       ON "E2EEOneTimePreKey"("userId", "keyId")`,
    `CREATE INDEX IF NOT EXISTS "E2EEOneTimePreKey_userId_isUsed_idx"
       ON "E2EEOneTimePreKey"("userId", "isUsed")`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'E2EEOneTimePreKey_userId_fkey') THEN
            ALTER TABLE "E2EEOneTimePreKey" ADD CONSTRAINT "E2EEOneTimePreKey_userId_fkey"
              FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
        END IF;
    END $$;`,
    `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "e2eeEnvelope" JSONB`,
];

async function install() {
    let applied = 0;
    for (const statement of STATEMENTS) {
        try {
            await prisma.$executeRawUnsafe(statement);
            applied += 1;
        } catch (error) {
            console.error('FAILED:', error.message, '|', statement.slice(0, 80));
            throw error;
        }
    }
    console.log(`E2EE server-blind overlay installed: ${applied} statements applied.`);
}

if (require.main === module) {
    install().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
module.exports = { install };
