import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MessageProcessingQueueService } from '../outbound/message-processing-queue.service';
import type { IntegrationAdapterRegistry } from './adapters/integration-adapter.registry';
import type { IntegrationJobQueue } from './integration-job.queue';
import type { IntegrationSecretService } from './integration-secret.service';

jest.mock('../outbound/message-processing-queue.service', () => ({
  MessageProcessingQueueService: class MessageProcessingQueueService {},
}));

jest.mock('./integration-job.queue', () => ({
  IntegrationJobQueue: class IntegrationJobQueue {},
}));

jest.mock('./adapters/integration-adapter.registry', () => ({
  IntegrationAdapterRegistry: class IntegrationAdapterRegistry {},
}));

import { IntegrationsService } from './integrations.service';

type PrismaMock = {
  integration: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  channel: {
    findFirst: jest.Mock;
  };
  integrationEvent: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  integrationJob: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  commerceOrder: {
    findMany: jest.Mock;
    count: jest.Mock;
  };
  commerceCart: {
    findMany: jest.Mock;
    count: jest.Mock;
  };
  commerceCustomer: {
    findMany: jest.Mock;
    count: jest.Mock;
  };
  commerceProduct: {
    findMany: jest.Mock;
    count: jest.Mock;
  };
};

type IntegrationJobQueueMock = {
  add: jest.Mock;
};

function createService() {
  const prisma: PrismaMock = {
    integration: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    channel: {
      findFirst: jest.fn(),
    },
    integrationEvent: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    integrationJob: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    commerceOrder: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    commerceCart: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    commerceCustomer: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    commerceProduct: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };
  const integrationJobQueue: IntegrationJobQueueMock = {
    add: jest.fn(async () => undefined),
  };
  const adapterRegistry = {
    get: jest.fn(),
    maybeGet: jest.fn(),
  };

  const service = new IntegrationsService(
    prisma as unknown as PrismaService,
    {} as IntegrationSecretService,
    {} as EventEmitter2,
    {} as MessageProcessingQueueService,
    integrationJobQueue as unknown as IntegrationJobQueue,
    adapterRegistry as unknown as IntegrationAdapterRegistry,
  );

  return { prisma, integrationJobQueue, adapterRegistry, service };
}

describe('IntegrationsService catalog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns all active connection rows separately from the provider catalog', async () => {
    const { prisma, adapterRegistry, service } = createService();
    const updatedAt = new Date('2026-05-19T10:00:00.000Z');
    const connectedAt = new Date('2026-05-19T09:00:00.000Z');
    prisma.integration.findMany.mockResolvedValue([
      {
        id: 'shopify-2',
        provider: 'shopify',
        status: 'connected',
        externalAccountId: 'second.myshopify.com',
        externalAccountName: 'Second Store',
        metadata: { shopDomain: 'second.myshopify.com', shopName: 'Second Store' },
        health: null,
        connectedAt,
        lastSyncedAt: updatedAt,
        lastWebhookAt: null,
      },
      {
        id: 'shopify-1',
        provider: 'shopify',
        status: 'connected',
        externalAccountId: 'first.myshopify.com',
        externalAccountName: 'First Store',
        metadata: { shopDomain: 'first.myshopify.com', shopName: 'First Store' },
        health: null,
        connectedAt,
        lastSyncedAt: null,
        lastWebhookAt: null,
      },
    ]);
    prisma.channel.findFirst.mockResolvedValue(null);
    adapterRegistry.maybeGet.mockReturnValue({
      summarize: (integration: { externalAccountId: string; externalAccountName: string }) => ({
        shopDomain: integration.externalAccountId,
        shopName: integration.externalAccountName,
      }),
      webhookPath: (integration: { id: string }) => `/api/integrations/shopify/webhook/${integration.id}`,
      buildSyncJob: jest.fn(),
    });

    const result = await service.listCatalog('workspace-1');

    const shopifyCatalog = result.integrations.find((item) => item.id === 'shopify');
    expect(shopifyCatalog?.integrationId).toBe('shopify-2');
    expect(shopifyCatalog?.summary?.shopName).toBe('Second Store');

    const shopifyConnections = result.connections.filter((item) => item.id === 'shopify');
    expect(shopifyConnections).toHaveLength(2);
    expect(shopifyConnections.map((item) => item.integrationId)).toEqual([
      'shopify-2',
      'shopify-1',
    ]);
  });

  it('disconnects one integration instance when a row id is provided', async () => {
    const { prisma, service } = createService();
    prisma.integration.findFirst.mockResolvedValue({ id: 'integration-1' });
    prisma.integration.update.mockResolvedValue({});

    await service.disconnectIntegration('workspace-1', 'integration-1');

    expect(prisma.integration.findFirst).toHaveBeenCalledWith({
      where: { id: 'integration-1', workspaceId: 'workspace-1' },
      select: { id: true },
    });
    expect(prisma.integration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'integration-1' },
        data: expect.objectContaining({
          status: 'disconnected',
          credentialsEncrypted: null,
        }),
      }),
    );
    expect(prisma.integration.updateMany).not.toHaveBeenCalled();
  });
});

