-- §P.5-B authoritative USDC inventory-lot substrate.
-- InventoryLot is the ONLY lot authority; CorporatePurchaseLog stays an
-- untouched audit log. Quantities are exact decimals; DB CHECKs make the
-- bounds (0 <= remaining <= original, positive cost/quantity) unconditional.
ALTER TYPE "JournalEntryType" ADD VALUE IF NOT EXISTS 'INVENTORY_ACQUISITION';

CREATE TYPE "InventoryLotStatus" AS ENUM ('OPEN', 'CONSUMED');

CREATE TABLE "InventoryLot" (
    "id" SERIAL NOT NULL,
    "acquisitionKey" VARCHAR(140) NOT NULL,
    "sourceType" VARCHAR(40) NOT NULL,
    "sourceReference" VARCHAR(140) NOT NULL,
    "quantityOriginal" DECIMAL(20,8) NOT NULL,
    "quantityRemaining" DECIMAL(20,8) NOT NULL,
    "costBasisGhs" DECIMAL(20,8) NOT NULL,
    "acquisitionRate" DECIMAL(18,8),
    "ledgerTxnId" TEXT,
    "status" "InventoryLotStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryLot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryLot_acquisitionKey_key" ON "InventoryLot"("acquisitionKey");

CREATE TABLE "InventoryLotConsumption" (
    "id" SERIAL NOT NULL,
    "consumptionKey" VARCHAR(140) NOT NULL,
    "lotId" INTEGER NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "purpose" VARCHAR(40) NOT NULL,
    "sourceReference" VARCHAR(140),
    "ledgerTxnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryLotConsumption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryLotConsumption_consumptionKey_key" ON "InventoryLotConsumption"("consumptionKey");
CREATE INDEX "InventoryLotConsumption_lotId_idx" ON "InventoryLotConsumption"("lotId");
ALTER TABLE "InventoryLotConsumption" ADD CONSTRAINT "InventoryLotConsumption_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "InventoryLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_qty_positive_check" CHECK ("quantityOriginal" > 0);
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_remaining_bounds_check" CHECK ("quantityRemaining" >= 0 AND "quantityRemaining" <= "quantityOriginal");
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_cost_positive_check" CHECK ("costBasisGhs" > 0);
ALTER TABLE "InventoryLotConsumption" ADD CONSTRAINT "InventoryLotConsumption_qty_positive_check" CHECK ("quantity" > 0);
