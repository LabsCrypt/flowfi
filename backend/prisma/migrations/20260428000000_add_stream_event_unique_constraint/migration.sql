-- AddUniqueConstraint
ALTER TABLE "StreamEvent" ADD CONSTRAINT "StreamEvent_transactionHash_eventType_key" UNIQUE ("transactionHash", "eventType");