describe('IntegrationsService commerce records', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists commerce customers with tenant scope and bounded offset pagination', async () => {
    const { prisma, service } = createService();
    prisma.integration.findFirst.mockResolvedValue({
      id: 'integration-1',
      status: 'connected',
    });
    prisma.commerceCustomer.findMany.mockResolvedValue([
      {
        id: 'customer-1',
        externalCustomerId: 'gid://shopify/Customer/1',
        email: 'customer@example.com',
        firstName: 'Priya',
        lastName: 'Shah',
        status: 'active',
        totalOrders: 3,
        totalSpentAmount: 125000,
        currency: 'INR',
      },
    ]);
    prisma.commerceCustomer.count.mockResolvedValue(11);

    const result = await service.listIntegrationCommerceRecords(
      'workspace-1',
      'integration-1',
      'customers',
      { page: 2, limit: 10 },
    );

    expect(prisma.integration.findFirst).toHaveBeenCalledWith({
      where: { id: 'integration-1', workspaceId: 'workspace-1' },
      select: { id: true, status: true },
    });
    expect(prisma.commerceCustomer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'workspace-1', integrationId: 'integration-1' },
        skip: 10,
        take: 10,
        select: expect.not.objectContaining({
          metadata: true,
        }),
      }),
    );
    expect(prisma.commerceCustomer.count).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-1', integrationId: 'integration-1' },
    });
    expect(result).toEqual({
      items: [
        expect.objectContaining({
          id: 'customer-1',
          email: 'customer@example.com',
        }),
      ],
      pagination: {
        total: 11,
        page: 2,
        limit: 10,
        totalPages: 2,
        hasNextPage: false,
        hasPrevPage: true,
      },
    });
  });

  it('lists checkouts from commerce carts without returning raw metadata', async () => {
    const { prisma, service } = createService();
    prisma.integration.findFirst.mockResolvedValue({
      id: 'integration-1',
      status: 'connected',
    });
    prisma.commerceCart.findMany.mockResolvedValue([
      {
        id: 'cart-1',
        externalCartId: 'cart-1',
        externalCheckoutId: 'checkout-1',
        status: 'abandoned',
        totalAmount: 249900,
        currency: 'INR',
        itemCount: 2,
      },
    ]);
    prisma.commerceCart.count.mockResolvedValue(1);

    const result = await service.listIntegrationCommerceRecords(
      'workspace-1',
      'integration-1',
      'checkouts',
    );

    expect(prisma.commerceCart.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: 'workspace-1',
          integrationId: 'integration-1',
          OR: [
            { externalCheckoutId: { not: null } },
            { checkoutUrl: { not: null } },
          ],
        },
        take: 10,
        select: expect.not.objectContaining({
          metadata: true,
        }),
      }),
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        externalCheckoutId: 'checkout-1',
        status: 'abandoned',
      }),
    ]);
    expect(result.pagination).toMatchObject({
      total: 1,
      page: 1,
      limit: 10,
    });
  });

  it('rejects unsupported commerce resource types before querying projections', async () => {
    const { prisma, service } = createService();
    prisma.integration.findFirst.mockResolvedValue({
      id: 'integration-1',
      status: 'connected',
    });

    await expect(
      service.listIntegrationCommerceRecords('workspace-1', 'integration-1', 'refunds'),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.commerceOrder.findMany).not.toHaveBeenCalled();
    expect(prisma.commerceCart.findMany).not.toHaveBeenCalled();
    expect(prisma.commerceCustomer.findMany).not.toHaveBeenCalled();
    expect(prisma.commerceProduct.findMany).not.toHaveBeenCalled();
  });

  it('does not query commerce records when the integration is outside the workspace', async () => {
    const { prisma, service } = createService();
    prisma.integration.findFirst.mockResolvedValue(null);

    await expect(
      service.listIntegrationCommerceRecords('workspace-1', 'integration-other', 'orders'),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.commerceOrder.findMany).not.toHaveBeenCalled();
  });
});

