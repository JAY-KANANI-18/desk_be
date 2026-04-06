/*
  Warnings:

  - You are about to drop the column `logoUrl` on the `Organization` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Organization" DROP COLUMN "logoUrl",
ADD COLUMN     "website" TEXT;
