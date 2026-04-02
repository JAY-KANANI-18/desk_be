-- AlterTable
ALTER TABLE "public"."Payment" ADD COLUMN     "description" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'subscription';

-- AlterTable
ALTER TABLE "public"."Subscription" ADD COLUMN     "lastRefundAmount" INTEGER,
ADD COLUMN     "lastRefundAt" TIMESTAMP(3),
ADD COLUMN     "lastRefundStatus" TEXT,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;
