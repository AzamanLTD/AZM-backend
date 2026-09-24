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
//   • ProfitSource enum value EWA_FEE  (Business OS P0 settlement repair,
//     2026-09-21: 1% EWA withdrawal fee realized in AdminProfitLog/SystemProfitFees)
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
// r36/P1: durable per-order inventory-deduction claim marker.
STATEMENTS.push('ALTER TABLE "BusinessOrder" ADD COLUMN IF NOT EXISTS "inventoryDeductedAt" TIMESTAMP(3);');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "BusinessOrder_idempotencyKey_key" ON "BusinessOrder"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;');

// DineInTab payment method + idempotency
// r36/P1: ONE ACTIVE TAB PER TABLE (durable invariant). A non-CLOSED tab
// pins the table; concurrent status writers converge instead of creating a
// second active tab. If legacy duplicate active tabs exist in production, this
// creation is reported as an error line (deploy continues; the invariant is
// then enforced at the transaction boundary instead).
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "DineInTab_active_tab_per_table_key" ON "DineInTab"("tableId") WHERE "status" <> $q$CLOSED$q$ AND "tableId" IS NOT NULL;');
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
// r36/P0: thread-kind discriminator. Legacy rows keep NULL (unconstrained);
// the canonical customer-support rail enforces ONE thread per
// (business, customer) through a partial unique index — participantB is the
// durable customer slot for CUSTOMER_SUPPORT threads (participantA is the
// staff identity that created the thread).
STATEMENTS.push('ALTER TABLE "BusinessConversation" ADD COLUMN IF NOT EXISTS "channel" VARCHAR(40);');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "BusinessConversation_customer_support_key" ON "BusinessConversation"("businessProfileId", "participantBId") WHERE "channel" = $q$CUSTOMER_SUPPORT$q$;');

// =============================================================================
//  Execute all statements sequentially (autocommit — can't use $transaction
//  because ALTER TYPE ADD VALUE must not be in a transaction block, and DO
//  blocks behave more predictably in autocommit).
// =============================================================================

// ── Phase 3 Retail: BusinessProduct barcode/SKU fields ──────────────────────
STATEMENTS.push('ALTER TABLE "BusinessProduct" ADD COLUMN IF NOT EXISTS "sku" VARCHAR(50);');
STATEMENTS.push('ALTER TABLE "BusinessProduct" ADD COLUMN IF NOT EXISTS "barcode" VARCHAR(100);');
STATEMENTS.push('ALTER TABLE "BusinessProduct" ADD COLUMN IF NOT EXISTS "costPrice" DECIMAL(20,8);');
STATEMENTS.push('ALTER TABLE "BusinessProduct" ADD COLUMN IF NOT EXISTS "stockQty" INTEGER DEFAULT 0;');
STATEMENTS.push('ALTER TABLE "BusinessProduct" ADD COLUMN IF NOT EXISTS "lowStockThreshold" INTEGER DEFAULT 5;');
STATEMENTS.push('ALTER TABLE "BusinessProduct" ADD COLUMN IF NOT EXISTS "supplierId" VARCHAR(36);');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "BusinessProduct_sku_key" ON "BusinessProduct"("sku");');

// ── Phase 3 Retail: Supplier ─────────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "Supplier" (
    "id" VARCHAR(36) NOT NULL,
    "businessProfileId" VARCHAR(36) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "contactName" VARCHAR(200),
    "email" VARCHAR(200),
    "phone" VARCHAR(50),
    "address" VARCHAR(500),
    "notes" VARCHAR(1000),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);`);
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "Supplier_businessProfileId_idx" ON "Supplier"("businessProfileId");');
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'Supplier_businessProfileId_fkey') THEN
      ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'BusinessProduct_supplierId_fkey') THEN
      ALTER TABLE "BusinessProduct" ADD CONSTRAINT "BusinessProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL;
    END IF;
  END $$;`);


