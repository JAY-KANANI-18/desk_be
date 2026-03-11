/*
  Warnings:

  - You are about to drop the column `status` on the `Conversation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."Contact" ADD COLUMN     "status" TEXT;

-- AlterTable
ALTER TABLE "public"."Conversation" DROP COLUMN "status";
