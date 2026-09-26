-- Phase Q12: Rate Alert System
-- Users can set price alerts: "Notify me when USD/GHS crosses X"
-- The oracle service checks all active alerts on each rate sync.

CREATE TABLE "RateAlert" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId" INTEGER NOT NULL,
    "targetRate" DECIMAL(18, 8) NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'ABOVE',
    "ratePair" TEXT NOT NULL DEFAULT 'USD_GHS',
    "isTriggered" BOOLEAN NOT NULL DEFAULT false,
    "triggeredAt" TIMESTAMP(3),
    "triggeredRate" DECIMAL(18, 8),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateAlert_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RateAlert_targetRate_positive" CHECK ("targetRate" > 0),
    CONSTRAINT "RateAlert_direction_valid" CHECK ("direction" IN ('ABOVE', 'BELOW'))
);

-- Foreign key
ALTER TABLE "RateAlert" ADD CONSTRAINT "RateAlert_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes for efficient alert checking
CREATE INDEX "RateAlert_active_alerts" ON "RateAlert"("isActive", "isTriggered", "direction", "targetRate");
CREATE INDEX "RateAlert_userId_createdAt" ON "RateAlert"("userId", "createdAt" DESC);