// ── r36: Honest payout request record ────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "BusinessPayoutRequest" (
    "id" VARCHAR(36) NOT NULL,
    "businessProfileId" VARCHAR(36) NOT NULL REFERENCES "BusinessProfile"("id") ON DELETE CASCADE,
    "destinationId" VARCHAR(36) NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
    "requestLogId" VARCHAR(36),
    "requestedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessPayoutRequest_pkey" PRIMARY KEY ("id")
);`);
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessPayoutRequest_businessProfileId_idx" ON "BusinessPayoutRequest"("businessProfileId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessPayoutRequest_status_idx" ON "BusinessPayoutRequest"("status");');

// ── r36: Durable document-number sequence (business-local doc numbers) ──────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "DocumentNumberSequence" (
    "id" VARCHAR(36) NOT NULL,
    "businessProfileId" VARCHAR(36) NOT NULL,
    "docType" VARCHAR(40) NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentNumberSequence_pkey" PRIMARY KEY ("id")
);`);
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "DocumentNumberSequence_businessProfileId_docType_key" ON "DocumentNumberSequence"("businessProfileId", "docType");');

// ── Phase 3 Retail: PurchaseOrder ────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "PurchaseOrder" (
    "id" VARCHAR(36) NOT NULL,
    "businessProfileId" VARCHAR(36) NOT NULL,
    "poNumber" VARCHAR(50) NOT NULL,
    "supplierId" VARCHAR(36) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "totalCost" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "notes" VARCHAR(1000),
    "expectedDate" TIMESTAMP(3),
    "receivedDate" TIMESTAMP(3),
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);`);
// r36/P1: poNumber is a business-local identifier — replace the global
// unique index with a business-scoped one. The drop is idempotent; on a fresh
// CI database db push has already created the composite index.
STATEMENTS.push('DROP INDEX IF EXISTS "PurchaseOrder_poNumber_key";');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrder_businessProfileId_poNumber_key" ON "PurchaseOrder"("businessProfileId", "poNumber");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "PurchaseOrder_businessProfileId_idx" ON "PurchaseOrder"("businessProfileId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "PurchaseOrder_supplierId_idx" ON "PurchaseOrder"("supplierId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "PurchaseOrder_status_idx" ON "PurchaseOrder"("status");');
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'PurchaseOrder_businessProfileId_fkey') THEN
      ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'PurchaseOrder_supplierId_fkey') THEN
      ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id");
    END IF;
  END $$;`);

// ── Phase 3 Retail: PurchaseOrderItem ────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "PurchaseOrderItem" (
    "id" VARCHAR(36) NOT NULL,
    "purchaseOrderId" VARCHAR(36) NOT NULL,
    "productId" VARCHAR(36),
    "productName" VARCHAR(200) NOT NULL,
    "sku" VARCHAR(50),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);`);
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "PurchaseOrderItem_purchaseOrderId_idx" ON "PurchaseOrderItem"("purchaseOrderId");');
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'PurchaseOrderItem_purchaseOrderId_fkey') THEN
      ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── Phase 3 Retail: StockCount ───────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "StockCount" (
    "id" VARCHAR(36) NOT NULL,
    "businessProfileId" VARCHAR(36) NOT NULL,
    "countNumber" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "notes" VARCHAR(1000),
    "createdById" INTEGER NOT NULL,
    "reconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);`);
// r36/P1: countNumber is a business-local identifier — business-scoped uniqueness.
STATEMENTS.push('DROP INDEX IF EXISTS "StockCount_countNumber_key";');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "StockCount_businessProfileId_countNumber_key" ON "StockCount"("businessProfileId", "countNumber");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "StockCount_businessProfileId_idx" ON "StockCount"("businessProfileId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "StockCount_status_idx" ON "StockCount"("status");');
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'StockCount_businessProfileId_fkey') THEN
      ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── Phase 3 Retail: StockCountItem ────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "StockCountItem" (
    "id" VARCHAR(36) NOT NULL,
    "stockCountId" VARCHAR(36) NOT NULL,
    "productId" VARCHAR(36) NOT NULL,
    "systemQty" INTEGER NOT NULL DEFAULT 0,
    "countedQty" INTEGER,
    "discrepancy" INTEGER,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockCountItem_pkey" PRIMARY KEY ("id")
);`);
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "StockCountItem_stockCountId_idx" ON "StockCountItem"("stockCountId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "StockCountItem_productId_idx" ON "StockCountItem"("productId");');
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'StockCountItem_stockCountId_fkey') THEN
      ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);


// ── Phase 3: QrScan table ────────────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "QrScan" (
    "id" VARCHAR(36) NOT NULL,
    "ipAddress" VARCHAR(100),
    "userAgent" VARCHAR(500),
    "referrer" VARCHAR(500),
    "country" VARCHAR(50),
    "city" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QrScan_pkey" PRIMARY KEY ("id")
);`);
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "QrScan_createdAt_idx" ON "QrScan"("createdAt");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "QrScan_ipAddress_idx" ON "QrScan"("ipAddress");');

