-- =============================================================================
-- BASELINE: pre-escrow db-push drift (2026-06-14)
-- =============================================================================
-- This migration BACKFILLS the schema changes that had been applied to the
-- database via `prisma db push` (or manual SQL) during earlier development but
-- were never captured as migration files: the GroupJoinRequest model + enum,
-- Susu fee/grace fields, User.azamanId/discoverable/phoneHash, AdminWarRoomAlert
-- resolution fields, GlobalSettings.susuProfitPct, and related FKs/indexes.
--
-- Because the live database ALREADY contains all of these objects, this
-- migration is marked as applied via `prisma migrate resolve --applied` rather
-- than executed against existing environments. It exists so the migration
-- history matches schema.prisma, unblocking `prisma migrate dev` for the Smart
-- Escrow feature that follows. On a fresh database it replays cleanly.
--
-- !! PRODUCTION DEPLOY — REQUIRED ONE-TIME STEP !!
-- Your production database was managed with `prisma db push`, so every object
-- below ALREADY exists there. Running this SQL on production would fail with
-- "relation already exists" / "value already exists". BEFORE the first
-- `prisma migrate deploy` on production, mark this migration as applied WITHOUT
-- executing it:
--
--     npx prisma migrate resolve --applied 20260614000000_baseline_db_push_drift
--
-- Do this once per environment. After that, normal `prisma migrate deploy`
-- (run by `npm run release` on Render) applies only the escrow migration.
-- See DEPLOY_RUNBOOK.md in the project root for the full procedure and the
-- new environment variables to set on Render.
-- =============================================================================

-- CreateEnum
CREATE TYPE "public"."GroupJoinRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "public"."ProfitSource" ADD VALUE 'SUSU_FEE';

-- AlterEnum
ALTER TYPE "public"."SusuCycleStatus" ADD VALUE 'COLLECTING_GRACE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."TransactionType" ADD VALUE 'SUSU_REFUND';
ALTER TYPE "public"."TransactionType" ADD VALUE 'SUSU_PROFIT';

-- AlterTable
ALTER TABLE "public"."AdminWarRoomAlert" ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedBy" INTEGER;

-- AlterTable
ALTER TABLE "public"."GlobalSettings" ADD COLUMN     "susuProfitPct" DECIMAL(10,4) NOT NULL DEFAULT 0.03;

-- AlterTable
ALTER TABLE "public"."GroupMember" ADD COLUMN     "addedById" INTEGER,
ADD COLUMN     "vouchedById" INTEGER;

-- AlterTable
ALTER TABLE "public"."LiabilityAcceptance" ADD COLUMN     "acknowledgedClauses" JSONB,
ADD COLUMN     "voucherUserId" INTEGER;

-- AlterTable
ALTER TABLE "public"."SusuCycle" ADD COLUMN     "feeUsdc" DECIMAL(20,8),
ADD COLUMN     "graceUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."SusuGroup" ADD COLUMN     "initiatedById" INTEGER,
ADD COLUMN     "initiationDeadline" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."SusuMember" ADD COLUMN     "autoRetainNextCycle" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "azamanId" TEXT,
ADD COLUMN     "discoverable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "phoneHash" TEXT;

-- CreateTable
CREATE TABLE "public"."GroupJoinRequest" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "proposerId" INTEGER NOT NULL,
    "targetUserId" INTEGER NOT NULL,
    "note" TEXT,
    "status" "public"."GroupJoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupJoinRequest_groupId_status_idx" ON "public"."GroupJoinRequest"("groupId" ASC, "status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "GroupJoinRequest_groupId_targetUserId_status_key" ON "public"."GroupJoinRequest"("groupId" ASC, "targetUserId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "GroupJoinRequest_targetUserId_status_idx" ON "public"."GroupJoinRequest"("targetUserId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "LiabilityAcceptance_voucherUserId_idx" ON "public"."LiabilityAcceptance"("voucherUserId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_azamanId_key" ON "public"."User"("azamanId" ASC);

-- CreateIndex
CREATE INDEX "User_phoneHash_idx" ON "public"."User"("phoneHash" ASC);

-- AddForeignKey
ALTER TABLE "public"."GroupJoinRequest" ADD CONSTRAINT "GroupJoinRequest_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."GroupChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GroupJoinRequest" ADD CONSTRAINT "GroupJoinRequest_proposerId_fkey" FOREIGN KEY ("proposerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GroupJoinRequest" ADD CONSTRAINT "GroupJoinRequest_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LiabilityAcceptance" ADD CONSTRAINT "LiabilityAcceptance_voucherUserId_fkey" FOREIGN KEY ("voucherUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
