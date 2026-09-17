-- WalletAddress authority — financial architecture §P.1 (2026-09-17)
-- Additive and history-preserving. Production is db-push managed (schema.prisma
-- owns the base DDL); this file is the migration-deploy record AND the
-- idempotent installer used by the test suite / manual rehearsal. It mirrors
-- infra/install-wallet-address-overlay.js exactly.

-- Idempotent enum
DO $$ BEGIN
    CREATE TYPE "WalletAddressStatus" AS ENUM ('ACTIVE', 'RETIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotent base table (matches the schema.prisma model)
CREATE TABLE IF NOT EXISTS "WalletAddress" (
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
);

-- Foreign key (RESTRICT: address history must survive; user rows are never hard-deleted by financial flows)
DO $$ BEGIN
    ALTER TABLE "WalletAddress"
        ADD CONSTRAINT "WalletAddress_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Canonical address identity: one address string belongs to exactly one registry row per network.
CREATE UNIQUE INDEX IF NOT EXISTS "WalletAddress_address_network_key"
    ON "WalletAddress"("address", "network");

CREATE INDEX IF NOT EXISTS "WalletAddress_userId_network_contractAddress_status_idx"
    ON "WalletAddress"("userId", "network", "contractAddress", "status");

CREATE INDEX IF NOT EXISTS "WalletAddress_status_network_idx"
    ON "WalletAddress"("status", "network");

-- One ACTIVE deposit address per user + network + canonical asset (the DB-enforced
-- concurrency authority for allocation races). Prisma cannot express partial
-- unique indexes, so this lives here + in the boot overlay installer.
CREATE UNIQUE INDEX IF NOT EXISTS "WalletAddress_one_active_per_user_network_asset_idx"
    ON "WalletAddress"("userId", "network", "contractAddress")
    WHERE "status" = 'ACTIVE';

-- Backfill: every existing User.tatumPolygonAddress becomes an ACTIVE canonical
-- native-USDC Polygon WalletAddress. The address is preserved EXACTLY as stored
-- (wallet allocation already persisted lowercase). The derivation index is
-- deterministically known from the established rule derivationIndex = user.id.
-- User.tatumPolygonAddress is NOT removed and no financial records are touched.
INSERT INTO "WalletAddress"
    ("id", "userId", "network", "asset", "contractAddress", "address",
     "derivationIndex", "status", "firstSeenAt", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    u."id",
    'POLYGON',
    'USDC',
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    u."tatumPolygonAddress",
    u."id",
    'ACTIVE',
    COALESCE(u."updatedAt", now()),
    now(),
    now()
FROM "User" u
WHERE u."tatumPolygonAddress" IS NOT NULL
ON CONFLICT DO NOTHING;