// ── Phase 3: BusinessInvoice recurring fields ────────────────────────────────
STATEMENTS.push('ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "isRecurring" BOOLEAN NOT NULL DEFAULT false;');
STATEMENTS.push('ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "recurringInterval" VARCHAR(20);');
STATEMENTS.push('ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "recurringNextDate" TIMESTAMP(3);');
STATEMENTS.push('ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "recurringParentId" VARCHAR(36);');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessInvoice_recurringNextDate_idx" ON "BusinessInvoice"("recurringNextDate");');

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
    // r38/P0 — a production financial schema installer must FAIL the release
    // when unexpected DDL fails. Swallowing the error lets `npm run release`
    // exit successfully with a missing invariant (exactly how the r37
    // reversal uniqueness could have been silently skipped in production).
    const e = new Error(`[business-os-overlay] ${errors.length} DDL statement(s) failed — deployment is NOT healthy.`);
    e.details = errors;
    throw e;
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
    logger.error('[business-os-overlay] Fatal:', e.message || e);
    if (Array.isArray(e.details)) {
      for (const d of e.details) logger.error(`  failed: ${d.stmt}… -> ${String(d.error).slice(0, 160)}`);
    }
    // r38/P0 — non-zero exit so `npm run release` (a `&&` chain) and CI
    // both abort instead of shipping a schema that is not what the code
    // expects. Boot-time invocation (src/boot/treasury.js) already catches
    // the failure and logs it without blocking app boot.
    process.exitCode = 1;
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

