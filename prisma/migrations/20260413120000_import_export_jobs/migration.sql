-- CreateEnum
CREATE TYPE "ImportExportJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ImportExportJob" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "status" "ImportExportJobStatus" NOT NULL DEFAULT 'PENDING',
    "tenantId" UUID NOT NULL,
    "fileUrl" TEXT,
    "resultUrl" TEXT,
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "processedRecords" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "errorLog" JSONB,
    "metadata" JSONB,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportExportJob_tenantId_entity_status_createdAt_idx" ON "ImportExportJob"("tenantId", "entity", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ImportExportJob_createdBy_createdAt_idx" ON "ImportExportJob"("createdBy", "createdAt");

-- CreateIndex
CREATE INDEX "ImportExportJob_type_status_idx" ON "ImportExportJob"("type", "status");

-- AddForeignKey
ALTER TABLE "ImportExportJob" ADD CONSTRAINT "ImportExportJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportExportJob" ADD CONSTRAINT "ImportExportJob_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
