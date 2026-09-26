-- Disappearing messages support (Phase 2)
-- Add disappearAfterSeconds + expiresAt to all three message tables

-- Message
ALTER TABLE "Message" ADD COLUMN "disappearAfterSeconds" INTEGER;
ALTER TABLE "Message" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "Message_expiresAt_idx" ON "Message"("expiresAt");

-- DirectMessage
ALTER TABLE "DirectMessage" ADD COLUMN "disappearAfterSeconds" INTEGER;
ALTER TABLE "DirectMessage" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "DirectMessage_expiresAt_idx" ON "DirectMessage"("expiresAt");

-- GroupMessage
ALTER TABLE "GroupMessage" ADD COLUMN "disappearAfterSeconds" INTEGER;
ALTER TABLE "GroupMessage" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "GroupMessage_expiresAt_idx" ON "GroupMessage"("expiresAt");
