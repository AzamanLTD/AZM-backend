#!/usr/bin/env node
// infra/install-business-os-overlay.js
// =============================================================================
// Idempotent, NON-DESTRUCTIVE installer for the Business OS schema additions
// from Modules 01 (Governance) and 03 (Hotels).
//
// Why this exists: production Neon was provisioned with `prisma db push`
// (no `_prisma_migrations` baseline), so `prisma migrate deploy` aborts
// with P3005. The existing susu-overlay installer pattern (plain DDL with
// IF NOT EXISTS guards) is reused here for the business-portal additions.
//
// All statements are additive (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF
// NOT EXISTS, CREATE INDEX IF NOT EXISTS) — no drops, no renames, no
// alterations. Safe to run repeatedly.
//
// Schema additions installed:
//   • BusinessProfile.isPausedByOwner  (boolean, default false)
//   • BusinessLocationHoursException    table + indexes + FK
//   • BusinessNotificationPreference   table + indexes + FK
//   • HotelRateOverride                 table + indexes + FK
//   • HotelRoomBlock                    table + indexes + FK
//
// Usage:  node infra/install-business-os-overlay.js
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STATEMENTS = [];

// ── BusinessProfile.isPausedByOwner ────────────────────────────────────────
STATEMENTS.push(
  `ALTER TABLE "BusinessProfile"
   ADD COLUMN IF NOT EXISTS "isPausedByOwner" BOOLEAN NOT NULL DEFAULT false;`
);

// ── BusinessLocationHoursException ──────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "BusinessLocationHoursException" (
    "id"        TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "date"      DATE NOT NULL,
    "isClosed"  BOOLEAN NOT NULL DEFAULT false,
    "openTime"  VARCHAR(10),
    "closeTime" VARCHAR(10),
    "note"      VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessLocationHoursException_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push(
  `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessLocationHoursException_locationId_date_key"
   ON "BusinessLocationHoursException"("locationId", "date");`
);
STATEMENTS.push(
  `CREATE INDEX IF NOT EXISTS "BusinessLocationHoursException_locationId_idx"
   ON "BusinessLocationHoursException"("locationId");`
);
// Foreign key — only add if not already present
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'BusinessLocationHoursException_locationId_fkey'
    ) THEN
      ALTER TABLE "BusinessLocationHoursException"
        ADD CONSTRAINT "BusinessLocationHoursException_locationId_fkey"
        FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id")
        ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── BusinessNotificationPreference ──────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "BusinessNotificationPreference" (
    "id"                TEXT NOT NULL,
    "businessProfileId"  TEXT NOT NULL,
    "preferences"        JSONB NOT NULL DEFAULT '{}',
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessNotificationPreference_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push(
  `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessNotificationPreference_businessProfileId_key"
   ON "BusinessNotificationPreference"("businessProfileId");`
);
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'BusinessNotificationPreference_businessProfileId_fkey'
    ) THEN
      ALTER TABLE "BusinessNotificationPreference"
        ADD CONSTRAINT "BusinessNotificationPreference_businessProfileId_fkey"
        FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id")
        ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── HotelRateOverride ───────────────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "HotelRateOverride" (
    "id"                TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "roomType"          VARCHAR(50),
    "roomId"            TEXT,
    "date"              DATE NOT NULL,
    "priceUsdc"         DECIMAL(20,8) NOT NULL,
    "note"              VARCHAR(255),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotelRateOverride_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push(
  `CREATE UNIQUE INDEX IF NOT EXISTS "HotelRateOverride_businessProfileId_roomType_roomId_date_key"
   ON "HotelRateOverride"("businessProfileId", "roomType", "roomId", "date");`
);
STATEMENTS.push(
  `CREATE INDEX IF NOT EXISTS "HotelRateOverride_businessProfileId_date_idx"
   ON "HotelRateOverride"("businessProfileId", "date");`
);
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'HotelRateOverride_businessProfileId_fkey'
    ) THEN
      ALTER TABLE "HotelRateOverride"
        ADD CONSTRAINT "HotelRateOverride_businessProfileId_fkey"
        FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id")
        ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── HotelRoomBlock ──────────────────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "HotelRoomBlock" (
    "id"        TEXT NOT NULL,
    "roomId"    TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate"   DATE NOT NULL,
    "reason"    VARCHAR(255),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotelRoomBlock_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push(
  `CREATE INDEX IF NOT EXISTS "HotelRoomBlock_roomId_startDate_endDate_idx"
   ON "HotelRoomBlock"("roomId", "startDate", "endDate");`
);
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'HotelRoomBlock_roomId_fkey'
    ) THEN
      ALTER TABLE "HotelRoomBlock"
        ADD CONSTRAINT "HotelRoomBlock_roomId_fkey"
        FOREIGN KEY ("roomId") REFERENCES "HotelRoom"("id")
        ON DELETE CASCADE;
    END IF;
  END $$;`);

// =============================================================================
//  Execute all statements sequentially (autocommit — can't use $transaction
//  because ALTER TYPE ADD VALUE must not be in a transaction block, and DO
//  blocks behave more predictably in autocommit).
// =============================================================================
async function main() {
  console.log(`[business-os-overlay] Running ${STATEMENTS.length} DDL statements…`);
  let ok = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < STATEMENTS.length; i++) {
    const stmt = STATEMENTS[i];
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 90);
    try {
      await prisma.$executeRawUnsafe(stmt);
      ok++;
    } catch (err) {
      // "already exists" errors are fine — the guard didn't catch it because
      // of a race or a slightly different object name, but the end state is
      // still correct.
      const msg = String(err.message || err);
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        skipped++;
        console.log(`  [skip] ${preview}… (${msg.slice(0, 60)})`);
      } else {
        errors.push({ stmt: preview, error: msg });
        console.error(`  [ERR]  ${preview}…`);
        console.error(`        ${msg.slice(0, 200)}`);
      }
    }
  }

  console.log(`[business-os-overlay] Done: ${ok} applied, ${skipped} skipped, ${errors.length} errors.`);
  if (errors.length) {
    console.error('[business-os-overlay] ⚠ Errors occurred — review above.');
  }
}

main()
  .catch((e) => {
    console.error('[business-os-overlay] Fatal:', e);
    // Never crash the server — this is a best-effort installer.
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
