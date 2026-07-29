-- CreateTable: ProofOfReservesSnapshot
CREATE TABLE "ProofOfReservesSnapshot" (
    "id" SERIAL NOT NULL,
    "totalLiabilities" DECIMAL(20,8) NOT NULL,
    "totalReserves" DECIMAL(20,8) NOT NULL,
    "reserveRatio" DECIMAL(10,4) NOT NULL,
    "isFullyBacked" BOOLEAN NOT NULL DEFAULT true,
    "userCount" INTEGER NOT NULL,
    "merkleRoot" VARCHAR(64) NOT NULL,
    "salt" TEXT NOT NULL,
    "breakdown" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProofOfReservesSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProofOfReservesSnapshot_createdAt_idx" ON "ProofOfReservesSnapshot"("createdAt" DESC);
