-- CreateTable
CREATE TABLE "public"."WorkflowRun" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "currentStepId" TEXT,
    "variables" JSONB DEFAULT '{}',
    "triggerData" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WorkflowRunStep" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepId" TEXT NOT NULL,
    "stepType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowId_idx" ON "public"."WorkflowRun"("workflowId");

-- CreateIndex
CREATE INDEX "WorkflowRun_contactId_idx" ON "public"."WorkflowRun"("contactId");

-- CreateIndex
CREATE INDEX "WorkflowRun_status_idx" ON "public"."WorkflowRun"("status");

-- CreateIndex
CREATE INDEX "WorkflowRun_workspaceId_status_idx" ON "public"."WorkflowRun"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "WorkflowRunStep_runId_idx" ON "public"."WorkflowRunStep"("runId");

-- CreateIndex
CREATE INDEX "WorkflowRunStep_stepId_idx" ON "public"."WorkflowRunStep"("stepId");

-- AddForeignKey
ALTER TABLE "public"."WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "public"."Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkflowRunStep" ADD CONSTRAINT "WorkflowRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