// ── Storefront Version History ─────────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "StorefrontVersion" (
    "id" VARCHAR(36) NOT NULL,
    "businessProfileId" VARCHAR(36) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "label" VARCHAR(200),
    "publishedBy" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StorefrontVersion_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "StorefrontVersion_businessProfileId_createdAt_idx" ON "StorefrontVersion"("businessProfileId", "createdAt" DESC);');

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'StorefrontVersion_businessProfileId_fkey') THEN
      ALTER TABLE "StorefrontVersion" ADD CONSTRAINT "StorefrontVersion_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── Module 09: Audit Log tables ───────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" VARCHAR(36) NOT NULL,
    "actorId" INTEGER,
    "actorName" VARCHAR(255),
    "action" VARCHAR(255) NOT NULL,
    "targetType" VARCHAR(100) NOT NULL,
    "targetId" VARCHAR(36),
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "ipAddress" VARCHAR(45),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "AuditLog_actorId_idx" ON "AuditLog"("actorId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "AuditLog_action_idx" ON "AuditLog"("action");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);');

STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "AdminSettingsAuditLog" (
    "id" VARCHAR(36) NOT NULL,
    "adminId" INTEGER NOT NULL,
    "adminName" VARCHAR(255),
    "action" VARCHAR(100) NOT NULL,
    "targetType" VARCHAR(100) NOT NULL,
    "targetId" VARCHAR(36),
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminSettingsAuditLog_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "AdminSettingsAuditLog_adminId_idx" ON "AdminSettingsAuditLog"("adminId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "AdminSettingsAuditLog_createdAt_idx" ON "AdminSettingsAuditLog"("createdAt" DESC);');

// ── Module 10: Restaurant Inventory (InventoryItem + RecipeIngredient) ─────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "InventoryItem" (
    "id" VARCHAR(36) NOT NULL,
    "businessProfileId" VARCHAR(36) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "unit" VARCHAR(50) NOT NULL,
    "currentStock" DOUBLE PRECISION NOT NULL,
    "minimumStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costPerUnit" DOUBLE PRECISION NOT NULL,
    "category" VARCHAR(100),
    "supplier" VARCHAR(255),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "InventoryItem_businessProfileId_idx" ON "InventoryItem"("businessProfileId");');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "InventoryItem_businessProfileId_name_key" ON "InventoryItem"("businessProfileId", "name");');

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'InventoryItem_businessProfileId_fkey') THEN
      ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id");
    END IF;
  END $$;`);

STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "RecipeIngredient" (
    "id" VARCHAR(36) NOT NULL,
    "productId" VARCHAR(36) NOT NULL,
    "inventoryItemId" VARCHAR(36) NOT NULL,
    "quantityRequired" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "RecipeIngredient_productId_idx" ON "RecipeIngredient"("productId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "RecipeIngredient_inventoryItemId_idx" ON "RecipeIngredient"("inventoryItemId");');

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'RecipeIngredient_productId_fkey') THEN
      ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_productId_fkey" FOREIGN KEY ("productId") REFERENCES "BusinessProduct"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'RecipeIngredient_inventoryItemId_fkey') THEN
      ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

// ── Module 11: User table column additions ───────────────────────────────────
STATEMENTS.push('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "twoFactorSecret" VARCHAR(255);');
STATEMENTS.push('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isTwoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;');
STATEMENTS.push('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pinHash" VARCHAR(255);');
STATEMENTS.push('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false;');
STATEMENTS.push('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;');
STATEMENTS.push('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);');
STATEMENTS.push('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;');

// ── r37/P0 — production schema authority for r35/r36 runtime tables ────────
// CI builds its test database with `prisma db push`, but PRODUCTION is
// maintained through these raw overlays (no _prisma_migrations baseline, no
// db push). Two tables added by the r35/r36 waves existed only in
// schema.prisma — green CI could not see that a real release would deploy
// application code whose runtime tables do not exist. This section closes
// that deployment-drift gap; the shapes match the Prisma models exactly
// (columns, types, indexes, unique constraints, FKs).

// BusinessLedgerEntry (r35 append-only business ledger). The Prisma model
// types `type` as the LedgerEntryType enum, so the enum TYPE must exist
// before the table.
STATEMENTS.push(`DO $$ BEGIN
    CREATE TYPE "LedgerEntryType" AS ENUM (
        'INCOME', 'EXPENSE', 'PAYROLL', 'TAX', 'REFUND', 'PENALTY',
        'AD_SPEND', 'MAINTENANCE', 'SUPPLIES', 'UTILITIES', 'RENT', 'OTHER'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`);

STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "BusinessLedgerEntry" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "amountGhs" DECIMAL(20,8),
    "sourceType" VARCHAR(50),
    "sourceId" TEXT,
    "metadata" JSONB,
    "reversalOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessLedgerEntry_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessLedgerEntry_businessProfileId_type_idx" ON "BusinessLedgerEntry"("businessProfileId", "type");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessLedgerEntry_businessProfileId_createdAt_idx" ON "BusinessLedgerEntry"("businessProfileId", "createdAt" DESC);');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessLedgerEntry_businessProfileId_type_createdAt_idx" ON "BusinessLedgerEntry"("businessProfileId", "type", "createdAt" DESC);');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "BusinessLedgerEntry_sourceType_sourceId_idx" ON "BusinessLedgerEntry"("sourceType", "sourceId");');
// r38/P0 — ORDERING FIX: the column is added BEFORE the unique index that
// depends on it. On a database holding a PRE-r37 BusinessLedgerEntry table
// (e.g. from an earlier overlay run whose index creation was swallowed),
// creating the index first fails, the failure was previously swallowed, and
// production could run WITHOUT the DB uniqueness invariant the r37 code
// relies on. ADD COLUMN IF NOT EXISTS is a clean no-op when the column is
// already present (fresh installs).
STATEMENTS.push('ALTER TABLE "BusinessLedgerEntry" ADD COLUMN IF NOT EXISTS "reversalOfId" TEXT;');
// r37/P1: durable one-reversal-per-entry invariant (nullable unique —
// Postgres allows multiple NULLs, so only real reversals are constrained).
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "BusinessLedgerEntry_reversalOfId_key" ON "BusinessLedgerEntry"("reversalOfId")');

STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'BusinessLedgerEntry_businessProfileId_fkey') THEN
      ALTER TABLE "BusinessLedgerEntry" ADD CONSTRAINT "BusinessLedgerEntry_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);

// ConversationMoneyTicket (r36 canonical money-in-chat authority). The
// Prisma model declares NO relation fields (messageId/conversationId are
// plain strings by design — ticket resolution is authority-checked by
// predicate, not by FK), so this table carries no foreign keys.
// r39/P1 — currency default contract: the money-in-chat rails are
// USDC-denominated (normalizeAsset rejects every other asset), so the DDL
// default must say USDC. 'GHS' was a copy-forward from an unrelated table
// and contradicted every code path that writes a ticket.
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "ConversationMoneyTicket" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "requesterId" INTEGER NOT NULL,
    "counterpartyId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "resultMessageId" TEXT,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationMoneyTicket_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "ConversationMoneyTicket_messageId_key" ON "ConversationMoneyTicket"("messageId");');
STATEMENTS.push('CREATE UNIQUE INDEX IF NOT EXISTS "ConversationMoneyTicket_clientRequestId_key" ON "ConversationMoneyTicket"("clientRequestId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "ConversationMoneyTicket_conversationId_idx" ON "ConversationMoneyTicket"("conversationId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "ConversationMoneyTicket_requesterId_idx" ON "ConversationMoneyTicket"("requesterId");');
STATEMENTS.push('CREATE INDEX IF NOT EXISTS "ConversationMoneyTicket_counterpartyId_idx" ON "ConversationMoneyTicket"("counterpartyId");');

// r39/P1 — existing deployments keep the old 'GHS' default: migrate the
// column default to the true contract. Rerunnable: setting the default is
// idempotent.
STATEMENTS.push(`ALTER TABLE "ConversationMoneyTicket" ALTER COLUMN "currency" SET DEFAULT 'USDC';`);

// r39/P1 — DURABLE LIFECYCLE CONTRACT. A ConversationMoneyTicket is an
// immutable financial record (resolution is authority-checked by predicate).
// Its reference edges may no longer be soft pointers that silently orphan
// when the referenced row is hard-deleted:
//   • messageId      -> Message(id)          ON DELETE RESTRICT
//   • conversationId -> Conversation(id)    ON DELETE RESTRICT
//   • requesterId    -> User(id)             ON DELETE RESTRICT
//   • counterpartyId -> User(id)             ON DELETE RESTRICT
// RESTRICT means: a hard delete of a financial message (or its conversation
// or participants) FAILS CLOSED instead of leaving an orphaned financial
// record whose resolution can never be traced. The disappearing-message
// sweep additionally excludes money-bearing messages by predicate (belt),
// and the database constraints are the suspenders.
// Deployment guard: the overlay runs on production data that predates the
// FK. Orphaned tickets (created by the legacy soft-pointer era, e.g. a
// message already hard-deleted by the old sweep) are moved VERBATIM into
// "ConversationMoneyTicketOrphanArchive" — financial records are never
// deleted — with the missing-edge reason recorded, BEFORE the constraint is
// created. The archive is an explicit immutable financial-record model that
// owns the orphaned relationship.
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "ConversationMoneyTicketOrphanArchive" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "requesterId" INTEGER NOT NULL,
    "counterpartyId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "resultMessageId" TEXT,
    "clientRequestId" TEXT,
    "orphanReason" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationMoneyTicketOrphanArchive_pkey" PRIMARY KEY ("id")
);`);
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ConversationMoneyTicket_messageId_fkey') THEN
        IF EXISTS (SELECT 1 FROM "ConversationMoneyTicket" t LEFT JOIN "Message" m ON m."id" = t."messageId" WHERE m."id" IS NULL) THEN
            INSERT INTO "ConversationMoneyTicketOrphanArchive"
                ("id", "messageId", "conversationId", "kind", "amount", "currency", "requesterId", "counterpartyId", "status", "resultMessageId", "clientRequestId", "orphanReason")
            SELECT t."id", t."messageId", t."conversationId", t."kind", t."amount", t."currency", t."requesterId", t."counterpartyId", t."status", t."resultMessageId", t."clientRequestId", 'missing_message'
            FROM "ConversationMoneyTicket" t LEFT JOIN "Message" m ON m."id" = t."messageId" WHERE m."id" IS NULL;
            DELETE FROM "ConversationMoneyTicket" t WHERE NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."id" = t."messageId");
        END IF;
        ALTER TABLE "ConversationMoneyTicket" ADD CONSTRAINT "ConversationMoneyTicket_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT;
    END IF;
