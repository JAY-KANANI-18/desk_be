-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onboardingDismissed" BOOLEAN NOT NULL DEFAULT false;
