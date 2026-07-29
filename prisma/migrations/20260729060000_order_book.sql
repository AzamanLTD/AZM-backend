-- CreateTable: OrderBookOrder
CREATE TABLE "OrderBookOrder" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "side" VARCHAR(4) NOT NULL,
    "type" VARCHAR(6) NOT NULL,
    "price" DECIMAL(18,8),
    "quantity" DECIMAL(20,8) NOT NULL,
    "remainingQuantity" DECIMAL(20,8) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderBookOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderBookOrder_pair_side_status_price_idx" ON "OrderBookOrder"("pair", "side", "status", "price");
CREATE INDEX "OrderBookOrder_userId_createdAt_idx" ON "OrderBookOrder"("userId", "createdAt" DESC);

-- CreateTable: OrderBookTrade
CREATE TABLE "OrderBookTrade" (
    "id" TEXT NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "makerOrderId" TEXT NOT NULL,
    "takerOrderId" TEXT NOT NULL,
    "price" DECIMAL(18,8) NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "makerFee" DECIMAL(20,8) NOT NULL,
    "takerFee" DECIMAL(20,8) NOT NULL,
    "makerUserId" INTEGER NOT NULL,
    "takerUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderBookTrade_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderBookTrade_pair_createdAt_idx" ON "OrderBookTrade"("pair", "createdAt" DESC);
CREATE INDEX "OrderBookTrade_makerUserId_idx" ON "OrderBookTrade"("makerUserId");
CREATE INDEX "OrderBookTrade_takerUserId_idx" ON "OrderBookTrade"("takerUserId");

-- AddForeignKey
ALTER TABLE "OrderBookOrder" ADD CONSTRAINT "OrderBookOrder_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderBookTrade" ADD CONSTRAINT "OrderBookTrade_makerOrderId_fkey"
    FOREIGN KEY ("makerOrderId") REFERENCES "OrderBookOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderBookTrade" ADD CONSTRAINT "OrderBookTrade_takerOrderId_fkey"
    FOREIGN KEY ("takerOrderId") REFERENCES "OrderBookOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderBookTrade" ADD CONSTRAINT "OrderBookTrade_makerUserId_fkey"
    FOREIGN KEY ("makerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderBookTrade" ADD CONSTRAINT "OrderBookTrade_takerUserId_fkey"
    FOREIGN KEY ("takerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