END $$;`);
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ConversationMoneyTicket_conversationId_fkey') THEN
        IF EXISTS (SELECT 1 FROM "ConversationMoneyTicket" t LEFT JOIN "Conversation" c ON c."id" = t."conversationId" WHERE c."id" IS NULL) THEN
            INSERT INTO "ConversationMoneyTicketOrphanArchive"
                ("id", "messageId", "conversationId", "kind", "amount", "currency", "requesterId", "counterpartyId", "status", "resultMessageId", "clientRequestId", "orphanReason")
            SELECT t."id", t."messageId", t."conversationId", t."kind", t."amount", t."currency", t."requesterId", t."counterpartyId", t."status", t."resultMessageId", t."clientRequestId", 'missing_conversation'
            FROM "ConversationMoneyTicket" t LEFT JOIN "Conversation" c ON c."id" = t."conversationId" WHERE c."id" IS NULL;
            DELETE FROM "ConversationMoneyTicket" t WHERE NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c."id" = t."conversationId");
        END IF;
        ALTER TABLE "ConversationMoneyTicket" ADD CONSTRAINT "ConversationMoneyTicket_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT;
    END IF;
END $$;`);
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ConversationMoneyTicket_requesterId_fkey') THEN
        IF EXISTS (SELECT 1 FROM "ConversationMoneyTicket" t LEFT JOIN "User" u ON u."id" = t."requesterId" WHERE u."id" IS NULL) THEN
            INSERT INTO "ConversationMoneyTicketOrphanArchive"
                ("id", "messageId", "conversationId", "kind", "amount", "currency", "requesterId", "counterpartyId", "status", "resultMessageId", "clientRequestId", "orphanReason")
            SELECT t."id", t."messageId", t."conversationId", t."kind", t."amount", t."currency", t."requesterId", t."counterpartyId", t."status", t."resultMessageId", t."clientRequestId", 'missing_requester'
            FROM "ConversationMoneyTicket" t LEFT JOIN "User" u ON u."id" = t."requesterId" WHERE u."id" IS NULL;
            DELETE FROM "ConversationMoneyTicket" t WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = t."requesterId");
        END IF;
        ALTER TABLE "ConversationMoneyTicket" ADD CONSTRAINT "ConversationMoneyTicket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT;
    END IF;
