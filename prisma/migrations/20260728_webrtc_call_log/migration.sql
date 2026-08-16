-- CreateTable
CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "callerId" INTEGER NOT NULL,
    "calleeId" INTEGER NOT NULL,
    "type" "CallType" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "offerSdp" TEXT,
    "answerSdp" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "packetsLost" INTEGER NOT NULL DEFAULT 0,
    "jitterMs" INTEGER NOT NULL DEFAULT 0,
    "roundTripMs" INTEGER NOT NULL DEFAULT 0,
    "audioBitrate" INTEGER NOT NULL DEFAULT 0,
    "videoBitrate" INTEGER NOT NULL DEFAULT 0,
    "tradeId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('VOICE', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACCEPTED', 'REJECTED', 'MISSED', 'ENDED', 'FAILED', 'BUSY');

-- CreateIndex
CREATE INDEX "CallLog_callerId_createdAt_idx" ON "CallLog"("callerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CallLog_calleeId_createdAt_idx" ON "CallLog"("calleeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CallLog_status_createdAt_idx" ON "CallLog"("status", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_callerId_fkey"
    FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_calleeId_fkey"
    FOREIGN KEY ("calleeId") REFERENCES "User"("id") ON DELETE CASCADE;
