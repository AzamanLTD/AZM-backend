-- CreateTable
CREATE TABLE "BusinessOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "unitPrice" DECIMAL(20,8) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" VARCHAR(500),
    "lineTotal" DECIMAL(20,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessOrderItem_orderId_idx" ON "BusinessOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "BusinessOrderItem_productId_idx" ON "BusinessOrderItem"("productId");

-- AddForeignKey
ALTER TABLE "BusinessOrderItem" ADD CONSTRAINT "BusinessOrderItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "BusinessOrder"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOrderItem" ADD CONSTRAINT "BusinessOrderItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "BusinessProduct"("id");
