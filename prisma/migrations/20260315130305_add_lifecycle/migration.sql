-- CreateEnum
CREATE TYPE "public"."StageType" AS ENUM ('lifecycle', 'lost');

-- CreateTable
CREATE TABLE "public"."lifecycle_stages" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "emoji" VARCHAR(10) NOT NULL DEFAULT '⭐',
    "type" "public"."StageType" NOT NULL DEFAULT 'lifecycle',
    "order" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifecycle_stages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lifecycle_stages_workspaceId_idx" ON "public"."lifecycle_stages"("workspaceId");

-- CreateIndex
CREATE INDEX "lifecycle_stages_workspaceId_type_idx" ON "public"."lifecycle_stages"("workspaceId", "type");

-- AddForeignKey
ALTER TABLE "public"."lifecycle_stages" ADD CONSTRAINT "lifecycle_stages_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