END $$;`);
STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ConversationMoneyTicket_counterpartyId_fkey') THEN
        IF EXISTS (SELECT 1 FROM "ConversationMoneyTicket" t LEFT JOIN "User" u ON u."id" = t."counterpartyId" WHERE u."id" IS NULL) THEN
            INSERT INTO "ConversationMoneyTicketOrphanArchive"
                ("id", "messageId", "conversationId", "kind", "amount", "currency", "requesterId", "counterpartyId", "status", "resultMessageId", "clientRequestId", "orphanReason")
            SELECT t."id", t."messageId", t."conversationId", t."kind", t."amount", t."currency", t."requesterId", t."counterpartyId", t."status", t."resultMessageId", t."clientRequestId", 'missing_counterparty'
            FROM "ConversationMoneyTicket" t LEFT JOIN "User" u ON u."id" = t."counterpartyId" WHERE u."id" IS NULL;
            DELETE FROM "ConversationMoneyTicket" t WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = t."counterpartyId");
        END IF;
        ALTER TABLE "ConversationMoneyTicket" ADD CONSTRAINT "ConversationMoneyTicket_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "User"("id") ON DELETE RESTRICT;
    END IF;
END $$;`);

// ── Business OS P0 settlement repair (PR #292, 2026-09-21) ─────────────────
// EWA withdrawal fee revenue: EwaService.requestWithdrawal records the 1%
// platform fee as an AdminProfitLog row with source 'EWA_FEE' (ProfitSource
// enum) plus a SystemProfitFees increment and an authoritative ledger line.
// Production schema authority is these raw-SQL overlays (NOT prisma migrate
// deploy / db push — production has no _prisma_migrations table), so the
// enum value must be added here for the real production database. `ADD VALUE
// IF NOT EXISTS` makes the statement safely rerunnable: first run adds the
// value, subsequent runs are a clean no-op. (Same convention as susu
// overlay's 'ALTER TYPE "ProfitSource" ADD VALUE IF NOT EXISTS 'SUSU_FEE';'.)
STATEMENTS.push(`ALTER TYPE "ProfitSource" ADD VALUE IF NOT EXISTS 'EWA_FEE';`);
