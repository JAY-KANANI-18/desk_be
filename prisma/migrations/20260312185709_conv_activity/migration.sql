-- CreateTable
CREATE TABLE "public"."ConversationActivity" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorId" UUID,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "subjectUserId" UUID,
    "subjectTeamId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationActivity_conversationId_createdAt_idx" ON "public"."ConversationActivity"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationActivity_workspaceId_idx" ON "public"."ConversationActivity"("workspaceId");

-- CreateIndex
CREATE INDEX "ConversationActivity_eventType_idx" ON "public"."ConversationActivity"("eventType");

-- AddForeignKey
ALTER TABLE "public"."ConversationActivity" ADD CONSTRAINT "ConversationActivity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationActivity" ADD CONSTRAINT "ConversationActivity_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationActivity" ADD CONSTRAINT "ConversationActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationActivity" ADD CONSTRAINT "ConversationActivity_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationActivity" ADD CONSTRAINT "ConversationActivity_subjectTeamId_fkey" FOREIGN KEY ("subjectTeamId") REFERENCES "public"."Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
