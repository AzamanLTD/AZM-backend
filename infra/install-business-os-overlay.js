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

const logger = require('../src/config/logger');
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


// ── BusinessTable.metadata (Module 04 — floor plan coordinates) ──────────────
STATEMENTS.push('ALTER TABLE "BusinessTable" ADD COLUMN IF NOT EXISTS "metadata" JSONB;');

// ── RestaurantWaitlistEntry (Module 04) ──────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "RestaurantWaitlistEntry" (
    "id"                TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "locationId"         TEXT,
    "partyName"          VARCHAR(100) NOT NULL,
    "phone"              VARCHAR(20),
    "partySize"          INTEGER NOT NULL DEFAULT 2,
    "quotedWaitMinutes"  INTEGER,
    "status"             VARCHAR(20) NOT NULL DEFAULT 'WAITING',
    "notifiedAt"         TIMESTAMP(3),
    "seatedAt"           TIMESTAMP(3),
    "tableId"            TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RestaurantWaitlistEntry_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "RestaurantWaitlistEntry_businessProfileId_status_idx" ON "RestaurantWaitlistEntry"("businessProfileId", "status");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "RestaurantWaitlistEntry_locationId_status_idx" ON "RestaurantWaitlistEntry"("locationId", "status");');

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'RestaurantWaitlistEntry_businessProfileId_fkey') THEN
      ALTER TABLE "RestaurantWaitlistEntry" ADD CONSTRAINT "RestaurantWaitlistEntry_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'RestaurantWaitlistEntry_locationId_fkey') THEN
      ALTER TABLE "RestaurantWaitlistEntry" ADD CONSTRAINT "RestaurantWaitlistEntry_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id");
    END IF;
  END $$;`);

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'RestaurantWaitlistEntry_tableId_fkey') THEN
      ALTER TABLE "RestaurantWaitlistEntry" ADD CONSTRAINT "RestaurantWaitlistEntry_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "BusinessTable"("id");
    END IF;
  END $$;`);


// ── Phase 2: Offline POS additions ──────────────────────────────────────────
// BusinessEmployee.pinCode (hashed PIN for kiosk clock-in/out)
STATEMENTS.push('ALTER TABLE "BusinessEmployee" ADD COLUMN IF NOT EXISTS "pinCode" VARCHAR(255);');

// BusinessOrder payment method + idempotency
STATEMENTS.push('ALTER TABLE "BusinessOrder" ADD COLUMN IF NOT EXISTS "paymentMethod" VARCHAR(20);');
STATEMENTS.push('ALTER TABLE "BusinessOrder" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;');
STATEMENTS.push('ALTER TABLE "BusinessOrder" ADD COLUMN IF NOT EXISTS "cashReceived" DECIMAL(20,8);');
STATEMENTS.push('ALTER TABLE "BusinessOrder" ADD COLUMN IF NOT EXISTS "cashChange" DECIMAL(20,8);');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "BusinessOrder_idempotencyKey_key" ON "BusinessOrder"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;');

// DineInTab payment method + idempotency
STATEMENTS.push('ALTER TABLE "DineInTab" ADD COLUMN IF NOT EXISTS "paymentMethod" VARCHAR(20);');
STATEMENTS.push('ALTER TABLE "DineInTab" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;');
STATEMENTS.push('ALTER TABLE "DineInTab" ADD COLUMN IF NOT EXISTS "cashReceived" DECIMAL(20,8);');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "DineInTab_idempotencyKey_key" ON "DineInTab"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;');

// BusinessInvoice payment method + idempotency
STATEMENTS.push('ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "paymentMethod" VARCHAR(20);');
STATEMENTS.push('ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "BusinessInvoice_idempotencyKey_key" ON "BusinessInvoice"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;');


// ── Phase 2: In-portal messaging (Section 3) ────────────────────────────────
STATEMENTS.push('ALTER TYPE "ConversationType" ADD VALUE IF NOT EXISTS \'BUSINESS\';');

STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "BusinessConversation" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "businessProfileId" TEXT NOT NULL REFERENCES "BusinessProfile"("id") ON DELETE CASCADE,
    "conversationId" TEXT NOT NULL UNIQUE REFERENCES "Conversation"("id") ON DELETE CASCADE,
    "participantAId" INTEGER NOT NULL REFERENCES "User"("id"),
    "participantBId" INTEGER NOT NULL REFERENCES "User"("id"),
    "createdBy" INTEGER NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
    "lastMessagePreview" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMP(3) NOT NULL
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessConversation_businessProfileId_idx" ON "BusinessConversation"("businessProfileId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessConversation_participantAId_idx" ON "BusinessConversation"("participantAId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessConversation_participantBId_idx" ON "BusinessConversation"("participantBId");');

// =============================================================================
//  Execute all statements sequentially (autocommit — can't use $transaction
//  because ALTER TYPE ADD VALUE must not be in a transaction block, and DO
//  blocks behave more predictably in autocommit).
// =============================================================================
async function main() {
  logger.info(`[business-os-overlay] Running ${STATEMENTS.length} DDL statements…`);
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
        logger.info(`  [skip] ${preview}… (${msg.slice(0, 60)})`);
      } else {
        errors.push({ stmt: preview, error: msg });
        logger.error(`  [ERR]  ${preview}…`);
        logger.error(`        ${msg.slice(0, 200)}`);
      }
    }
  }

  logger.info(`[business-os-overlay] Done: ${ok} applied, ${skipped} skipped, ${errors.length} errors.`);
  if (errors.length) {
    logger.error('[business-os-overlay] ⚠ Errors occurred — review above.');
  }
}


