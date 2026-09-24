#!/usr/bin/env node
// Production is db-push baselined, not migrate-deploy baselined. The same
// additive table also exists in schema.prisma for disposable db-push CI.
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const ddl = [
  `CREATE TABLE IF NOT EXISTS "InventoryRestockOperation" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "result" JSONB,
    "ledgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryRestockOperation_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "InventoryRestockOperation_businessProfileId_idempotencyKey_key"
    ON "InventoryRestockOperation"("businessProfileId", "idempotencyKey")`,
  `CREATE INDEX IF NOT EXISTS "InventoryRestockOperation_itemId_idx" ON "InventoryRestockOperation"("itemId")`,
  // r40 — fingerprint versioning (v1 float digest -> v2 exact-decimal digest)
  `ALTER TABLE "InventoryRestockOperation" ADD COLUMN IF NOT EXISTS "fingerprintVersion" INTEGER NOT NULL DEFAULT 1`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='InventoryRestockOperation_businessProfileId_fkey') THEN
    ALTER TABLE "InventoryRestockOperation" ADD CONSTRAINT "InventoryRestockOperation_businessProfileId_fkey"
      FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='InventoryRestockOperation_itemId_fkey') THEN
    ALTER TABLE "InventoryRestockOperation" ADD CONSTRAINT "InventoryRestockOperation_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF; END $$`,
  // r40.4 — SERVER-OWNED RESTOCK INTENT (final-audit P1 redesign): the
  // durable operation identity whose id doubles as the restock idempotency
  // key. No TTL ever: unresolved intents stay resolvable until there is
  // authoritative evidence of resolution. Same additive pattern as above.
  `CREATE TABLE IF NOT EXISTS "InventoryRestockIntent" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" VARCHAR(64) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "executionResult" JSONB,
    "executedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventoryRestockIntent_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "InventoryRestockIntent_businessProfileId_status_idx"
    ON "InventoryRestockIntent"("businessProfileId", "status")`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='InventoryRestockIntent_businessProfileId_fkey') THEN
    ALTER TABLE "InventoryRestockIntent" ADD CONSTRAINT "InventoryRestockIntent_businessProfileId_fkey"
      FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF; END $$`,
];
(async () => {
  try {
    for (const statement of ddl) await db.$executeRawUnsafe(statement);
    // r40.4 post-install check: the intent table exists with its recovery
    // index and the guarded status column default.
    const check = await db.$queryRawUnsafe(`SELECT
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='InventoryRestockIntent') AS table_ok,
        (SELECT COUNT(*) FROM pg_indexes WHERE indexname='InventoryRestockIntent_businessProfileId_status_idx') AS index_ok,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='InventoryRestockIntent' AND column_name='status' AND column_default LIKE '%PENDING%') AS default_ok`);
    const row = Array.isArray(check) ? check[0] : check;
    if (Number(row.table_ok) !== 1 || Number(row.index_ok) !== 1 || Number(row.default_ok) !== 1) {
      throw new Error('InventoryRestockIntent post-install check failed: ' + JSON.stringify(row));
    }
    console.log('[inventory-restock-overlay] installed (incl. InventoryRestockIntent, post-install check ok)');
  }
  finally { await db.$disconnect(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
