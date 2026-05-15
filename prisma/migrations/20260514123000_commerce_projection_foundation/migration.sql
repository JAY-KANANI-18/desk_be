-- Normalized commerce projection foundation.

CREATE TABLE "CommerceCustomer" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "integrationResourceId" UUID,
    "contactId" UUID,
    "contactIntegrationId" UUID,
    "provider" TEXT NOT NULL,
    "externalCustomerId" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "marketingOptIn" BOOLEAN,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalSpentAmount" INTEGER,
    "currency" TEXT,
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceCustomer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommerceProduct" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "integrationResourceId" UUID,
    "provider" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "externalVariantId" TEXT,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "handle" TEXT,
    "productType" TEXT,
    "vendor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "imageUrl" TEXT,
    "priceAmount" INTEGER,
    "currency" TEXT,
    "inventoryQuantity" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommerceOrder" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "integrationResourceId" UUID,
    "contactId" UUID,
    "commerceCustomerId" UUID,
    "provider" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "currency" TEXT,
    "subtotalAmount" INTEGER,
    "discountAmount" INTEGER,
    "taxAmount" INTEGER,
    "shippingAmount" INTEGER,
    "totalAmount" INTEGER,
    "email" TEXT,
    "phone" TEXT,
    "placedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommerceOrderLineItem" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID,
    "externalLineItemId" TEXT,
    "externalProductId" TEXT,
    "externalVariantId" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceAmount" INTEGER,
    "totalAmount" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceOrderLineItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommerceCart" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "integrationResourceId" UUID,
    "contactId" UUID,
    "commerceCustomerId" UUID,
    "provider" TEXT NOT NULL,
    "externalCartId" TEXT NOT NULL,
    "externalCheckoutId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currency" TEXT,
    "subtotalAmount" INTEGER,
    "totalAmount" INTEGER,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "checkoutUrl" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "providerCreatedAt" TIMESTAMP(3),
    "providerUpdatedAt" TIMESTAMP(3),
    "abandonedAt" TIMESTAMP(3),
    "recoveredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceCart_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommerceCartLineItem" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "cartId" UUID NOT NULL,
    "productId" UUID,
    "externalLineItemId" TEXT,
    "externalProductId" TEXT,
    "externalVariantId" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceAmount" INTEGER,
    "totalAmount" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceCartLineItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommerceCustomer_integrationId_externalCustomerId_key"
ON "CommerceCustomer"("integrationId", "externalCustomerId");

CREATE INDEX "CommerceCustomer_workspaceId_contactId_idx"
ON "CommerceCustomer"("workspaceId", "contactId");

CREATE INDEX "CommerceCustomer_workspaceId_provider_externalCustomerId_idx"
ON "CommerceCustomer"("workspaceId", "provider", "externalCustomerId");

CREATE INDEX "CommerceCustomer_workspaceId_email_idx"
ON "CommerceCustomer"("workspaceId", "email");

CREATE INDEX "CommerceCustomer_workspaceId_phone_idx"
ON "CommerceCustomer"("workspaceId", "phone");

CREATE UNIQUE INDEX "CommerceProduct_integrationId_externalKey_key"
ON "CommerceProduct"("integrationId", "externalKey");

CREATE INDEX "CommerceProduct_workspaceId_provider_externalProductId_idx"
ON "CommerceProduct"("workspaceId", "provider", "externalProductId");

CREATE INDEX "CommerceProduct_workspaceId_sku_idx"
ON "CommerceProduct"("workspaceId", "sku");

CREATE INDEX "CommerceProduct_workspaceId_status_idx"
ON "CommerceProduct"("workspaceId", "status");

CREATE UNIQUE INDEX "CommerceOrder_integrationId_externalOrderId_key"
ON "CommerceOrder"("integrationId", "externalOrderId");

CREATE INDEX "CommerceOrder_workspaceId_contactId_placedAt_idx"
ON "CommerceOrder"("workspaceId", "contactId", "placedAt");

CREATE INDEX "CommerceOrder_workspaceId_status_placedAt_idx"
ON "CommerceOrder"("workspaceId", "status", "placedAt");

CREATE INDEX "CommerceOrder_workspaceId_provider_externalOrderId_idx"
ON "CommerceOrder"("workspaceId", "provider", "externalOrderId");

