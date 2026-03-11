/*
  Warnings:

  - The primary key for the `MessageAttachment` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `Notification` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `data` on the `Notification` table. All the data in the column will be lost.
  - You are about to drop the column `read` on the `Notification` table. All the data in the column will be lost.
  - You are about to drop the column `readAt` on the `Notification` table. All the data in the column will be lost.
  - You are about to drop the column `workspaceId` on the `Notification` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `Team` table. All the data in the column will be lost.
  - The primary key for the `TeamMember` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `WhatsAppTemplate` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `nodes` on the `Workflow` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Workflow` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[lastMessageId]` on the table `Conversation` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[teamId,userId]` on the table `TeamMember` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[workspaceId,channelId,name,language]` on the table `WhatsAppTemplate` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `id` on the `MessageAttachment` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `Notification` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `type` on the `Notification` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - The required column `id` was added to the `TeamMember` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Changed the type of `id` on the `WhatsAppTemplate` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "public"."MessageAttachment" DROP CONSTRAINT "MessageAttachment_messageId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Notification" DROP CONSTRAINT "Notification_userId_fkey";

-- DropIndex
DROP INDEX "public"."Notification_userId_createdAt_idx";

-- DropIndex
DROP INDEX "public"."Notification_workspaceId_idx";

-- DropIndex
DROP INDEX "public"."Team_workspaceId_idx";

-- DropIndex
DROP INDEX "public"."Workflow_workspaceId_idx";

-- AlterTable
ALTER TABLE "public"."Channel" ADD COLUMN     "credentials" JSONB;

-- AlterTable
ALTER TABLE "public"."ContactChannel" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "profileRaw" JSONB;

-- AlterTable
ALTER TABLE "public"."Conversation" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'open',
ADD COLUMN     "subject" TEXT;

-- AlterTable
ALTER TABLE "public"."Message" ADD COLUMN     "rawPayload" JSONB,
ADD COLUMN     "replyToChannelMsgId" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "subject" TEXT,
ALTER COLUMN "type" SET DEFAULT 'text',
ALTER COLUMN "direction" SET DEFAULT 'incoming';

-- AlterTable
ALTER TABLE "public"."MessageAttachment" DROP CONSTRAINT "MessageAttachment_pkey",
ADD COLUMN     "assetId" UUID,
ADD COLUMN     "duration" INTEGER,
ADD COLUMN     "externalMediaId" TEXT,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "providerUrl" TEXT,
ADD COLUMN     "width" INTEGER,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ALTER COLUMN "url" DROP NOT NULL,
ADD CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."Notification" DROP CONSTRAINT "Notification_pkey",
DROP COLUMN "data",
DROP COLUMN "read",
DROP COLUMN "readAt",
DROP COLUMN "workspaceId",
ADD COLUMN     "isRead" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "metadata" JSONB,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "type",
ADD COLUMN     "type" TEXT NOT NULL,
ALTER COLUMN "body" DROP NOT NULL,
ADD CONSTRAINT "Notification_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."Team" DROP COLUMN "description";

-- AlterTable
ALTER TABLE "public"."TeamMember" DROP CONSTRAINT "TeamMember_pkey",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."WhatsAppTemplate" DROP CONSTRAINT "WhatsAppTemplate_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."Workflow" DROP COLUMN "nodes",
DROP COLUMN "status",
ADD COLUMN     "config" JSONB,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "trigger" SET DATA TYPE TEXT;

-- CreateTable
CREATE TABLE "public"."MediaAsset" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "filename" TEXT,
    "size" INTEGER,
    "externalMediaId" TEXT,
    "sourceChannelType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OutboundQueue" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "to" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MessageTemplate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channelType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables" JSONB,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaAsset_workspaceId_externalMediaId_idx" ON "public"."MediaAsset"("workspaceId", "externalMediaId");

-- CreateIndex
CREATE INDEX "MediaAsset_workspaceId_url_idx" ON "public"."MediaAsset"("workspaceId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundQueue_messageId_key" ON "public"."OutboundQueue"("messageId");

-- CreateIndex
CREATE INDEX "OutboundQueue_status_scheduledAt_idx" ON "public"."OutboundQueue"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "OutboundQueue_workspaceId_channelId_idx" ON "public"."OutboundQueue"("workspaceId", "channelId");

-- CreateIndex
CREATE INDEX "MessageTemplate_workspaceId_channelType_idx" ON "public"."MessageTemplate"("workspaceId", "channelType");

-- CreateIndex
CREATE INDEX "Channel_type_identifier_idx" ON "public"."Channel"("type", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_lastMessageId_key" ON "public"."Conversation"("lastMessageId");

-- CreateIndex
CREATE INDEX "Conversation_contactId_idx" ON "public"."Conversation"("contactId");

-- CreateIndex
CREATE INDEX "Conversation_channelId_idx" ON "public"."Conversation"("channelId");

-- CreateIndex
CREATE INDEX "Conversation_status_idx" ON "public"."Conversation"("status");

-- CreateIndex
CREATE INDEX "Message_channelMsgId_idx" ON "public"."Message"("channelMsgId");

-- CreateIndex
CREATE INDEX "Message_status_idx" ON "public"."Message"("status");

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_idx" ON "public"."MessageAttachment"("messageId");

-- CreateIndex
CREATE INDEX "MessageAttachment_externalMediaId_idx" ON "public"."MessageAttachment"("externalMediaId");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_idx" ON "public"."Notification"("userId", "isRead");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "public"."TeamMember"("teamId", "userId");

-- CreateIndex
CREATE INDEX "WhatsAppTemplate_workspaceId_channelId_idx" ON "public"."WhatsAppTemplate"("workspaceId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_workspaceId_channelId_name_language_key" ON "public"."WhatsAppTemplate"("workspaceId", "channelId", "name", "language");

-- AddForeignKey
ALTER TABLE "public"."MediaAsset" ADD CONSTRAINT "MediaAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OutboundQueue" ADD CONSTRAINT "OutboundQueue_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OutboundQueue" ADD CONSTRAINT "OutboundQueue_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "public"."Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OutboundQueue" ADD CONSTRAINT "OutboundQueue_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageTemplate" ADD CONSTRAINT "MessageTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageAttachment" ADD CONSTRAINT "MessageAttachment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "public"."MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
