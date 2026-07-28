-- Phase 3.3.4: Message pin, star, forward support

-- DirectMessage: add pin/star columns
ALTER TABLE "DirectMessage" ADD COLUMN "isPinned"  BOOLEAN  NOT NULL DEFAULT false;
ALTER TABLE "DirectMessage" ADD COLUMN "isStarred" BOOLEAN  NOT NULL DEFAULT false;
ALTER TABLE "DirectMessage" ADD COLUMN "pinnedAt"  TIMESTAMP(3);

-- GroupMessage: add pin/star columns
ALTER TABLE "GroupMessage" ADD COLUMN "isPinned"  BOOLEAN  NOT NULL DEFAULT false;
ALTER TABLE "GroupMessage" ADD COLUMN "isStarred" BOOLEAN  NOT NULL DEFAULT false;
ALTER TABLE "GroupMessage" ADD COLUMN "pinnedAt"  TIMESTAMP(3);

-- Message (trade chat): add pin/star columns
ALTER TABLE "Message" ADD COLUMN "isPinned"  BOOLEAN  NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "isStarred" BOOLEAN  NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "pinnedAt"  TIMESTAMP(3);

-- Index for querying starred messages per user
CREATE INDEX "DirectMessage_receiverId_isStarred_createdAt_idx" ON "DirectMessage"("receiverId", "isStarred", "createdAt" DESC);
CREATE INDEX "DirectMessage_senderId_isStarred_createdAt_idx"    ON "DirectMessage"("senderId", "isStarred", "createdAt" DESC);

-- Index for pinned messages per conversation
CREATE INDEX "DirectMessage_friendshipId_isPinned_idx"  ON "DirectMessage"("friendshipId", "isPinned", "pinnedAt" DESC);
CREATE INDEX "GroupMessage_groupId_isPinned_idx"         ON "GroupMessage"("groupId", "isPinned", "pinnedAt" DESC);
