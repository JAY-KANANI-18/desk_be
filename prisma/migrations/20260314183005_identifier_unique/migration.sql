/*
  Warnings:

  - A unique constraint covering the columns `[identifier]` on the table `Channel` will be added. If there are existing duplicate values, this will fail.
  - Made the column `identifier` on table `Channel` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "public"."Channel" ALTER COLUMN "identifier" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Channel_identifier_key" ON "public"."Channel"("identifier");
