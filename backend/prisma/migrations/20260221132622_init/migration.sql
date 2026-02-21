-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Stream" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "streamId" INTEGER NOT NULL,
    "sender" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "ratePerSecond" TEXT NOT NULL,
    "depositedAmount" TEXT NOT NULL,
    "withdrawnAmount" TEXT NOT NULL,
    "startTime" INTEGER NOT NULL,
    "lastUpdateTime" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Stream_sender_fkey" FOREIGN KEY ("sender") REFERENCES "User" ("publicKey") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Stream_recipient_fkey" FOREIGN KEY ("recipient") REFERENCES "User" ("publicKey") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StreamEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "streamId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "amount" TEXT,
    "transactionHash" TEXT NOT NULL,
    "ledgerSequence" INTEGER NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StreamEvent_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "Stream" ("streamId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_publicKey_key" ON "User"("publicKey");

-- CreateIndex
CREATE INDEX "User_publicKey_idx" ON "User"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "Stream_streamId_key" ON "Stream"("streamId");

-- CreateIndex
CREATE INDEX "Stream_sender_idx" ON "Stream"("sender");

-- CreateIndex
CREATE INDEX "Stream_recipient_idx" ON "Stream"("recipient");

-- CreateIndex
CREATE INDEX "Stream_streamId_idx" ON "Stream"("streamId");

-- CreateIndex
CREATE INDEX "Stream_isActive_idx" ON "Stream"("isActive");

-- CreateIndex
CREATE INDEX "StreamEvent_streamId_idx" ON "StreamEvent"("streamId");

-- CreateIndex
CREATE INDEX "StreamEvent_eventType_idx" ON "StreamEvent"("eventType");

-- CreateIndex
CREATE INDEX "StreamEvent_timestamp_idx" ON "StreamEvent"("timestamp");

-- CreateIndex
CREATE INDEX "StreamEvent_transactionHash_idx" ON "StreamEvent"("transactionHash");
