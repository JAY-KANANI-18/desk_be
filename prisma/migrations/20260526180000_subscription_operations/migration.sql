CREATE TABLE "subscription_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "oldProviderSubId" TEXT,
    "newProviderSubId" TEXT,
    "plan" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_operations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subscription_operations_workspaceId_idx" ON "subscription_operations"("workspaceId");
CREATE INDEX "subscription_operations_provider_status_nextRetryAt_idx" ON "subscription_operations"("provider", "status", "nextRetryAt");
CREATE INDEX "subscription_operations_oldProviderSubId_idx" ON "subscription_operations"("oldProviderSubId");
CREATE INDEX "subscription_operations_newProviderSubId_idx" ON "subscription_operations"("newProviderSubId");
