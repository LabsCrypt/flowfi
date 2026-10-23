CREATE TABLE "TokenRegistry" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "iconUrl" TEXT,
    "issuerAddress" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TokenRegistry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TokenRegistry_contractAddress_key" ON "TokenRegistry"("contractAddress");
CREATE INDEX "TokenRegistry_contractAddress_idx" ON "TokenRegistry"("contractAddress");
CREATE INDEX "TokenRegistry_symbol_idx" ON "TokenRegistry"("symbol");