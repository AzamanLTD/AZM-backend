-- Phase I — composite indexes for cursor pagination
--
-- Each index targets a list endpoint that previously required a sequential
-- scan on a `(filter_col, createdAt DESC)` shape. After this migration:
--
--   GET /api/notifications              → idx_notification_user_created_desc
--   GET /api/notifications?unreadOnly=1 → idx_notification_user_unread_created_desc
--   GET /api/chat/:tradeId              → idx_message_conversation_created_desc
--   GET /api/friends/chat/:id           → idx_directmessage_friendship_created_desc
--   GET /api/ads (marketplace)          → idx_ad_status_created_desc
--   GET /api/ads/mine (vendor)          → idx_ad_vendor_created_desc
--   GET /api/trades/history             → idx_trade_user_created_desc + idx_trade_vendor_created_desc
--                                         (OR predicate — Postgres needs both shapes)
--   admin filters by status             → idx_trade_status
--
-- IMPORTANT: Prisma migrate runs each statement inside an implicit
-- transaction and CREATE INDEX CONCURRENTLY is illegal inside a
-- transaction. Plain CREATE INDEX is used; on a small table this finishes
-- in milliseconds. If/when production data outgrows that, swap to a manual
-- ops runbook with `CREATE INDEX CONCURRENTLY` outside Prisma.

CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx"
    ON "Notification" ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "Notification_userId_isRead_createdAt_idx"
    ON "Notification" ("userId", "isRead", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx"
    ON "Message" ("conversationId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "DirectMessage_friendshipId_createdAt_idx"
    ON "DirectMessage" ("friendshipId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "Ad_status_createdAt_idx"
    ON "Ad" ("status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "Ad_vendorId_createdAt_idx"
    ON "Ad" ("vendorId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "Trade_userId_createdAt_idx"
    ON "Trade" ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "Trade_vendorId_createdAt_idx"
    ON "Trade" ("vendorId", "createdAt" DESC);


-- Phase I — review-pass addition: friendship list also needs index coverage.
-- Query: WHERE status='ACCEPTED' AND (requesterId=X OR addresseeId=X)
--        ORDER BY updatedAt DESC LIMIT N. Postgres BitmapOrs both composites
--        for the filter step (index-only) and Sort/Top-N's the merged set
--        afterwards — the indexes don't deliver pre-sorted rows for an
--        OR predicate. Net win is still substantial: filter goes from a
--        sequential scan to two index-only seeks.

CREATE INDEX IF NOT EXISTS "Friendship_requesterId_status_updatedAt_idx"
    ON "Friendship" ("requesterId", "status", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS "Friendship_addresseeId_status_updatedAt_idx"
    ON "Friendship" ("addresseeId", "status", "updatedAt" DESC);
