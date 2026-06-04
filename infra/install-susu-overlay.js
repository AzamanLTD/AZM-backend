#!/usr/bin/env node
// infra/install-susu-overlay.js
// =============================================================================
// Idempotent, NON-DESTRUCTIVE installer for the Private Susu Ecosystem
// overlay schema objects.
//
// Why this exists: production Neon was provisioned with `prisma db push`
// (no `_prisma_migrations` baseline), so `prisma migrate deploy` aborts
// with P3005 ("schema is not empty"). Rather than risk running the
// migrate-dev drift-correction SQL against prod, this script applies ONLY
// the additive Susu overlay objects, each guarded so re-runs are safe:
//
//   • new enums (CREATE TYPE … guarded by pg_type lookup)
//   • new enum VALUES (ALTER TYPE … ADD VALUE IF NOT EXISTS)
//   • new User columns (ADD COLUMN IF NOT EXISTS)
//   • new SusuGroup / SusuCycle columns (ADD COLUMN IF NOT EXISTS)
//   • 6 new tables (CREATE TABLE IF NOT EXISTS)
//   • their indexes (CREATE [UNIQUE] INDEX IF NOT EXISTS)
//   • their foreign keys (added only if not already present)
//
// It does NOT drop, rename, or alter any existing column/index/constraint,
// so it cannot cause data loss. Every statement is safe to run repeatedly.
//
// Usage:  node infra/install-susu-overlay.js
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Each entry is a single DDL statement. They run sequentially. ALTER TYPE
// ADD VALUE cannot run inside a transaction block, so we execute statement
// by statement with executeRawUnsafe (autocommit) rather than $transaction.
const STATEMENTS = [];

