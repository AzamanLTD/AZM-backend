-- CreateTable: AzmGift
CREATE TABLE "AzmGift" (
    "id" TEXT NOT NULL,
    "senderId" INTEGER NOT NULL,
    "receiverId" INTEGER NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "message" TEXT,
    "contextType" VARCHAR(20),
    "contextId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AzmGift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AzmGift_senderId_createdAt_idx" ON "AzmGift"("senderId", "createdAt" DESC);
CREATE INDEX "AzmGift_receiverId_createdAt_idx" ON "AzmGift"("receiverId", "createdAt" DESC);
CREATE INDEX "AzmGift_contextType_contextId_idx" ON "AzmGift"("contextType", "contextId");

-- AddForeignKey
ALTER TABLE "AzmGift" ADD CONSTRAINT "AzmGift_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AzmGift" ADD CONSTRAINT "AzmGift_receiverId_fkey"
    FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
