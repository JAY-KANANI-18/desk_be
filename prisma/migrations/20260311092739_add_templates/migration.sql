/*
  Warnings:

  - Added the required column `metaId` to the `WhatsAppTemplate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `variables` to the `WhatsAppTemplate` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."WhatsAppTemplate" ADD COLUMN     "metaId" TEXT NOT NULL,
ADD COLUMN     "rejectedReason" TEXT,
ADD COLUMN     "syncedAt" TIMESTAMP(3),
ADD COLUMN     "variables" JSONB NOT NULL;

-- CreateTable
CREATE TABLE "public"."MetaPageTemplate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "channelType" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "name" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "metaId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaPageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaPageTemplate_workspaceId_channelId_idx" ON "public"."MetaPageTemplate"("workspaceId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaPageTemplate_workspaceId_channelId_metaId_key" ON "public"."MetaPageTemplate"("workspaceId", "channelId", "metaId");

-- AddForeignKey
ALTER TABLE "public"."MetaPageTemplate" ADD CONSTRAINT "MetaPageTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