// ── Enums (guarded create) ───────────────────────────────────────────────
function createEnum(name, values) {
  const vals = values.map((v) => `'${v}'`).join(', ');
  STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${name}') THEN
      CREATE TYPE "${name}" AS ENUM (${vals});
    END IF;
  END $$;`);
}
createEnum('ProofOfResidencyStatus', ['NOT_SUBMITTED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED']);
createEnum('SusuInviteChannel', ['FRIEND', 'PHONE', 'LINK']);
createEnum('SusuInviteStatus', ['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED']);
createEnum('AdminWarRoomAlertType', ['ADMIN_DEFAULT', 'MASS_DEFAULT_THRESHOLD', 'ESCROW_DIVERSION', 'VOUCH_SLASH_TX_FAILURE']);
// PHASE 6 / Social & Vouching Evolution — GroupJoinRequest status.
createEnum('GroupJoinRequestStatus', ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

// ── Enum value additions (idempotent) ─────────────────────────────────────
STATEMENTS.push(`ALTER TYPE "VouchStatus" ADD VALUE IF NOT EXISTS 'VOIDED';`);
STATEMENTS.push(`ALTER TYPE "SusuFrequency" ADD VALUE IF NOT EXISTS 'DAILY' BEFORE 'WEEKLY';`);
// PHASE 5 / Workstream C — penalty-ladder grace state on SusuCycleStatus.
STATEMENTS.push(`ALTER TYPE "SusuCycleStatus" ADD VALUE IF NOT EXISTS 'COLLECTING_GRACE' AFTER 'COLLECTING';`);
// PHASE 5 / Workstream E — War Room escrow refund transaction type.
STATEMENTS.push(`ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'SUSU_REFUND';`);
// PHASE 6 / Phase 5 — Susu profit engine transaction type + profit source.
STATEMENTS.push(`ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'SUSU_PROFIT';`);
STATEMENTS.push(`ALTER TYPE "ProfitSource" ADD VALUE IF NOT EXISTS 'SUSU_FEE';`);

// ── User columns ───────────────────────────────────────────────────────────
STATEMENTS.push(`ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "proofOfResidencyUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "proofOfResidencyStatus" "ProofOfResidencyStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
  ADD COLUMN IF NOT EXISTS "proofOfResidencySubmittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "proofOfResidencyVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "proofOfResidencyRejectionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "trustRating" INTEGER NOT NULL DEFAULT 100;`);

// ── PHASE 6 / Social & Vouching Evolution — User columns ────────────────────
STATEMENTS.push(`ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "azamanId" TEXT,
  ADD COLUMN IF NOT EXISTS "discoverable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "phoneHash" TEXT;`);
STATEMENTS.push(`CREATE UNIQUE INDEX IF NOT EXISTS "User_azamanId_key" ON "User"("azamanId");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "User_phoneHash_idx" ON "User"("phoneHash");`);

// ── PHASE 6 / Social & Vouching Evolution — GroupMember vouch lineage ───────
STATEMENTS.push(`ALTER TABLE "GroupMember"
  ADD COLUMN IF NOT EXISTS "addedById" INTEGER,
  ADD COLUMN IF NOT EXISTS "vouchedById" INTEGER;`);

// ── PHASE 6 / Phase 5 — GlobalSettings susuProfitPct ────────────────────────
STATEMENTS.push(`ALTER TABLE "GlobalSettings"
  ADD COLUMN IF NOT EXISTS "susuProfitPct" DECIMAL(10,4) NOT NULL DEFAULT 0.03;`);

// ── SusuGroup columns ───────────────────────────────────────────────────────
STATEMENTS.push(`ALTER TABLE "SusuGroup"
  ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "contractHash" TEXT,
  ADD COLUMN IF NOT EXISTS "contractVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "frozenAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "frozenReason" TEXT,
  ADD COLUMN IF NOT EXISTS "initiationDeadline" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "initiatedById" INTEGER;`);

// ── SusuCycle columns ───────────────────────────────────────────────────────
STATEMENTS.push(`ALTER TABLE "SusuMember"
  ADD COLUMN IF NOT EXISTS "autoRetainNextCycle" BOOLEAN NOT NULL DEFAULT false;`);

STATEMENTS.push(`ALTER TABLE "SusuCycle"
  ADD COLUMN IF NOT EXISTS "escrowDivertedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "startedCollectingAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "graceUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "feeUsdc" DECIMAL(20,8);`);

// ── AdminWarRoomAlert resolution columns (Workstream E) ──────────────────────
STATEMENTS.push(`ALTER TABLE "AdminWarRoomAlert"
  ADD COLUMN IF NOT EXISTS "resolution" TEXT,
  ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resolvedBy" INTEGER;`);

// ── New tables ──────────────────────────────────────────────────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "SusuInvite" (
  "id" TEXT NOT NULL,
  "susuGroupId" TEXT NOT NULL,
  "inviterId" INTEGER NOT NULL,
  "inviteeUserId" INTEGER,
  "inviteePhone" TEXT,
  "channel" "SusuInviteChannel" NOT NULL,
  "token" TEXT,
  "status" "SusuInviteStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "redeemedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SusuInvite_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "LiabilityContractVersion" (
  "id" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "contractHash" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedBy" INTEGER NOT NULL,
  CONSTRAINT "LiabilityContractVersion_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "LiabilityAcceptance" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "susuGroupId" TEXT NOT NULL,
  "contractVersion" TEXT NOT NULL,
  "contractHash" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" TEXT NOT NULL,
  "userAgent" TEXT NOT NULL,
  CONSTRAINT "LiabilityAcceptance_pkey" PRIMARY KEY ("id")
);`);

// ── PHASE 6 / Phase 4 — LiabilityAcceptance consent + voucher columns ───────
STATEMENTS.push(`ALTER TABLE "LiabilityAcceptance"
  ADD COLUMN IF NOT EXISTS "acknowledgedClauses" JSONB,
  ADD COLUMN IF NOT EXISTS "voucherUserId" INTEGER;`);

STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "VoucherSlashLog" (
  "id" TEXT NOT NULL,
  "voucherId" INTEGER,
  "vouchedUserId" INTEGER NOT NULL,
  "susuGroupId" TEXT NOT NULL,
  "cycleId" TEXT NOT NULL,
  "azmDeducted" DECIMAL(20,8) NOT NULL,
  "trustRatingBefore" INTEGER NOT NULL,
  "trustRatingAfter" INTEGER NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoucherSlashLog_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "SusuReminderSent" (
  "id" TEXT NOT NULL,
  "susuMemberId" TEXT NOT NULL,
  "susuCycleId" TEXT NOT NULL,
  "susuGroupId" TEXT NOT NULL,
  "reminderType" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SusuReminderSent_pkey" PRIMARY KEY ("id")
);`);

STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "AdminWarRoomAlert" (
  "id" TEXT NOT NULL,
  "alertType" "AdminWarRoomAlertType" NOT NULL,
  "susuGroupId" TEXT NOT NULL,
  "cycleId" TEXT,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedBy" INTEGER,
  CONSTRAINT "AdminWarRoomAlert_pkey" PRIMARY KEY ("id")
);`);

// ── PHASE 6 / Social & Vouching Evolution — GroupJoinRequest ────────────────
STATEMENTS.push(`CREATE TABLE IF NOT EXISTS "GroupJoinRequest" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "proposerId" INTEGER NOT NULL,
  "targetUserId" INTEGER NOT NULL,
  "note" TEXT,
  "status" "GroupJoinRequestStatus" NOT NULL DEFAULT 'PENDING',
  "decidedById" INTEGER,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GroupJoinRequest_pkey" PRIMARY KEY ("id")
);`);

// ── Indexes ─────────────────────────────────────────────────────────────────
STATEMENTS.push(`CREATE UNIQUE INDEX IF NOT EXISTS "SusuInvite_token_key" ON "SusuInvite"("token");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "SusuInvite_susuGroupId_status_idx" ON "SusuInvite"("susuGroupId", "status");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "SusuInvite_inviteeUserId_status_idx" ON "SusuInvite"("inviteeUserId", "status");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "SusuInvite_inviteePhone_status_idx" ON "SusuInvite"("inviteePhone", "status");`);
STATEMENTS.push(`CREATE UNIQUE INDEX IF NOT EXISTS "LiabilityContractVersion_version_key" ON "LiabilityContractVersion"("version");`);
STATEMENTS.push(`CREATE UNIQUE INDEX IF NOT EXISTS "LiabilityContractVersion_contractHash_key" ON "LiabilityContractVersion"("contractHash");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "LiabilityContractVersion_publishedAt_idx" ON "LiabilityContractVersion"("publishedAt" DESC);`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "LiabilityAcceptance_susuGroupId_idx" ON "LiabilityAcceptance"("susuGroupId");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "LiabilityAcceptance_voucherUserId_idx" ON "LiabilityAcceptance"("voucherUserId");`);
STATEMENTS.push(`CREATE UNIQUE INDEX IF NOT EXISTS "LiabilityAcceptance_userId_susuGroupId_contractVersion_key" ON "LiabilityAcceptance"("userId", "susuGroupId", "contractVersion");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "VoucherSlashLog_voucherId_idx" ON "VoucherSlashLog"("voucherId");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "VoucherSlashLog_susuGroupId_cycleId_idx" ON "VoucherSlashLog"("susuGroupId", "cycleId");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "SusuReminderSent_susuCycleId_idx" ON "SusuReminderSent"("susuCycleId");`);
STATEMENTS.push(`CREATE UNIQUE INDEX IF NOT EXISTS "SusuReminderSent_susuMemberId_susuCycleId_reminderType_key" ON "SusuReminderSent"("susuMemberId", "susuCycleId", "reminderType");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "AdminWarRoomAlert_acknowledgedAt_createdAt_idx" ON "AdminWarRoomAlert"("acknowledgedAt", "createdAt" DESC);`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "AdminWarRoomAlert_susuGroupId_idx" ON "AdminWarRoomAlert"("susuGroupId");`);

// PHASE 6 — GroupJoinRequest indexes. The unique([groupId,targetUserId,status])
// permits one PENDING + later one APPROVED/REJECTED audit row to coexist.
STATEMENTS.push(`CREATE UNIQUE INDEX IF NOT EXISTS "GroupJoinRequest_groupId_targetUserId_status_key" ON "GroupJoinRequest"("groupId", "targetUserId", "status");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "GroupJoinRequest_groupId_status_idx" ON "GroupJoinRequest"("groupId", "status");`);
STATEMENTS.push(`CREATE INDEX IF NOT EXISTS "GroupJoinRequest_targetUserId_status_idx" ON "GroupJoinRequest"("targetUserId", "status");`);

// ── Foreign keys (added only if not already present) ──────────────────────
function addFk(table, constraint, ddl) {
  STATEMENTS.push(`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = '${constraint}'
    ) THEN
      ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" ${ddl};
    END IF;
  END $$;`);
}
addFk('SusuInvite', 'SusuInvite_susuGroupId_fkey', `FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('SusuInvite', 'SusuInvite_inviterId_fkey', `FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE`);
addFk('SusuInvite', 'SusuInvite_inviteeUserId_fkey', `FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE`);
addFk('LiabilityContractVersion', 'LiabilityContractVersion_publishedBy_fkey', `FOREIGN KEY ("publishedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE`);
addFk('LiabilityAcceptance', 'LiabilityAcceptance_userId_fkey', `FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE`);
addFk('LiabilityAcceptance', 'LiabilityAcceptance_susuGroupId_fkey', `FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('LiabilityAcceptance', 'LiabilityAcceptance_voucherUserId_fkey', `FOREIGN KEY ("voucherUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE`);
addFk('VoucherSlashLog', 'VoucherSlashLog_voucherId_fkey', `FOREIGN KEY ("voucherId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE`);
addFk('VoucherSlashLog', 'VoucherSlashLog_vouchedUserId_fkey', `FOREIGN KEY ("vouchedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE`);
addFk('VoucherSlashLog', 'VoucherSlashLog_susuGroupId_fkey', `FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('VoucherSlashLog', 'VoucherSlashLog_cycleId_fkey', `FOREIGN KEY ("cycleId") REFERENCES "SusuCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('SusuReminderSent', 'SusuReminderSent_susuMemberId_fkey', `FOREIGN KEY ("susuMemberId") REFERENCES "SusuMember"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('SusuReminderSent', 'SusuReminderSent_susuCycleId_fkey', `FOREIGN KEY ("susuCycleId") REFERENCES "SusuCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('SusuReminderSent', 'SusuReminderSent_susuGroupId_fkey', `FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('AdminWarRoomAlert', 'AdminWarRoomAlert_susuGroupId_fkey', `FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('AdminWarRoomAlert', 'AdminWarRoomAlert_cycleId_fkey', `FOREIGN KEY ("cycleId") REFERENCES "SusuCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE`);
addFk('AdminWarRoomAlert', 'AdminWarRoomAlert_acknowledgedBy_fkey', `FOREIGN KEY ("acknowledgedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE`);
// PHASE 6 — GroupJoinRequest foreign keys (group cascade + two User relations).
addFk('GroupJoinRequest', 'GroupJoinRequest_groupId_fkey', `FOREIGN KEY ("groupId") REFERENCES "GroupChat"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('GroupJoinRequest', 'GroupJoinRequest_proposerId_fkey', `FOREIGN KEY ("proposerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
addFk('GroupJoinRequest', 'GroupJoinRequest_targetUserId_fkey', `FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`);

async function install(client) {
  // Reuse the caller's Prisma client when provided (shares the app's
  // pooled connection — avoids opening a second Neon connection and any
  // advisory-lock/pooler issues that break `prisma migrate`). Falls back
  // to a standalone client when run as a CLI.
  const db = client || prisma;
  const results = { ok: 0, failed: 0, errors: [] };
  for (const sql of STATEMENTS) {
    try {
      await db.$executeRawUnsafe(sql);
      results.ok += 1;
    } catch (err) {
      results.failed += 1;
      const head = sql.split('\n')[0].slice(0, 80);
      results.errors.push(`${head} … → ${err.message.split('\n')[0]}`);
      console.warn(`[install-susu-overlay] statement failed (continuing): ${head}\n  ${err.message.split('\n')[0]}`);
    }
  }
  return results;
}

module.exports = { installSusuOverlay: install };

// Allow running standalone: `node infra/install-susu-overlay.js`
if (require.main === module) {
  install()
    .then((r) => {
      console.log(`[install-susu-overlay] done: ${r.ok} ok, ${r.failed} failed`);
      if (r.errors.length) console.log(r.errors.join('\n'));
      return prisma.$disconnect();
    })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[install-susu-overlay] fatal:', e.message);
      process.exit(1);
    });
}
