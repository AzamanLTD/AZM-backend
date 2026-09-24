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
//
// PRODUCTION SAFETY (P1-K) — read before running in production:
//   • The WHOLE transformation runs in ONE database transaction. If any
//     statement fails, NOTHING is applied and the schema is left untouched
//     (verified by the post-install verification below). There is no
//     half-applied state.
//   • The dropped tables contain ONLY cryptographic key material, never
//     user content or financial data. The one-time-prekey drop is conditional
//     on the old shape (privateKey column) so re-runs never destroy live
//     claimed keys.
//   • Rollback expectation: before running in production, take the usual
//     pre-release backup. Rollback = restore backup or re-create the legacy
//     tables from the schema history (they are never written again).
//   • Post-install verification: this script verifies the target state after
//     commit (new tables present, deviceId binding, one-active-device unique
//     index, no private-key columns anywhere) and FAILS on any mismatch.
//   • Old-client dependency: the old API surface (/api/e2ee/keys/init and
//     the session-key routes) is removed in the same release as this overlay;
//     the only pre-r40 client file that called it (Flutter e2ee_service.dart)
//     is dead code with zero importers and is deleted in the same wave.
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
        "deviceId" VARCHAR(128) NOT NULL,
        "keyId" INTEGER NOT NULL,
        "publicKey" VARCHAR(100) NOT NULL,
        "isUsed" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "usedAt" TIMESTAMP(3),
        CONSTRAINT "E2EEOneTimePreKey_pkey" PRIMARY KEY ("id")
    )`,
    // r40.1: in-place upgrade for deployments that already ran the r40
    // overlay (table exists without deviceId). Fresh installs create it in
    // the CREATE TABLE above; this is a no-op there.
    `ALTER TABLE "E2EEOneTimePreKey" ADD COLUMN IF NOT EXISTS "deviceId" VARCHAR(128) NOT NULL DEFAULT ''`,

    // r40.2 (audit finding 3): keyId uniqueness is DEVICE-scoped —
    // (userId, deviceId, keyId). A fresh device starts its own key-id
    // sequence: Device B's keyId=1 must not collide with retired Device A's
    // keyId=1. The r40.1 user-scoped index is dropped first; deployments
    // that already have it are migrated in place (idempotent).
    `DROP INDEX IF EXISTS "E2EEOneTimePreKey_userId_keyId_key"`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "E2EEOneTimePreKey_userId_deviceId_keyId_key"
       ON "E2EEOneTimePreKey"("userId", "deviceId", "keyId")`,
    `CREATE INDEX IF NOT EXISTS "E2EEOneTimePreKey_userId_deviceId_isUsed_idx"
       ON "E2EEOneTimePreKey"("userId", "deviceId", "isUsed")`,
    // r40.1 (P0-C): one-time prekeys are device-scoped. Existing deployments
    // upgraded in place get the column added; fresh installs create it.
    `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'E2EEOneTimePreKey' AND column_name = 'deviceId') THEN
            UPDATE "E2EEOneTimePreKey" SET "deviceId" = d."deviceId"
            FROM "E2EEDevice" d
            WHERE "E2EEOneTimePreKey"."userId" = d."userId" AND d."isActive" = true
              AND "E2EEOneTimePreKey"."deviceId" = '';
        END IF;
    END $$;`,
    // r40.1 (P0-C): storage-layer invariant — AT MOST ONE ACTIVE DEVICE PER
    // USER. Partial unique index; registerDevice relies on it for
    // concurrency safety (P2002 retry).
    `CREATE UNIQUE INDEX IF NOT EXISTS "E2EEDevice_one_active_per_user"
       ON "E2EEDevice"("userId") WHERE "isActive"`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'E2EEOneTimePreKey_userId_fkey') THEN
            ALTER TABLE "E2EEOneTimePreKey" ADD CONSTRAINT "E2EEOneTimePreKey_userId_fkey"
              FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
        END IF;
    END $$;`,
    `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "e2eeEnvelope" JSONB`,
];

async function install(client) {
    const db = client || prisma;
    let applied = 0;
    // P1-K: the entire transformation is ONE transaction — all-or-nothing.
    // A failure anywhere rolls back EVERYTHING (including the drops).
    await db.$transaction(async (tx) => {
        for (const statement of STATEMENTS) {
            try {
                await tx.$executeRawUnsafe(statement);
                applied += 1;
            } catch (error) {
                console.error('FAILED (rolling back everything):', error.message, '|', statement.slice(0, 80));
                throw error;
            }
        }
    }, { timeout: 30000 });

    // Post-install verification (P1-K): prove the target state, fail loudly.
    const checks = await db.$queryRaw`
        SELECT
            (SELECT COUNT(*) FROM information_schema.tables
             WHERE table_name IN ('E2EEDevice','E2EEOneTimePreKey')) AS new_tables,
            (SELECT COUNT(*) FROM information_schema.tables
             WHERE table_name IN ('E2EESession','E2EEPreKeyBundle')) AS dropped_tables,
            (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_name = 'E2EEOneTimePreKey' AND column_name = 'deviceId') AS otp_device_binding,
            (SELECT COUNT(*) FROM pg_indexes
             WHERE indexname = 'E2EEDevice_one_active_per_user') AS one_active_idx,
            (SELECT COUNT(*) FROM pg_indexes
             WHERE indexname = 'E2EEOneTimePreKey_userId_deviceId_keyId_key') AS otp_device_scoped_uniq,
            (SELECT COUNT(*) FROM pg_indexes
             WHERE indexname = 'E2EEOneTimePreKey_userId_keyId_key') AS legacy_user_scoped_uniq,
            (SELECT COUNT(*) FROM information_schema.columns
             WHERE column_name IN ('privateKey','activeRootKey','activeChainKey','identityPrivateKey',
                                   'signedPreKeyPrivateKey','sendingChainKey','receivingChainKey')) AS private_columns,
            (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_name = 'Message' AND column_name = 'e2eeEnvelope') AS envelope_col`;
    const c = checks[0];
    const problems = [];
    if (Number(c.new_tables) !== 2) problems.push('directory tables missing');
    if (Number(c.dropped_tables) !== 0) problems.push('legacy private-key tables still present');
    if (Number(c.otp_device_binding) !== 1) problems.push('OTP deviceId binding missing');
    if (Number(c.one_active_idx) !== 1) problems.push('one-active-device index missing');
    if (Number(c.otp_device_scoped_uniq) !== 1) problems.push('device-scoped OTP keyId uniqueness index missing (r40.2)');
    if (Number(c.legacy_user_scoped_uniq) !== 0) problems.push('legacy user-scoped OTP keyId unique index still present (r40.2)');
    if (Number(c.private_columns) !== 0) problems.push('private-key columns remain in schema');
    if (Number(c.envelope_col) !== 1) problems.push('Message.e2eeEnvelope missing');
    if (problems.length) throw new Error('E2EE overlay verification FAILED: ' + problems.join('; '));
    console.log(`E2EE server-blind overlay installed: ${applied} statements applied, all 8 post-install checks passed.`);
}

if (require.main === module) {
    install().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
module.exports = { install };
