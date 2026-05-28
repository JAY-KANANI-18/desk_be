DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "subscription_operations"
        WHERE "oldProviderSubId" IS NOT NULL
          AND "newProviderSubId" IS NOT NULL
        GROUP BY "provider", "type", "workspaceId", "oldProviderSubId", "newProviderSubId"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate subscription_operations replacement rows exist. Deduplicate before applying billing state machine repair migration.';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Payment"
        WHERE "providerPaymentId" IS NOT NULL
        GROUP BY "provider", "providerPaymentId"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate provider payment rows exist. Deduplicate before applying billing state machine repair migration.';
    END IF;
END $$;

ALTER TABLE "subscription_operations" ADD COLUMN "operationKey" TEXT;
ALTER TABLE "subscription_operations" ADD COLUMN "lockedAt" TIMESTAMP(3);
ALTER TABLE "subscription_operations" ADD COLUMN "lockExpiresAt" TIMESTAMP(3);

UPDATE "subscription_operations"
SET "operationKey" = CASE
    WHEN "oldProviderSubId" IS NOT NULL AND "newProviderSubId" IS NOT NULL THEN
        CONCAT("provider", ':', "type", ':', "workspaceId", ':', "oldProviderSubId", ':', "newProviderSubId")
    ELSE
        CONCAT("provider", ':', "type", ':', "workspaceId", ':', "id")
END;

ALTER TABLE "subscription_operations" ALTER COLUMN "operationKey" SET NOT NULL;

CREATE UNIQUE INDEX "subscription_operations_operationKey_key" ON "subscription_operations"("operationKey");
CREATE INDEX "subscription_operations_provider_status_lockExpiresAt_nextRetryAt_idx" ON "subscription_operations"("provider", "status", "lockExpiresAt", "nextRetryAt");
CREATE UNIQUE INDEX "Payment_provider_providerPaymentId_key" ON "Payment"("provider", "providerPaymentId");