// ── Module 05: TransitRouteTemplate table ───────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "TransitRouteTemplate" (
    "id"                  TEXT NOT NULL,
    "businessProfileId"   TEXT NOT NULL,
    "name"                VARCHAR(200) NOT NULL,
    "origin"              VARCHAR(255) NOT NULL,
    "destination"         VARCHAR(255) NOT NULL,
    "typicalFareUsdc"     DECIMAL(20,8) NOT NULL DEFAULT 0,
    "typicalDurationMins" INTEGER,
    "vehicleId"           TEXT,
    "defaultDepartureTimes" JSONB,
    "notes"               TEXT,
    "isActive"            BOOLEAN NOT NULL DEFAULT true,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransitRouteTemplate_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "TransitRouteTemplate_businessProfileId_idx" ON "TransitRouteTemplate"("businessProfileId");');

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'TransitRouteTemplate_businessProfileId_fkey') THEN
      ALTER TABLE "TransitRouteTemplate" ADD CONSTRAINT "TransitRouteTemplate_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'TransitRouteTemplate_vehicleId_fkey') THEN
      ALTER TABLE "TransitRouteTemplate" ADD CONSTRAINT "TransitRouteTemplate_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "TransitVehicle"("id") ON DELETE SET NULL;
    END IF;
  END $$;`);

// ── Module 05: CargoParcel.proofOfDeliveryUrl ────────────────────────────────
STATEMENTS.push('ALTER TABLE "CargoParcel" ADD COLUMN IF NOT EXISTS "proofOfDeliveryUrl" TEXT;');



// ── Module 06: BusinessTaxPreset table ──────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "BusinessTaxPreset" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "businessProfileId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" TEXT NOT NULL,
    "value" DECIMAL(10,4) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessTaxPreset_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessTaxPreset_businessProfileId_idx" ON "BusinessTaxPreset"("businessProfileId");');

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'BusinessTaxPreset_businessProfileId_fkey') THEN
      ALTER TABLE "BusinessTaxPreset" ADD CONSTRAINT "BusinessTaxPreset_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── Module 06: BusinessProfile.allowOverbooking ─────────────────────────────
STATEMENTS.push('ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "allowOverbooking" BOOLEAN NOT NULL DEFAULT false;');


main()
  .catch((e) => {
    logger.error('[business-os-overlay] Fatal:', e);
    // Never crash the server — this is a best-effort installer.
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

// ── Module 04 additions (loaded via STATEMENTS push above) ─────────────────
// These are added to the STATEMENTS array via require hook below.

// ── Module 07: RecurringExpenseTemplate table ───────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "RecurringExpenseTemplate" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "businessProfileId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "description" VARCHAR(500),
    "frequency" VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
    "dayOfMonth" INTEGER,
    "dayOfWeek" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastPostedAt" TIMESTAMP(3),
    "nextDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringExpenseTemplate_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "RecurringExpenseTemplate_businessProfileId_isActive_idx" ON "RecurringExpenseTemplate"("businessProfileId", "isActive");');

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'RecurringExpenseTemplate_businessProfileId_fkey') THEN
      ALTER TABLE "RecurringExpenseTemplate" ADD CONSTRAINT "RecurringExpenseTemplate_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── Module 08: BusinessPromotion table ───────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "BusinessPromotion" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "businessProfileId" TEXT NOT NULL,
    "code" VARCHAR(50),
    "name" VARCHAR(120) NOT NULL,
    "discountType" VARCHAR(20) NOT NULL,
    "discountValue" DECIMAL(10,4) NOT NULL,
    "buyQuantity" INTEGER,
    "getQuantity" INTEGER,
    "scope" VARCHAR(30) NOT NULL,
    "minSpendUsdc" DECIMAL(20,8),
    "applicableProductIds" TEXT[] NOT NULL DEFAULT '{}',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "usageLimit" INTEGER,
    "perCustomerLimit" INTEGER,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessPromotion_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessPromotion_businessProfileId_isActive_idx" ON "BusinessPromotion"("businessProfileId", "isActive");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessPromotion_code_idx" ON "BusinessPromotion"("code");');

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'BusinessPromotion_businessProfileId_fkey') THEN
      ALTER TABLE "BusinessPromotion" ADD CONSTRAINT "BusinessPromotion_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── Module 08: BusinessReview businessResponse fields ────────────────────────
STATEMENTS.push('ALTER TABLE "BusinessReview" ADD COLUMN IF NOT EXISTS "businessResponse" VARCHAR(1000);');
STATEMENTS.push('ALTER TABLE "BusinessReview" ADD COLUMN IF NOT EXISTS "businessResponseAt" TIMESTAMP(3);');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessReview_businessProfileId_createdAt_idx" ON "BusinessReview"("businessProfileId", "createdAt" DESC);');
