-- CreateTable
CREATE TABLE "public"."ContactChannel" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "channelType" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactChannel_workspaceId_identifier_idx" ON "public"."ContactChannel"("workspaceId", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "ContactChannel_workspaceId_channelId_identifier_key" ON "public"."ContactChannel"("workspaceId", "channelId", "identifier");

-- AddForeignKey
ALTER TABLE "public"."ContactChannel" ADD CONSTRAINT "ContactChannel_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContactChannel" ADD CONSTRAINT "ContactChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContactChannel" ADD CONSTRAINT "ContactChannel_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "public"."Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
