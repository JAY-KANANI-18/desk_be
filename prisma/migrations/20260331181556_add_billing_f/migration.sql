-- AlterTable
ALTER TABLE "public"."Subscription" ADD COLUMN     "pendingEffectiveAt" TEXT,
ADD COLUMN     "pendingPlan" TEXT,
ADD COLUMN     "pendingProviderSubId" TEXT;
