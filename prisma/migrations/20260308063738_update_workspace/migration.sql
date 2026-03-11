-- AlterTable
ALTER TABLE "public"."Workspace" ADD COLUMN     "dateFormat" TEXT NOT NULL DEFAULT 'MM/DD/YYYY',
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "timeFormat" TEXT NOT NULL DEFAULT 'hh:mm A',
ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'UTC';
