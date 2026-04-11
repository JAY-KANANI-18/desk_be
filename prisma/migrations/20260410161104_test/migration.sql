-- AlterTable
ALTER TABLE "NotificationDelivery" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NotificationDevice" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NotificationPreference" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Tag" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "UserActivity" ALTER COLUMN "inactivitySessionId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceAiPrompt" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceAiSettings" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "NotificationEmailHistory_contactId_userId_inactivitySessionId_i" RENAME TO "NotificationEmailHistory_contactId_userId_inactivitySession_idx";

-- RenameIndex
ALTER INDEX "NotificationEmailHistory_userId_contactId_type_inactivitySessio" RENAME TO "NotificationEmailHistory_userId_contactId_type_inactivitySe_key";
