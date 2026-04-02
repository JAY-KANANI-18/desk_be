/*
  Warnings:

  - You are about to drop the column `channelId` on the `Conversation` table. All the data in the column will be lost.
  - You are about to drop the column `channelType` on the `Conversation` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."Conversation" DROP CONSTRAINT "Conversation_channelId_fkey";

-- DropIndex
DROP INDEX "public"."Conversation_channelId_idx";

-- AlterTable
ALTER TABLE "public"."Conversation" DROP COLUMN "channelId",
DROP COLUMN "channelType";
