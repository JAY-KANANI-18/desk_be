-- AlterTable
ALTER TABLE "Organization"
ADD COLUMN     "onboardingData" JSONB,
ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3);
