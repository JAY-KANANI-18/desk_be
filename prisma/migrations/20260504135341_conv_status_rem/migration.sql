-- DropIndex
DROP INDEX "Conversation_status_idx";

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "status";