CREATE INDEX "CommerceOrderLineItem_workspaceId_orderId_idx"
ON "CommerceOrderLineItem"("workspaceId", "orderId");

CREATE INDEX "CommerceOrderLineItem_workspaceId_productId_idx"
ON "CommerceOrderLineItem"("workspaceId", "productId");

CREATE INDEX "CommerceOrderLineItem_workspaceId_sku_idx"
ON "CommerceOrderLineItem"("workspaceId", "sku");

CREATE UNIQUE INDEX "CommerceCart_integrationId_externalCartId_key"
ON "CommerceCart"("integrationId", "externalCartId");

CREATE INDEX "CommerceCart_workspaceId_contactId_updatedAt_idx"
ON "CommerceCart"("workspaceId", "contactId", "updatedAt");

CREATE INDEX "CommerceCart_workspaceId_status_abandonedAt_idx"
ON "CommerceCart"("workspaceId", "status", "abandonedAt");

CREATE INDEX "CommerceCart_workspaceId_provider_externalCartId_idx"
ON "CommerceCart"("workspaceId", "provider", "externalCartId");

CREATE INDEX "CommerceCartLineItem_workspaceId_cartId_idx"
ON "CommerceCartLineItem"("workspaceId", "cartId");

CREATE INDEX "CommerceCartLineItem_workspaceId_productId_idx"
ON "CommerceCartLineItem"("workspaceId", "productId");

CREATE INDEX "CommerceCartLineItem_workspaceId_sku_idx"
ON "CommerceCartLineItem"("workspaceId", "sku");

ALTER TABLE "CommerceCustomer"
ADD CONSTRAINT "CommerceCustomer_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceCustomer"
ADD CONSTRAINT "CommerceCustomer_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceCustomer"
ADD CONSTRAINT "CommerceCustomer_integrationResourceId_fkey"
FOREIGN KEY ("integrationResourceId") REFERENCES "IntegrationResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceCustomer"
ADD CONSTRAINT "CommerceCustomer_contactId_fkey"
FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceCustomer"
ADD CONSTRAINT "CommerceCustomer_contactIntegrationId_fkey"
FOREIGN KEY ("contactIntegrationId") REFERENCES "ContactIntegration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceProduct"
ADD CONSTRAINT "CommerceProduct_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceProduct"
ADD CONSTRAINT "CommerceProduct_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceProduct"
ADD CONSTRAINT "CommerceProduct_integrationResourceId_fkey"
FOREIGN KEY ("integrationResourceId") REFERENCES "IntegrationResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceOrder"
ADD CONSTRAINT "CommerceOrder_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceOrder"
ADD CONSTRAINT "CommerceOrder_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceOrder"
ADD CONSTRAINT "CommerceOrder_integrationResourceId_fkey"
FOREIGN KEY ("integrationResourceId") REFERENCES "IntegrationResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceOrder"
ADD CONSTRAINT "CommerceOrder_contactId_fkey"
FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceOrder"
ADD CONSTRAINT "CommerceOrder_commerceCustomerId_fkey"
FOREIGN KEY ("commerceCustomerId") REFERENCES "CommerceCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceOrderLineItem"
ADD CONSTRAINT "CommerceOrderLineItem_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceOrderLineItem"
ADD CONSTRAINT "CommerceOrderLineItem_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceOrderLineItem"
ADD CONSTRAINT "CommerceOrderLineItem_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceCart"
ADD CONSTRAINT "CommerceCart_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceCart"
ADD CONSTRAINT "CommerceCart_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceCart"
ADD CONSTRAINT "CommerceCart_integrationResourceId_fkey"
FOREIGN KEY ("integrationResourceId") REFERENCES "IntegrationResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceCart"
ADD CONSTRAINT "CommerceCart_contactId_fkey"
FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceCart"
ADD CONSTRAINT "CommerceCart_commerceCustomerId_fkey"
FOREIGN KEY ("commerceCustomerId") REFERENCES "CommerceCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceCartLineItem"
ADD CONSTRAINT "CommerceCartLineItem_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceCartLineItem"
ADD CONSTRAINT "CommerceCartLineItem_cartId_fkey"
FOREIGN KEY ("cartId") REFERENCES "CommerceCart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceCartLineItem"
ADD CONSTRAINT "CommerceCartLineItem_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
