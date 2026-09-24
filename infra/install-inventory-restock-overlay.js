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
];
(async () => {
  try { for (const statement of ddl) await db.$executeRawUnsafe(statement); console.log('[inventory-restock-overlay] installed'); }
  finally { await db.$disconnect(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
