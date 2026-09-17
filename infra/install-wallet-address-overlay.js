#!/usr/bin/env node
// Idempotent additive installer for the WalletAddress authority table
// (financial architecture §P.1, 2026-09-17).
//
// Production is db-push managed, so the partial unique index and the legacy
// backfill — neither of which Prisma db push can express or run — are installed
// idempotently here at boot (mirrored by
// prisma/migrations/20260917150000_wallet_address_authority/migration.sql).
// Running this installer repeatedly is safe: every statement is IF NOT EXISTS /
// ON CONFLICT DO NOTHING.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const NATIVE_USDC_CONTRACT = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

const STATEMENTS = [
  `DO $$ BEGIN
    CREATE TYPE "WalletAddressStatus" AS ENUM ('ACTIVE', 'RETIRED');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `CREATE TABLE IF NOT EXISTS "WalletAddress" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "network" VARCHAR(20) NOT NULL DEFAULT 'POLYGON',
    "asset" VARCHAR(20) NOT NULL DEFAULT 'USDC',
    "contractAddress" VARCHAR(42) NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "derivationIndex" INTEGER,
    "status" "WalletAddressStatus" NOT NULL DEFAULT 'ACTIVE',
    "subscriptionId" VARCHAR(100),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3),
    "lastSweepAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WalletAddress_pkey" PRIMARY KEY ("id")
  );`,
  `DO $$ BEGIN
    ALTER TABLE "WalletAddress"
      ADD CONSTRAINT "WalletAddress_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "WalletAddress_address_network_key"
    ON "WalletAddress"("address", "network");`,
  `CREATE INDEX IF NOT EXISTS "WalletAddress_userId_network_contractAddress_status_idx"
    ON "WalletAddress"("userId", "network", "contractAddress", "status");`,
  `CREATE INDEX IF NOT EXISTS "WalletAddress_status_network_idx"
    ON "WalletAddress"("status", "network");`,
  // The DB-enforced concurrency authority for allocation races: exactly one
  // ACTIVE address per user + network + canonical asset. Prisma cannot express
  // partial unique indexes; db push may drop it, so boot reinstalls it.
  `CREATE UNIQUE INDEX IF NOT EXISTS "WalletAddress_one_active_per_user_network_asset_idx"
    ON "WalletAddress"("userId", "network", "contractAddress")
    WHERE "status" = 'ACTIVE';`,
];

// Backfill: existing User.tatumPolygonAddress values become ACTIVE canonical
// native-USDC Polygon rows. Addresses are preserved exactly; derivation index
// is deterministically known (rule: derivationIndex = user.id). The legacy
// column is NOT removed and no financial records are touched.
const BACKFILL_SQL = `INSERT INTO "WalletAddress"
    ("id", "userId", "network", "asset", "contractAddress", "address",
     "derivationIndex", "status", "firstSeenAt", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    u."id",
    'POLYGON',
    'USDC',
    '${NATIVE_USDC_CONTRACT}',
    u."tatumPolygonAddress",
    u."id",
    'ACTIVE',
    COALESCE(u."updatedAt", now()),
    now(),
    now()
FROM "User" u
WHERE u."tatumPolygonAddress" IS NOT NULL
ON CONFLICT DO NOTHING;`;

async function installWalletAddressOverlay(client) {
  const db = client || prisma;
  const results = { ok: 0, failed: 0, errors: [], backfilled: 0 };

  for (const sql of STATEMENTS) {
    try {
      await db.$executeRawUnsafe(sql);
      results.ok += 1;
    } catch (err) {
      results.failed += 1;
      const head = sql.split('\n')[0].slice(0, 100);
      results.errors.push(`${head} … → ${err.message.split('\n')[0]}`);
      logger.error(`[install-wallet-address-overlay] ${head}: ${err.message}`);
    }
  }

  try {
    results.backfilled = Number(
      await db.$executeRawUnsafe(BACKFILL_SQL)
    ) || 0;
    results.ok += 1;
  } catch (err) {
    results.failed += 1;
    results.errors.push(`backfill → ${err.message.split('\n')[0]}`);
    logger.error(`[install-wallet-address-overlay] backfill: ${err.message}`);
  }

  return results;
}

module.exports = { installWalletAddressOverlay, NATIVE_USDC_CONTRACT };

if (require.main === module) {
  installWalletAddressOverlay()
    .then((result) => {
      logger.info(`[install-wallet-address-overlay] ${result.ok} ok, ${result.failed} failed`);
      if (result.failed) process.exitCode = 1;
    })
    .catch((err) => {
      logger.error({ err }, '[install-wallet-address-overlay] fatal');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
