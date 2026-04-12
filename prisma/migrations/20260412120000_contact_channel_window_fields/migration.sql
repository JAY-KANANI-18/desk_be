ALTER TABLE "ContactChannel"
ADD COLUMN "lastMessageTime" BIGINT,
ADD COLUMN "lastIncomingMessageTime" BIGINT,
ADD COLUMN "lastCallInteractionTime" BIGINT,
ADD COLUMN "messageWindowExpiry" BIGINT,
ADD COLUMN "conversationWindowCategory" JSONB,
ADD COLUMN "call_permission" BOOLEAN,
ADD COLUMN "hasPermanentCallPermission" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
