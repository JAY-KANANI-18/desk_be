/*
  Warnings:

  - You are about to drop the column `isActive` on the `Workflow` table. All the data in the column will be lost.
  - You are about to drop the column `trigger` on the `Workflow` table. All the data in the column will be lost.
  - Added the required column `createBy` to the `Workflow` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."Workflow" DROP COLUMN "isActive",
DROP COLUMN "trigger",
ADD COLUMN     "createBy" UUID NOT NULL,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "publishedBy" UUID,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'draft';
