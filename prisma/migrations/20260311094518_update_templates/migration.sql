/*
  Warnings:

  - You are about to drop the column `category` on the `MetaPageTemplate` table. All the data in the column will be lost.
  - You are about to drop the column `components` on the `MetaPageTemplate` table. All the data in the column will be lost.
  - You are about to drop the column `language` on the `MetaPageTemplate` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."MetaPageTemplate" DROP COLUMN "category",
DROP COLUMN "components",
DROP COLUMN "language",
ALTER COLUMN "metaId" DROP NOT NULL;