describe('IntegrationsService operation logs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists integration events with tenant scope, cursor pagination, and no raw payload select', async () => {
    const { prisma, service } = createService();
    prisma.integration.findFirst.mockResolvedValue({ id: 'integration-1' });
    prisma.integrationEvent.findMany.mockResolvedValue([
      {
        id: 'event-1',
        provider: 'shopify',
        eventType: 'commerce.order_paid',
        externalEventId: 'order-1',
        status: 'processed',
        createdAt: new Date('2026-05-14T10:00:00.000Z'),
      },
      {
        id: 'event-2',
        provider: 'shopify',
        eventType: 'commerce.cart_abandoned',
        externalEventId: 'cart-1',
        status: 'received',
        createdAt: new Date('2026-05-14T09:00:00.000Z'),
      },
      {
        id: 'event-3',
        provider: 'shopify',
        eventType: 'commerce.customer_updated',
        externalEventId: 'customer-1',
        status: 'processed',
        createdAt: new Date('2026-05-14T08:00:00.000Z'),
      },
    ]);
    prisma.commerceOrder.findMany.mockResolvedValue([
      {
        externalOrderId: 'order-1',
        orderNumber: '#1001',
        status: 'paid',
        financialStatus: 'paid',
        fulfillmentStatus: null,
        currency: 'INR',
        totalAmount: 129900,
        email: 'customer@example.com',
        phone: null,
        commerceCustomer: null,
        lineItems: [{ title: 'Kurta', quantity: 1 }],
      },
    ]);
    prisma.commerceCart.findMany.mockResolvedValue([
      {
        externalCartId: 'cart-1',
        externalCheckoutId: 'checkout-1',
        status: 'abandoned',
        currency: 'INR',
        totalAmount: 249900,
        itemCount: 2,
        email: 'cart@example.com',
        phone: null,
        commerceCustomer: null,
        lineItems: [{ title: 'Sneakers', quantity: 2 }],
      },
    ]);
    prisma.commerceCustomer.findMany.mockResolvedValue([]);

    const result = await service.listIntegrationEvents('workspace-1', 'integration-1', {
      limit: 2,
      cursor: 'event-0',
    });

    expect(prisma.integration.findFirst).toHaveBeenCalledWith({
      where: { id: 'integration-1', workspaceId: 'workspace-1' },
      select: { id: true },
    });
    expect(prisma.integrationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'workspace-1', integrationId: 'integration-1' },
        take: 3,
        skip: 1,
        cursor: { id: 'event-0' },
        select: expect.not.objectContaining({
          payload: true,
        }),
      }),
    );
    expect(result.items.map((item) => item.id)).toEqual(['event-1', 'event-2']);
    expect(result.items[0]).toMatchObject({
      summary: {
        resourceType: 'order',
        identifier: '#1001',
        customerLabel: 'customer@example.com',
        totalAmount: 129900,
        currency: 'INR',
        itemPreview: 'Kurta',
      },
    });
    expect(result.items[1]).toMatchObject({
      summary: {
        resourceType: 'cart',
        identifier: 'checkout-1',
        customerLabel: 'cart@example.com',
        itemCount: 2,
        itemPreview: 'Sneakers x2',
      },
    });
    expect(result.nextCursor).toBe('event-2');
  });

  it('does not query events when the integration is outside the workspace', async () => {
    const { prisma, service } = createService();
    prisma.integration.findFirst.mockResolvedValue(null);

    await expect(
      service.listIntegrationEvents('workspace-1', 'integration-other'),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.integrationEvent.findMany).not.toHaveBeenCalled();
  });

  it('lists integration jobs without selecting raw input or output payloads', async () => {
    const { prisma, service } = createService();
    prisma.integration.findFirst.mockResolvedValue({ id: 'integration-1' });
    prisma.integrationJob.findMany.mockResolvedValue([
      {
        id: 'job-1',
        type: 'shopify.initial_sync',
        status: 'failed',
        attempts: 3,
        maxRetries: 3,
        scheduledAt: new Date('2026-05-14T10:00:00.000Z'),
        createdAt: new Date('2026-05-14T10:00:00.000Z'),
      },
    ]);

    const result = await service.listIntegrationJobs('workspace-1', 'integration-1');

    expect(prisma.integrationJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'workspace-1', integrationId: 'integration-1' },
        select: expect.not.objectContaining({
          input: true,
          output: true,
        }),
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('retries a failed job by creating a new queued job in the same workspace and integration', async () => {
    const { prisma, integrationJobQueue, service } = createService();
    prisma.integrationJob.findFirst.mockResolvedValue({
      id: 'job-failed',
      workspaceId: 'workspace-1',
      integrationId: 'integration-1',
      resourceId: 'resource-1',
      type: 'shopify.initial_sync',
      status: 'failed',
      attempts: 3,
      maxRetries: 5,
      input: { sync: 'orders' },
      integration: {
        id: 'integration-1',
        status: 'connected',
      },
    });
    prisma.integrationJob.create.mockResolvedValue({
      id: 'job-retry',
      resourceId: 'resource-1',
      type: 'shopify.initial_sync',
      status: 'pending',
      attempts: 0,
      maxRetries: 5,
      scheduledAt: new Date('2026-05-14T10:00:00.000Z'),
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdAt: new Date('2026-05-14T10:00:00.000Z'),
      updatedAt: new Date('2026-05-14T10:00:00.000Z'),
    });

    const result = await service.retryIntegrationJob('workspace-1', 'integration-1', 'job-failed');

    expect(prisma.integrationJob.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'job-failed',
        workspaceId: 'workspace-1',
        integrationId: 'integration-1',
      },
      include: {
        integration: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });
    expect(prisma.integrationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'workspace-1',
          integrationId: 'integration-1',
          resourceId: 'resource-1',
          type: 'shopify.initial_sync',
          status: 'pending',
          maxRetries: 5,
          input: { sync: 'orders' },
          output: { retriedFromJobId: 'job-failed' },
        }),
      }),
    );
    expect(integrationJobQueue.add).toHaveBeenCalledWith('job-retry', {
      attempts: 5,
    });
    expect(result).toEqual({
      retriedFromJobId: 'job-failed',
      job: expect.objectContaining({ id: 'job-retry' }),
    });
  });

  it('rejects retry for active jobs', async () => {
    const { prisma, integrationJobQueue, service } = createService();
    prisma.integrationJob.findFirst.mockResolvedValue({
      id: 'job-running',
      workspaceId: 'workspace-1',
      integrationId: 'integration-1',
      resourceId: null,
      type: 'shopify.initial_sync',
      status: 'processing',
      attempts: 1,
      maxRetries: 3,
      input: {},
      integration: {
        id: 'integration-1',
        status: 'connected',
      },
    });

    await expect(
      service.retryIntegrationJob('workspace-1', 'integration-1', 'job-running'),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.integrationJob.create).not.toHaveBeenCalled();
    expect(integrationJobQueue.add).not.toHaveBeenCalled();
  });

  it('queues an event replay job in the same workspace and integration', async () => {
    const { prisma, integrationJobQueue, service } = createService();
    prisma.integrationEvent.findFirst.mockResolvedValue({
      id: 'event-failed',
      workspaceId: 'workspace-1',
      integrationId: 'integration-1',
      resourceId: 'resource-1',
      eventType: 'commerce.order_paid',
      status: 'failed',
      integration: {
        id: 'integration-1',
        status: 'connected',
      },
    });
    prisma.integrationJob.create.mockResolvedValue({
      id: 'job-replay',
      resourceId: 'resource-1',
      type: 'integration.event_replay',
      status: 'pending',
      attempts: 0,
      maxRetries: 3,
      scheduledAt: new Date('2026-05-14T10:00:00.000Z'),
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdAt: new Date('2026-05-14T10:00:00.000Z'),
      updatedAt: new Date('2026-05-14T10:00:00.000Z'),
    });

    const result = await service.replayIntegrationEvent('workspace-1', 'integration-1', 'event-failed');

    expect(prisma.integrationEvent.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'event-failed',
        workspaceId: 'workspace-1',
        integrationId: 'integration-1',
      },
      select: expect.objectContaining({
        id: true,
        integration: {
          select: {
            id: true,
            status: true,
          },
        },
      }),
    });
    expect(prisma.integrationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'workspace-1',
          integrationId: 'integration-1',
          resourceId: 'resource-1',
          type: 'integration.event_replay',
          status: 'pending',
          input: expect.objectContaining({
            integrationEventId: 'event-failed',
            eventType: 'commerce.order_paid',
          }),
        }),
      }),
    );
    expect(integrationJobQueue.add).toHaveBeenCalledWith('job-replay', {
      attempts: 3,
    });
    expect(result).toEqual({
      replayedEventId: 'event-failed',
      job: expect.objectContaining({ id: 'job-replay' }),
    });
  });

  it('processes event replay jobs through the provider adapter and marks the event replayed', async () => {
    const { prisma, adapterRegistry, service } = createService();
    const replayEvent = jest.fn(async () => ({
      provider: 'shopify',
      mode: 'event_replay',
      eventType: 'commerce.order_paid',
    }));
    adapterRegistry.get.mockReturnValue({ replayEvent });
    prisma.integrationJob.findUnique.mockResolvedValue({
      id: 'job-replay',
      workspaceId: 'workspace-1',
      integrationId: 'integration-1',
      resourceId: null,
      type: 'integration.event_replay',
      status: 'pending',
      attempts: 0,
      maxRetries: 3,
      input: { integrationEventId: 'event-1' },
      scheduledAt: new Date('2026-05-14T10:00:00.000Z'),
      integration: {
        id: 'integration-1',
        workspaceId: 'workspace-1',
        provider: 'shopify',
        status: 'connected',
        externalAccountId: 'demo.myshopify.com',
        externalAccountName: 'Demo',
        metadata: {},
        health: {},
        settings: {},
        lastSyncedAt: null,
        lastWebhookAt: null,
        credentialsEncrypted: null,
      },
    });
    prisma.integrationEvent.findFirst.mockResolvedValue({
      id: 'event-1',
      workspaceId: 'workspace-1',
      integrationId: 'integration-1',
      resourceId: null,
      provider: 'shopify',
      eventType: 'commerce.order_paid',
      externalEventId: 'order-1',
      idempotencyKey: 'shopify-event-1',
      occurredAt: new Date('2026-05-14T09:00:00.000Z'),
      payload: { topic: 'orders/paid', payload: { id: 'order-1' } },
    });
    prisma.integrationJob.update.mockResolvedValue({});
    prisma.integrationEvent.update.mockResolvedValue({});

    const result = await service.processIntegrationJob('job-replay');

    expect(adapterRegistry.get).toHaveBeenCalledWith('shopify');
    expect(replayEvent).toHaveBeenCalledWith({
      integration: expect.objectContaining({ id: 'integration-1', provider: 'shopify' }),
      event: expect.objectContaining({ id: 'event-1', idempotencyKey: 'shopify-event-1' }),
    });
    expect(prisma.integrationEvent.update).toHaveBeenCalledWith({
      where: { id: 'event-1' },
      data: {
        status: 'replayed',
        processedAt: expect.any(Date),
        error: null,
      },
    });
    expect(prisma.integrationJob.update).toHaveBeenLastCalledWith({
      where: { id: 'job-replay' },
      data: expect.objectContaining({
        status: 'completed',
        lastError: null,
        output: expect.objectContaining({
          replayedEventId: 'event-1',
          mode: 'event_replay',
        }),
      }),
    });
    expect(result).toEqual({
      status: 'completed',
      output: expect.objectContaining({
        replayedEventId: 'event-1',
        mode: 'event_replay',
      }),
    });
  });

  it('queues a manual provider sync job through the adapter contract', async () => {
    const { prisma, adapterRegistry, integrationJobQueue, service } = createService();
    const buildSyncJob = jest.fn(() => ({
      type: 'shopify.initial_sync',
      resourceId: 'resource-1',
      input: { mode: 'manual_sync', shop: 'demo.myshopify.com' },
      maxRetries: 4,
    }));
    prisma.integration.findFirst.mockResolvedValue({
      id: 'integration-1',
      workspaceId: 'workspace-1',
      provider: 'shopify',
      status: 'connected',
      externalAccountId: 'demo.myshopify.com',
      externalAccountName: 'Demo',
      metadata: {},
      health: {},
      settings: { primaryResourceId: 'resource-1' },
      lastSyncedAt: null,
      lastWebhookAt: null,
      credentialsEncrypted: 'secret',
    });
    adapterRegistry.get.mockReturnValue({ buildSyncJob });
    prisma.integrationJob.findFirst.mockResolvedValue(null);
    prisma.integrationJob.create.mockResolvedValue({
      id: 'job-sync',
      resourceId: 'resource-1',
      type: 'shopify.initial_sync',
      status: 'pending',
      attempts: 0,
      maxRetries: 4,
      scheduledAt: new Date('2026-05-14T10:00:00.000Z'),
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdAt: new Date('2026-05-14T10:00:00.000Z'),
      updatedAt: new Date('2026-05-14T10:00:00.000Z'),
    });

    const result = await service.syncIntegration('workspace-1', 'integration-1');

    expect(prisma.integration.findFirst).toHaveBeenCalledWith({
      where: { id: 'integration-1', workspaceId: 'workspace-1' },
      select: expect.objectContaining({
        id: true,
        credentialsEncrypted: true,
      }),
    });
    expect(adapterRegistry.get).toHaveBeenCalledWith('shopify');
    expect(buildSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'integration-1', provider: 'shopify' }),
      { mode: 'manual_sync' },
    );
    expect(prisma.integrationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'workspace-1',
          integrationId: 'integration-1',
          resourceId: 'resource-1',
          type: 'shopify.initial_sync',
          status: 'pending',
          maxRetries: 4,
          input: expect.objectContaining({
            mode: 'manual_sync',
            shop: 'demo.myshopify.com',
            source: 'manual_sync',
            requestedAt: expect.any(String),
          }),
        }),
      }),
    );
    expect(integrationJobQueue.add).toHaveBeenCalledWith('job-sync', {
      attempts: 4,
      delay: expect.any(Number),
    });
    expect(result).toEqual({
      alreadyQueued: false,
      job: expect.objectContaining({ id: 'job-sync' }),
    });
  });

  it('returns the active sync job instead of queueing duplicates', async () => {
    const { prisma, adapterRegistry, integrationJobQueue, service } = createService();
    prisma.integration.findFirst.mockResolvedValue({
      id: 'integration-1',
      workspaceId: 'workspace-1',
      provider: 'shopify',
      status: 'connected',
      externalAccountId: 'demo.myshopify.com',
      externalAccountName: 'Demo',
      metadata: {},
      health: {},
      settings: {},
      lastSyncedAt: null,
      lastWebhookAt: null,
      credentialsEncrypted: 'secret',
    });
    adapterRegistry.get.mockReturnValue({
      buildSyncJob: jest.fn(() => ({
        type: 'shopify.initial_sync',
        input: { mode: 'manual_sync' },
      })),
    });
    prisma.integrationJob.findFirst.mockResolvedValue({
      id: 'job-existing',
      resourceId: null,
      type: 'shopify.initial_sync',
      status: 'processing',
      attempts: 1,
      maxRetries: 3,
      scheduledAt: new Date('2026-05-14T10:00:00.000Z'),
      startedAt: new Date('2026-05-14T10:00:00.000Z'),
      completedAt: null,
      lastError: null,
      createdAt: new Date('2026-05-14T10:00:00.000Z'),
      updatedAt: new Date('2026-05-14T10:00:00.000Z'),
    });

    const result = await service.syncIntegration('workspace-1', 'integration-1');

    expect(prisma.integrationJob.create).not.toHaveBeenCalled();
    expect(integrationJobQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({
      alreadyQueued: true,
      job: expect.objectContaining({ id: 'job-existing' }),
    });
  });

  it('passes bounded backfill options into manual sync jobs', async () => {
    const { prisma, adapterRegistry, integrationJobQueue, service } = createService();
    const buildSyncJob = jest.fn((_integration, options) => ({
      type: 'shopify.initial_sync',
      input: {
        mode: options.mode,
        resources: options.resources,
        since: options.since,
        until: options.until,
      },
      maxRetries: 3,
    }));
    prisma.integration.findFirst.mockResolvedValue({
      id: 'integration-1',
      workspaceId: 'workspace-1',
      provider: 'shopify',
      status: 'connected',
      externalAccountId: 'demo.myshopify.com',
      externalAccountName: 'Demo',
      metadata: {},
      health: {},
      settings: {},
      lastSyncedAt: null,
      lastWebhookAt: null,
      credentialsEncrypted: 'secret',
    });
    adapterRegistry.get.mockReturnValue({ buildSyncJob });
    prisma.integrationJob.findFirst.mockResolvedValue(null);
    prisma.integrationJob.create.mockResolvedValue({
      id: 'job-backfill',
      resourceId: null,
      type: 'shopify.initial_sync',
      status: 'pending',
      attempts: 0,
      maxRetries: 3,
      scheduledAt: new Date('2026-05-14T10:00:00.000Z'),
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdAt: new Date('2026-05-14T10:00:00.000Z'),
      updatedAt: new Date('2026-05-14T10:00:00.000Z'),
    });

    await service.syncIntegration('workspace-1', 'integration-1', {
      mode: 'backfill',
      resources: ['orders', 'carts', 'orders'],
      since: '2026-05-01T00:00:00.000Z',
      until: '2026-05-14T23:59:59.999Z',
    });

    expect(buildSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'integration-1', provider: 'shopify' }),
      {
        mode: 'backfill',
        resources: ['orders', 'carts'],
        since: '2026-05-01T00:00:00.000Z',
        until: '2026-05-14T23:59:59.999Z',
      },
    );
    expect(prisma.integrationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          input: expect.objectContaining({
            source: 'manual_backfill',
            mode: 'backfill',
            resources: ['orders', 'carts'],
            since: '2026-05-01T00:00:00.000Z',
            until: '2026-05-14T23:59:59.999Z',
          }),
        }),
      }),
    );
    expect(integrationJobQueue.add).toHaveBeenCalledWith('job-backfill', {
      attempts: 3,
      delay: expect.any(Number),
    });
  });

  it('runs immediate provider actions through the adapter contract', async () => {
    const { prisma, adapterRegistry, service } = createService();
    const runAction = jest.fn(async () => ({
      status: 'ok',
      action: 'test_connection',
      message: 'Healthy',
    }));
    prisma.integration.findFirst.mockResolvedValue({
      id: 'integration-1',
      workspaceId: 'workspace-1',
      provider: 'shopify',
      status: 'connected',
      externalAccountId: 'demo.myshopify.com',
      externalAccountName: 'Demo',
      metadata: {},
      health: {},
      settings: {},
      lastSyncedAt: null,
      lastWebhookAt: null,
      credentialsEncrypted: 'secret',
    });
    adapterRegistry.get.mockReturnValue({
      providerActions: jest.fn(() => [
        { key: 'test_connection', label: 'Test connection', mode: 'immediate' },
      ]),
      runAction,
    });

    const result = await service.runIntegrationAction(
      'workspace-1',
      'integration-1',
      'test_connection',
    );

    expect(runAction).toHaveBeenCalledWith({
      integration: expect.objectContaining({ id: 'integration-1', provider: 'shopify' }),
      action: 'test_connection',
    });
    expect(result).toEqual({
      mode: 'immediate',
      action: 'test_connection',
      result: {
        status: 'ok',
        action: 'test_connection',
        message: 'Healthy',
      },
    });
  });

  it('queues non-sync provider actions as durable jobs', async () => {
    const { prisma, adapterRegistry, integrationJobQueue, service } = createService();
    prisma.integration.findFirst.mockResolvedValue({
      id: 'integration-1',
      workspaceId: 'workspace-1',
      provider: 'shopify',
      status: 'connected',
      externalAccountId: 'demo.myshopify.com',
      externalAccountName: 'Demo',
      metadata: {},
      health: {},
      settings: { primaryResourceId: 'resource-1' },
      lastSyncedAt: null,
      lastWebhookAt: null,
      credentialsEncrypted: 'secret',
    });
    adapterRegistry.get.mockReturnValue({
      providerActions: jest.fn(() => [
        { key: 'resubscribe_webhooks', label: 'Resubscribe webhooks', mode: 'job' },
      ]),
      buildActionJob: jest.fn(() => ({
        type: 'shopify.resubscribe_webhooks',
        resourceId: 'resource-1',
        input: { mode: 'resubscribe_webhooks' },
        maxRetries: 3,
      })),
    });
    prisma.integrationJob.findFirst.mockResolvedValue(null);
    prisma.integrationJob.create.mockResolvedValue({
      id: 'job-action',
      resourceId: 'resource-1',
      type: 'shopify.resubscribe_webhooks',
      status: 'pending',
      attempts: 0,
      maxRetries: 3,
      scheduledAt: new Date('2026-05-14T10:00:00.000Z'),
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdAt: new Date('2026-05-14T10:00:00.000Z'),
      updatedAt: new Date('2026-05-14T10:00:00.000Z'),
    });

    const result = await service.runIntegrationAction(
      'workspace-1',
      'integration-1',
      'resubscribe_webhooks',
    );

    expect(prisma.integrationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'workspace-1',
          integrationId: 'integration-1',
          resourceId: 'resource-1',
          type: 'shopify.resubscribe_webhooks',
          input: expect.objectContaining({
            mode: 'resubscribe_webhooks',
            source: 'provider_action',
            action: 'resubscribe_webhooks',
            requestedAt: expect.any(String),
          }),
        }),
      }),
    );
    expect(integrationJobQueue.add).toHaveBeenCalledWith('job-action', {
      attempts: 3,
      delay: expect.any(Number),
    });
    expect(result).toEqual({
      mode: 'job',
      action: 'resubscribe_webhooks',
      alreadyQueued: false,
      job: expect.objectContaining({ id: 'job-action' }),
    });
  });
});
