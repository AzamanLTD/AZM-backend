-- Phase UI-3 (2026-05-26): Chat Media Infrastructure
--
-- Adds:
--   • Five new MessageType enum values (IMAGE, VIDEO, DOCUMENT, AUDIO, LINK)
--   • Six new DirectMessageType enum values (IMAGE, VIDEO, DOCUMENT, AUDIO,
--     LINK, TICKET_LINK — TICKET_LINK is reserved for Phase UI-4)
--   • Seven new media columns on both Message and DirectMessage
--   • LinkPreviewCache table for server-side Open Graph metadata cache

-- ── MessageType enum extension ──────────────────────────────────────────────
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'IMAGE';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'VIDEO';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'DOCUMENT';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'AUDIO';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'LINK';

-- ── DirectMessageType enum extension ────────────────────────────────────────
ALTER TYPE "DirectMessageType" ADD VALUE IF NOT EXISTS 'IMAGE';
ALTER TYPE "DirectMessageType" ADD VALUE IF NOT EXISTS 'VIDEO';
ALTER TYPE "DirectMessageType" ADD VALUE IF NOT EXISTS 'DOCUMENT';
ALTER TYPE "DirectMessageType" ADD VALUE IF NOT EXISTS 'AUDIO';
ALTER TYPE "DirectMessageType" ADD VALUE IF NOT EXISTS 'LINK';
ALTER TYPE "DirectMessageType" ADD VALUE IF NOT EXISTS 'TICKET_LINK';

-- ── Message media columns ───────────────────────────────────────────────────
ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "mediaUrl"           TEXT,
  ADD COLUMN IF NOT EXISTS "mediaType"          TEXT,
  ADD COLUMN IF NOT EXISTS "mediaMimeType"      TEXT,
  ADD COLUMN IF NOT EXISTS "mediaSize"          INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaDuration"      INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaWaveformPeaks" JSONB,
  ADD COLUMN IF NOT EXISTS "linkPreview"        JSONB;

-- ── DirectMessage media columns ─────────────────────────────────────────────
ALTER TABLE "DirectMessage"
  ADD COLUMN IF NOT EXISTS "mediaUrl"           TEXT,
  ADD COLUMN IF NOT EXISTS "mediaType"          TEXT,
  ADD COLUMN IF NOT EXISTS "mediaMimeType"      TEXT,
  ADD COLUMN IF NOT EXISTS "mediaSize"          INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaDuration"      INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaWaveformPeaks" JSONB,
  ADD COLUMN IF NOT EXISTS "linkPreview"        JSONB;

-- ── LinkPreviewCache table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LinkPreviewCache" (
    "id"          TEXT NOT NULL,
    "urlHash"     TEXT NOT NULL,
    "url"         TEXT NOT NULL,
    "title"       TEXT,
    "description" TEXT,
    "image"       TEXT,
    "favicon"     TEXT,
    "siteName"    TEXT,
    "status"      TEXT NOT NULL DEFAULT 'OK',
    "fetchedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LinkPreviewCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LinkPreviewCache_urlHash_key" ON "LinkPreviewCache"("urlHash");
CREATE INDEX IF NOT EXISTS "LinkPreviewCache_urlHash_idx" ON "LinkPreviewCache"("urlHash");
CREATE INDEX IF NOT EXISTS "LinkPreviewCache_expiresAt_idx" ON "LinkPreviewCache"("expiresAt");
