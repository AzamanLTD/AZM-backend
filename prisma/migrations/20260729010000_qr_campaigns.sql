-- CreateTable: QR Campaigns for multi-campaign QR Forge
CREATE TABLE "QrCampaign" (
    "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name"        VARCHAR(200) NOT NULL,
    "slug"        VARCHAR(100) NOT NULL UNIQUE,
    "destinationUrl" TEXT NOT NULL,
    "label"       VARCHAR(200) NOT NULL DEFAULT 'Azaman QR',
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "totalScans"  INTEGER NOT NULL DEFAULT 0
);

-- Add campaignId to QrScan
ALTER TABLE "QrScan" ADD COLUMN "campaignId" TEXT REFERENCES "QrCampaign"("id") ON DELETE SET NULL;
CREATE INDEX "qr_scan_campaign_id" ON "QrScan" ("campaignId");
