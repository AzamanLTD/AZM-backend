-- Phase UI-4 (2026-05-26): Tickets Engine
--
-- Adds:
--   • TicketType + TicketStatus enums
--   • Ticket + TicketMessage tables
--   • Friendship.localNicknames JSON column (also used by Phase UI-5
--     Chat Profile Detail screen for per-friendship nickname overrides)

-- ── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE "TicketType" AS ENUM ('BUY', 'SELL', 'ESCROW', 'SERVICE_SWAP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Friendship.localNicknames (Phase UI-5 prep) ─────────────────────────────
ALTER TABLE "Friendship"
  ADD COLUMN IF NOT EXISTS "localNicknames" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── Ticket table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Ticket" (
    "id"              TEXT NOT NULL,
    "friendshipId"    TEXT NOT NULL,
    "creatorId"       INTEGER NOT NULL,
    "counterpartyId"  INTEGER NOT NULL,
    "name"            VARCHAR(80) NOT NULL,
    "type"            "TicketType" NOT NULL,
    "targetAmount"    DECIMAL(20, 8) NOT NULL,
    "targetCurrency"  VARCHAR(8) NOT NULL,
    "memo"            VARCHAR(500),
    "status"          "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "closedAt"        TIMESTAMP(3),
    "cancelledAt"     TIMESTAMP(3),
    "lastActivityAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Ticket_friendshipId_idx" ON "Ticket"("friendshipId");
CREATE INDEX IF NOT EXISTS "Ticket_creatorId_idx" ON "Ticket"("creatorId");
CREATE INDEX IF NOT EXISTS "Ticket_counterpartyId_idx" ON "Ticket"("counterpartyId");
CREATE INDEX IF NOT EXISTS "Ticket_status_idx" ON "Ticket"("status");
CREATE INDEX IF NOT EXISTS "Ticket_friendshipId_status_lastActivityAt_idx"
    ON "Ticket"("friendshipId", "status", "lastActivityAt" DESC);

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_friendshipId_fkey"
    FOREIGN KEY ("friendshipId") REFERENCES "Friendship"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_counterpartyId_fkey"
    FOREIGN KEY ("counterpartyId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── TicketMessage table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TicketMessage" (
    "id"                 TEXT NOT NULL,
    "ticketId"           TEXT NOT NULL,
    "senderId"           INTEGER NOT NULL,
    "type"               TEXT NOT NULL DEFAULT 'TEXT',
    "content"            TEXT,
    "metadata"           JSONB,
    "mediaUrl"           TEXT,
    "mediaType"          TEXT,
    "mediaMimeType"      TEXT,
    "mediaSize"          INTEGER,
    "mediaDuration"      INTEGER,
    "mediaWaveformPeaks" JSONB,
    "linkPreview"        JSONB,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TicketMessage_ticketId_idx" ON "TicketMessage"("ticketId");
CREATE INDEX IF NOT EXISTS "TicketMessage_senderId_idx" ON "TicketMessage"("senderId");
CREATE INDEX IF NOT EXISTS "TicketMessage_ticketId_createdAt_idx"
    ON "TicketMessage"("ticketId", "createdAt" DESC);

ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
