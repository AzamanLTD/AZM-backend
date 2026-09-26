-- CreateTable: CurrencyWallet
CREATE TABLE "CurrencyWallet" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "balance" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrencyWallet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CurrencyWallet_userId_currency_key" ON "CurrencyWallet"("userId", "currency");
CREATE INDEX "CurrencyWallet_userId_idx" ON "CurrencyWallet"("userId");

-- CreateTable: FxRate
CREATE TABLE "FxRate" (
    "id" SERIAL NOT NULL,
    "fromCurrency" VARCHAR(8) NOT NULL,
    "toCurrency" VARCHAR(8) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'platform',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FxRate_fromCurrency_toCurrency_key" ON "FxRate"("fromCurrency", "toCurrency");

-- CreateTable: CurrencyConversion
CREATE TABLE "CurrencyConversion" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "fromCurrency" VARCHAR(8) NOT NULL,
    "toCurrency" VARCHAR(8) NOT NULL,
    "fromAmount" DECIMAL(20,8) NOT NULL,
    "toAmount" DECIMAL(20,8) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "feeUsdc" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CurrencyConversion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CurrencyConversion_userId_createdAt_idx" ON "CurrencyConversion"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "CurrencyWallet" ADD CONSTRAINT "CurrencyWallet_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CurrencyConversion" ADD CONSTRAINT "CurrencyConversion_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
