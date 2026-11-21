-- The notification, webhook and alert models below existed in schema.prisma but no
-- migration ever created their tables: preview environments pushed them with
-- `prisma db push`, which is exactly the drift that hid a broken migration
-- history. This migration brings a fresh `prisma migrate deploy` database up to
-- the schema the application expects.

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "secretKey" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AlertHistory" (
    "id" TEXT NOT NULL,
    "streamId" BIGINT NOT NULL,
    "alertType" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlertHistory_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "telegramChatId" TEXT,
    "discordWebhook" TEXT,
    "events" TEXT[] DEFAULT ARRAY['STREAM_CREATED', 'CLIFF_REACHED', 'RUNWAY_WARNING', 'TOKENS_CLAIMED']::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "LinkCode" (
    "code" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LinkCode_pkey" PRIMARY KEY ("code")
);
-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "WebhookSubscription_userAddress_idx" ON "WebhookSubscription"("userAddress");
-- CreateIndex
CREATE INDEX "WebhookSubscription_isActive_idx" ON "WebhookSubscription"("isActive");
-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_idx" ON "WebhookDelivery"("subscriptionId");
-- CreateIndex
CREATE INDEX "WebhookDelivery_createdAt_idx" ON "WebhookDelivery"("createdAt");
-- CreateIndex
CREATE INDEX "AlertHistory_streamId_idx" ON "AlertHistory"("streamId");
-- CreateIndex
CREATE INDEX "AlertHistory_sentAt_idx" ON "AlertHistory"("sentAt");
-- CreateIndex
CREATE UNIQUE INDEX "AlertHistory_streamId_alertType_sentAt_key" ON "AlertHistory"("streamId", "alertType", "sentAt");
-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
-- CreateIndex
CREATE INDEX "PushSubscription_address_idx" ON "PushSubscription"("address");
-- CreateIndex
CREATE UNIQUE INDEX "NotificationChannel_address_key" ON "NotificationChannel"("address");
-- CreateIndex
CREATE INDEX "LinkCode_address_idx" ON "LinkCode"("address");
-- CreateIndex
CREATE INDEX "NotificationLog_address_createdAt_idx" ON "NotificationLog"("address", "createdAt");
-- CreateIndex
CREATE INDEX "StreamEvent_createdAt_idx" ON "StreamEvent"("createdAt");
-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
