import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { IntegrationSecretService } from '../integration-secret.service';
import {
  ConnectedIntegrationSnapshot,
  IntegrationActionJobDefinition,
  IntegrationEventReplayParams,
  IntegrationJobProcessParams,
  IntegrationJsonRecord,
  IntegrationOAuthUrlParams,
  IntegrationProviderAdapter,
  IntegrationProviderActionDescriptor,
  IntegrationProviderActionParams,
  IntegrationProviderActionResult,
  IntegrationSummary,
  IntegrationSyncOptions,
  IntegrationSyncJobDefinition,
  IntegrationWebhookParams,
} from '../adapters/integration-adapter.interface';
import {
  CommerceCartInput,
  CommerceCustomerInput,
  CommerceEventType,
  CommerceLineItemInput,
  CommerceOrderInput,
  CommerceProductInput,
  CommerceService,
} from '../../commerce/commerce.service';
import { IntegrationJobQueue } from '../integration-job.queue';

class ShopifyApiRequestException extends BadRequestException {
  constructor(
    readonly providerStatusCode: number,
    message: string,
  ) {
    super(message);
  }
}

class ShopifyGraphqlRequestException extends ShopifyApiRequestException {}

type ShopifyInitialSyncTotals = {
  products: number;
  customers: number;
  orders: number;
  carts: number;
  skipped: string[];
};

type ShopifySyncResource = 'products' | 'customers' | 'orders' | 'carts';

type ShopifyInitialSyncContext = {
  workspaceId: string;
  integrationId: string;
  integrationResourceId?: string;
  shop: string;
  accessToken: string;
  currency?: string;
  resources?: ShopifySyncResource[];
  since?: string;
  until?: string;
  mode?: 'manual_sync' | 'backfill';
};

@Injectable()
export class ShopifyIntegrationAdapter implements IntegrationProviderAdapter {
  readonly provider = 'shopify' as const;
  private readonly logger = new Logger(ShopifyIntegrationAdapter.name);
  private readonly initialSyncJobType = 'shopify.initial_sync';
  private readonly resubscribeWebhooksJobType = 'shopify.resubscribe_webhooks';

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: IntegrationSecretService,
    private readonly commerce: CommerceService,
    private readonly integrationJobQueue: IntegrationJobQueue,
  ) {}

  buildOAuthUrl(params: IntegrationOAuthUrlParams) {
    const shop = this.normalizeShopDomain(params.query?.shop);
    if (!shop) {
      throw new BadRequestException('shop query parameter is required');
    }

    const clientId = process.env.SHOPIFY_API_KEY || '';
    const redirectUri =
      process.env.SHOPIFY_REDIRECT_URI ||
      `${this.publicApiRoot()}/api/integrations/shopify/oauth/callback`;
    if (!clientId || !redirectUri) {
      throw new BadRequestException('SHOPIFY_API_KEY and SHOPIFY_REDIRECT_URI must be configured');
    }

    const scopes =
      process.env.SHOPIFY_SCOPES ||
      'read_customers,read_products,read_orders,read_checkouts';
    const state = encodeURIComponent(JSON.stringify({ workspaceId: params.workspaceId, provider: this.provider, shop }));
    const url =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    return { url, redirectUri, shop };
  }

  async connectOAuth(params: {
    workspaceId: string;
    code: string;
    createdById?: string;
    query?: Record<string, string | undefined>;
  }) {
    const shop = this.normalizeShopDomain(params.query?.shop);
    if (!shop) {
      throw new BadRequestException('shop is required');
    }

    const attemptIntegration = await this.upsertConnectionAttempt({
      workspaceId: params.workspaceId,
      shop,
      createdById: params.createdById,
    });

    await this.recordConnectionEvent({
      workspaceId: params.workspaceId,
      integrationId: attemptIntegration.id,
      shop,
      eventType: 'integration.oauth_started',
      status: 'received',
      payload: { stage: 'oauth_exchange_started', shop },
    });

    try {
      this.assertOAuthHmac(params.query ?? {});

      const tokenData = await this.exchangeCodeForToken(shop, params.code);
      const accessToken = this.readString(tokenData, 'access_token');
      if (!accessToken) {
        throw new BadRequestException('Shopify OAuth did not return an access token');
      }

      const grantedScope = this.readString(tokenData, 'scope');
      const shopInfo = await this.fetchShopInfo(shop, accessToken);
      const shopName = this.readString(shopInfo, 'name') ?? shop;
      const currency = this.readString(shopInfo, 'currency');
      const email = this.readString(shopInfo, 'email');
      const planName = this.readString(shopInfo, 'plan_name');
      const apiVersion = this.shopifyApiVersion();
      const credentialsEncrypted = this.secrets.encryptJson({
        provider: this.provider,
        shop,
        accessToken,
        scope: grantedScope,
      });
      const metadata = {
        shopDomain: shop,
        shopName,
        currency,
        email,
        planName,
        provider: this.provider,
      };

      const { integration, resource } = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.integration.findFirst({
          where: {
            workspaceId: params.workspaceId,
            provider: this.provider,
            externalAccountId: shop,
          },
        });

        const integrationRow = existing
          ? await tx.integration.update({
              where: { id: existing.id },
              data: {
                name: `Shopify - ${shopName}`,
                category: 'commerce',
                status: 'connected',
                externalAccountName: shopName,
                authType: 'oauth',
                scopes: grantedScope ? grantedScope.split(',').map((scope) => scope.trim()) : [],
                credentialsEncrypted,
                settings: {
                  apiVersion,
                  defaultWebhookTopics: this.defaultWebhookTopics(),
                },
                metadata,
                health: { state: 'ok', checkedAt: new Date().toISOString() },
                connectedAt: existing.connectedAt ?? new Date(),
                disconnectedAt: null,
                createdById: params.createdById ?? existing.createdById,
              },
            })
          : await tx.integration.create({
              data: {
                workspaceId: params.workspaceId,
                provider: this.provider,
                category: 'commerce',
                name: `Shopify - ${shopName}`,
                status: 'connected',
                externalAccountId: shop,
                externalAccountName: shopName,
                authType: 'oauth',
                scopes: grantedScope ? grantedScope.split(',').map((scope) => scope.trim()) : [],
                credentialsEncrypted,
                settings: {
                  apiVersion,
                  defaultWebhookTopics: this.defaultWebhookTopics(),
                },
                metadata,
                health: { state: 'ok', checkedAt: new Date().toISOString() },
                connectedAt: new Date(),
                createdById: params.createdById,
              },
            });

        const resourceRow = await tx.integrationResource.upsert({
          where: {
            integrationId_type_externalId: {
              integrationId: integrationRow.id,
              type: 'shop',
              externalId: shop,
            },
          },
          update: {
            name: shopName,
            status: 'active',
            metadata,
          },
          create: {
            workspaceId: params.workspaceId,
            integrationId: integrationRow.id,
            type: 'shop',
            externalId: shop,
            name: shopName,
            status: 'active',
            metadata,
          },
        });

        await tx.integration.update({
          where: { id: integrationRow.id },
          data: {
            settings: {
              apiVersion,
              primaryResourceId: resourceRow.id,
              shopDomain: shop,
              defaultWebhookTopics: this.defaultWebhookTopics(),
            },
          },
        });

        return { integration: integrationRow, resource: resourceRow };
      });

      const webhookRegistration = await this.registerDefaultWebhooks({
        integrationId: integration.id,
        shop,
        accessToken,
      });

      await this.prisma.integration.update({
        where: { id: integration.id },
        data: {
          health: {
            state: webhookRegistration.skipped ? 'warning' : 'ok',
            checkedAt: new Date().toISOString(),
            webhookRegistration,
          },
        },
      });

      await this.recordConnectionEvent({
        workspaceId: params.workspaceId,
        integrationId: integration.id,
        shop,
        eventType: 'integration.oauth_connected',
        status: 'processed',
        payload: {
          stage: 'oauth_connected',
          shop,
          webhookRegistration: this.summarizeWebhookRegistration(webhookRegistration),
        },
      });

      const initialSyncJob = await this.enqueueInitialSyncJob({
        workspaceId: params.workspaceId,
        integrationId: integration.id,
        resourceId: resource.id,
        shop,
      });

      return {
        integrationId: integration.id,
        resourceId: resource.id,
        provider: integration.provider,
        name: integration.name,
        summary: this.summarize(integration),
        webhookPath: this.webhookPath(integration),
        webhookRegistration,
        initialSyncJob,
      };
    } catch (error) {
      await this.markConnectionAttemptFailed({
        workspaceId: params.workspaceId,
        integrationId: attemptIntegration.id,
        shop,
        error,
      });
      throw error;
    }
  }

  async ingestWebhook(params: IntegrationWebhookParams) {
    if (!params.integrationId) {
      return { status: 'integration_id_required' };
    }

    const integration = await this.prisma.integration.findUnique({
      where: { id: params.integrationId },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        status: true,
        externalAccountId: true,
      },
    });

    if (!integration || integration.provider !== this.provider) {
      return { status: 'integration_not_found' };
    }

    if (integration.status !== 'connected') {
      return { status: 'integration_not_connected' };
    }

    this.assertWebhookSignature(params);

    const topic = this.headerValue(params.headers, 'x-shopify-topic') ?? 'unknown';
    const shopDomain =
      this.headerValue(params.headers, 'x-shopify-shop-domain') ??
      integration.externalAccountId ??
      'unknown-shop';
    const eventType = this.topicToCommerceEvent(topic);
    const root = this.asRecord(params.payload);

    if (!eventType) {
      this.logger.debug(`Ignoring unsupported Shopify topic ${topic}`);
      return { status: 'ignored', topic };
    }

    const result = await this.commerce.recordEvent({
      workspaceId: integration.workspaceId,
      integrationId: integration.id,
      provider: this.provider,
      eventType,
      externalEventId: this.readString(root, 'id') ?? this.hashFallback(topic, params.payload),
      idempotencyKey: this.headerValue(params.headers, 'x-shopify-webhook-id') ?? undefined,
      occurredAt: new Date(),
      customer: this.customerFromPayload(root),
      products: this.productsFromPayload(root),
      order: eventType.startsWith('commerce.order_') ? this.orderFromPayload(root) : null,
      cart: eventType.startsWith('commerce.cart_') ? this.cartFromPayload(root) : null,
      raw: { topic, shopDomain, payload: root },
    });

    return { status: 'ok', topic, ...result };
  }

  async replayEvent(params: IntegrationEventReplayParams) {
    const storedPayload = this.asRecord(params.event.payload);
    const root = this.asRecord(storedPayload.payload ?? storedPayload);
    const topic = this.readString(storedPayload, 'topic') ?? 'event_replay';
    const eventType =
      this.commerceEventTypeFromStoredEvent(params.event.eventType) ??
      this.topicToCommerceEvent(topic);

    if (!eventType) {
      throw new BadRequestException(`Shopify event replay does not support ${params.event.eventType}`);
    }

    const result = await this.commerce.recordEvent({
      workspaceId: params.integration.workspaceId ?? params.event.workspaceId,
      integrationId: params.integration.id,
      integrationResourceId: params.event.resourceId,
      provider: this.provider,
      eventType,
      externalEventId:
        params.event.externalEventId ??
        this.readString(root, 'id') ??
        this.hashFallback(params.event.eventType, root),
      idempotencyKey: params.event.idempotencyKey,
      occurredAt: params.event.occurredAt ?? new Date(),
      customer: this.customerFromPayload(root),
      products: this.productsFromPayload(root),
      order: eventType.startsWith('commerce.order_') ? this.orderFromPayload(root) : null,
      cart: eventType.startsWith('commerce.cart_') ? this.cartFromPayload(root) : null,
      raw: {
        ...storedPayload,
        topic,
        payload: root,
        replayedAt: new Date().toISOString(),
        replayedFromEventId: params.event.id,
      },
    });

    return {
      provider: this.provider,
      mode: 'event_replay',
      eventType,
      ...result,
    };
  }

  async processJob(params: IntegrationJobProcessParams): Promise<Record<string, unknown>> {
    if (
      params.job.type !== this.initialSyncJobType &&
      params.job.type !== this.resubscribeWebhooksJobType
    ) {
      throw new BadRequestException(`Unsupported Shopify job type: ${params.job.type}`);
    }

    const credentials = params.integration.credentialsEncrypted
      ? this.secrets.decryptJson(params.integration.credentialsEncrypted)
      : {};
    const accessToken = this.readString(credentials, 'accessToken');
    const shop = this.normalizeShopDomain(
      this.readString(credentials, 'shop') ?? params.integration.externalAccountId,
    );

    if (!accessToken || !shop) {
      throw new BadRequestException('Shopify credentials are incomplete');
    }

    if (params.job.type === this.resubscribeWebhooksJobType) {
      const webhookRegistration = await this.registerDefaultWebhooks({
        integrationId: params.integration.id,
        shop,
        accessToken,
      });
      const healthState = this.webhookRegistrationHealthState(webhookRegistration);

      await this.prisma.integration.update({
        where: { id: params.integration.id },
        data: {
          health: {
            state: healthState,
            checkedAt: new Date().toISOString(),
            webhookRegistration,
          },
        },
      });

      return {
        status: healthState === 'warning' ? 'warning' : 'ok',
        provider: this.provider,
        mode: 'resubscribe_webhooks',
        webhookRegistration: this.summarizeWebhookRegistration(webhookRegistration),
      };
    }

    const settings = this.asRecord(params.integration.settings);
    const metadata = this.asRecord(params.integration.metadata);
    const input = this.asRecord(params.job.input);
    const resourceId =
      params.job.resourceId ??
      this.readString(settings, 'primaryResourceId') ??
      undefined;
    const currency = this.readString(metadata, 'currency') ?? undefined;
    const syncMode = this.readString(input, 'mode') === 'backfill' ? 'backfill' : 'manual_sync';
    const resources = this.shopifySyncResourcesFromInput(input);
    const since = this.readString(input, 'since') ?? undefined;
    const until = this.readString(input, 'until') ?? undefined;

    const totals = await this.runInitialSync({
      workspaceId: params.job.workspaceId,
      integrationId: params.job.integrationId,
      integrationResourceId: resourceId,
      shop,
      accessToken,
      currency,
      resources,
      since,
      until,
      mode: syncMode,
    });
    const syncHealthKey = syncMode === 'backfill' ? 'backfill' : 'initialSync';

    await this.prisma.integration.update({
      where: { id: params.job.integrationId },
      data: {
        lastSyncedAt: new Date(),
        health: this.toInputJson({
          ...this.asRecord(params.integration.health),
          state: 'ok',
          checkedAt: new Date().toISOString(),
          [syncHealthKey]: {
            status: 'completed',
            jobId: params.job.id,
            mode: syncMode,
            resources: resources ?? ['products', 'customers', 'orders', 'carts'],
            since,
            until,
            totals,
          },
        }),
      },
    });

    return {
      status: 'ok',
      provider: this.provider,
      mode: syncMode,
      resources: resources ?? ['products', 'customers', 'orders', 'carts'],
      since,
      until,
      totals,
    };
  }

  summarize(integration: ConnectedIntegrationSnapshot): IntegrationSummary | null {
    const metadata = this.asRecord(integration.metadata);
    return {
      shopDomain: integration.externalAccountId ?? this.readString(metadata, 'shopDomain') ?? undefined,
      shopName: integration.externalAccountName ?? this.readString(metadata, 'shopName') ?? undefined,
      accountName: integration.externalAccountName ?? this.readString(metadata, 'shopName') ?? undefined,
      accountId: integration.externalAccountId ?? this.readString(metadata, 'shopDomain') ?? undefined,
    };
  }

  webhookPath(integration: ConnectedIntegrationSnapshot | null) {
    return integration ? `/api/integrations/shopify/webhook/${integration.id}` : null;
  }

  buildSyncJob(
    integration: ConnectedIntegrationSnapshot,
    options: IntegrationSyncOptions = {},
  ): IntegrationSyncJobDefinition {
    const settings = this.asRecord(integration.settings);
    const metadata = this.asRecord(integration.metadata);
    const resources = this.shopifySyncResources(options.resources);
    const mode = options.mode ?? (resources || options.since || options.until ? 'backfill' : 'manual_sync');
    return {
      type: this.initialSyncJobType,
      resourceId: this.readString(settings, 'primaryResourceId') ?? null,
      maxRetries: 3,
      input: {
        mode,
        shop:
          integration.externalAccountId ??
          this.readString(metadata, 'shopDomain') ??
          undefined,
        ...(resources ? { resources } : {}),
        ...(options.since ? { since: options.since } : {}),
        ...(options.until ? { until: options.until } : {}),
      },
    };
  }

  providerActions(): IntegrationProviderActionDescriptor[] {
    return [
      {
        key: 'test_connection',
        label: 'Test connection',
        description: 'Check the saved Shopify token and refresh connection health.',
        mode: 'immediate',
      },
      {
        key: 'resubscribe_webhooks',
        label: 'Resubscribe webhooks',
        description: 'Register missing Shopify webhook topics again.',
        mode: 'job',
      },
    ];
  }

  async runAction(params: IntegrationProviderActionParams): Promise<IntegrationProviderActionResult> {
    if (params.action !== 'test_connection') {
      throw new BadRequestException(`Unsupported Shopify action: ${params.action}`);
    }

    const { accessToken, shop } = this.readShopifyCredentials(params.integration);
    const shopInfo = await this.fetchShopInfo(shop, accessToken);
    const shopName = this.readString(shopInfo, 'name') ?? params.integration.externalAccountName ?? shop;
    const currency = this.readString(shopInfo, 'currency');
    const email = this.readString(shopInfo, 'email');
    const planName = this.readString(shopInfo, 'plan_name');

    await this.prisma.integration.update({
      where: { id: params.integration.id },
      data: {
        externalAccountName: shopName,
        metadata: {
          ...this.asRecord(params.integration.metadata),
          shopDomain: shop,
          shopName,
          currency,
          email,
          planName,
          provider: this.provider,
        },
        health: {
          ...this.asRecord(params.integration.health),
          state: 'ok',
          checkedAt: new Date().toISOString(),
          lastAction: 'test_connection',
        },
      },
    });

    return {
      status: 'ok',
      action: params.action,
      message: 'Shopify connection is healthy.',
      details: {
        shop,
        shopName,
        currency,
        planName,
      },
    };
  }

  buildActionJob(params: IntegrationProviderActionParams): IntegrationActionJobDefinition | null {
    if (params.action !== 'resubscribe_webhooks') return null;
    const settings = this.asRecord(params.integration.settings);
    return {
      type: this.resubscribeWebhooksJobType,
      resourceId: this.readString(settings, 'primaryResourceId') ?? null,
      maxRetries: 3,
      input: {
        mode: 'resubscribe_webhooks',
        requestedAction: params.action,
      },
    };
  }

  private async enqueueInitialSyncJob(params: {
    workspaceId: string;
    integrationId: string;
    resourceId: string;
    shop: string;
  }) {
    const existing = await this.prisma.integrationJob.findFirst({
      where: {
        workspaceId: params.workspaceId,
        integrationId: params.integrationId,
        type: this.initialSyncJobType,
        status: { in: ['pending', 'processing'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        maxRetries: true,
        scheduledAt: true,
      },
    });

    const job = existing ?? (await this.prisma.integrationJob.create({
      data: {
        workspaceId: params.workspaceId,
        integrationId: params.integrationId,
        resourceId: params.resourceId,
        type: this.initialSyncJobType,
        status: 'pending',
        maxRetries: 3,
        input: this.toInputJson({
          shop: params.shop,
          mode: 'initial_sync',
          requestedAt: new Date().toISOString(),
        }),
      },
      select: {
        id: true,
        status: true,
        maxRetries: true,
        scheduledAt: true,
      },
    }));

    try {
      await this.integrationJobQueue.add(job.id, {
        attempts: job.maxRetries,
        delay: Math.max(0, job.scheduledAt.getTime() - Date.now()),
      });
      return { id: job.id, status: job.status, queued: true };
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.warn(`Shopify initial sync queue enqueue failed: ${message}`);
      await this.prisma.integrationJob.update({
        where: { id: job.id },
        data: { lastError: `Queue enqueue failed: ${message}` },
      });
      return { id: job.id, status: job.status, queued: false, error: message };
    }
  }

  private async upsertConnectionAttempt(params: {
    workspaceId: string;
    shop: string;
    createdById?: string;
  }) {
    const metadata = {
      provider: this.provider,
      shopDomain: params.shop,
    };
    const existing = await this.prisma.integration.findFirst({
      where: {
        workspaceId: params.workspaceId,
        provider: this.provider,
        externalAccountId: params.shop,
      },
      select: {
        id: true,
        connectedAt: true,
        createdById: true,
      },
    });

    if (existing) {
      return this.prisma.integration.update({
        where: { id: existing.id },
        data: {
          name: `Shopify - ${params.shop}`,
          category: 'commerce',
          status: 'syncing',
          externalAccountName: params.shop,
          authType: 'oauth',
          metadata,
          health: {
            state: 'syncing',
            checkedAt: new Date().toISOString(),
            stage: 'oauth_exchange_started',
          },
          disconnectedAt: null,
          createdById: params.createdById ?? existing.createdById,
        },
      });
    }

    return this.prisma.integration.create({
      data: {
        workspaceId: params.workspaceId,
        provider: this.provider,
        category: 'commerce',
        name: `Shopify - ${params.shop}`,
        status: 'syncing',
        externalAccountId: params.shop,
        externalAccountName: params.shop,
        authType: 'oauth',
        metadata,
        health: {
          state: 'syncing',
          checkedAt: new Date().toISOString(),
          stage: 'oauth_exchange_started',
        },
        createdById: params.createdById,
      },
    });
  }

  private async markConnectionAttemptFailed(params: {
    workspaceId: string;
    integrationId: string;
    shop: string;
    error: unknown;
  }) {
    const message = this.errorMessage(params.error);
    await this.prisma.integration.update({
      where: { id: params.integrationId },
      data: {
        status: 'error',
        health: {
          state: 'error',
          checkedAt: new Date().toISOString(),
          stage: 'oauth_exchange_failed',
          error: message,
        },
      },
    });

    await this.recordConnectionEvent({
      workspaceId: params.workspaceId,
      integrationId: params.integrationId,
      shop: params.shop,
      eventType: 'integration.oauth_failed',
      status: 'failed',
      error: message,
      payload: {
        stage: 'oauth_exchange_failed',
        shop: params.shop,
      },
    });
  }

  private async recordConnectionEvent(params: {
    workspaceId: string;
    integrationId: string;
    shop: string;
    eventType: string;
    status: string;
    payload: IntegrationJsonRecord;
    error?: string;
  }) {
    try {
      await this.prisma.integrationEvent.create({
        data: {
          workspaceId: params.workspaceId,
          integrationId: params.integrationId,
          provider: this.provider,
          eventType: params.eventType,
          externalEventId: params.shop,
          idempotencyKey: `${params.eventType}:${params.shop}:${randomUUID()}`,
          status: params.status,
          occurredAt: new Date(),
          processedAt: params.status === 'received' ? null : new Date(),
          payload: this.toInputJson(params.payload),
          error: params.error,
        },
      });
    } catch (error) {
      this.logger.warn(`Shopify connection event write failed: ${this.errorMessage(error)}`);
    }
  }

  private summarizeWebhookRegistration(value: {
    skipped: boolean;
    reason?: string;
    address?: string;
    created?: string[];
    reused?: string[];
    failed?: Array<{ topic: string; error: string }>;
  }) {
    return {
      skipped: value.skipped,
      reason: value.reason,
      createdCount: value.created?.length ?? 0,
      reusedCount: value.reused?.length ?? 0,
      failedCount: value.failed?.length ?? 0,
    };
  }

  private async runInitialSync(params: ShopifyInitialSyncContext) {
    const totals = {
      products: 0,
      customers: 0,
      orders: 0,
      carts: 0,
      skipped: [] as string[],
    };
    const resources = new Set<ShopifySyncResource>(
      params.resources ?? ['products', 'customers', 'orders', 'carts'],
    );

    if (resources.has('products')) {
      await this.runInitialSyncSection(totals.skipped, 'products', async () => {
        await this.runInitialSyncWithRestFallback(
          'products',
          () => this.syncInitialProductsGraphql(params, totals),
          () => this.syncInitialProductsRest(params, totals),
        );
      });
    }

    if (resources.has('customers')) {
      await this.runInitialSyncSection(totals.skipped, 'customers', async () => {
        await this.runInitialSyncWithRestFallback(
          'customers',
          () => this.syncInitialCustomersGraphql(params, totals),
          () => this.syncInitialCustomersRest(params, totals),
        );
      });
    }

    if (resources.has('orders')) {
      await this.runInitialSyncSection(totals.skipped, 'orders', async () => {
        await this.runInitialSyncWithRestFallback(
          'orders',
          () => this.syncInitialOrdersGraphql(params, totals),
          () => this.syncInitialOrdersRest(params, totals),
        );
      });
    }

    if (resources.has('carts')) {
      await this.runInitialSyncSection(totals.skipped, 'checkouts', async () => {
        await this.syncInitialCheckoutsRest(params, totals);
      });
    }

    return totals;
  }

  private async runInitialSyncWithRestFallback(
    resource: string,
    graphqlSync: () => Promise<void>,
    restSync: () => Promise<void>,
  ) {
    if (this.initialSyncApiMode() === 'rest') {
      await restSync();
      return;
    }

    try {
      await graphqlSync();
    } catch (error) {
      if (!this.shouldFallbackToRestInitialSync(error)) {
        throw error;
      }
      this.logger.warn(
        `Shopify GraphQL initial sync fell back to REST for ${resource}: ${this.errorMessage(error)}`,
      );
      await restSync();
    }
  }

  private async syncInitialProductsGraphql(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
  ) {
    for await (const rows of this.shopifyGraphqlPagedNodes(
      params.shop,
      params.accessToken,
      'products',
      this.productsGraphqlQuery(),
      { query: this.shopifyUpdatedAtGraphqlQuery(params) },
    )) {
      await this.syncInitialProductRows(
        params,
        totals,
        rows.map((row) => this.productPayloadFromGraphql(row)),
      );
    }
  }

  private async syncInitialProductsRest(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
  ) {
    for await (const rows of this.shopifyPagedRecords(
      params.shop,
      params.accessToken,
      'products.json',
      'products',
      { limit: this.initialSyncPageSize(), ...this.shopifyUpdatedAtRestQuery(params) },
    )) {
      await this.syncInitialProductRows(params, totals, rows);
    }
  }

  private async syncInitialProductRows(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
    rows: IntegrationJsonRecord[],
  ) {
    const products = rows.flatMap((row) => this.productInputsFromPayload(row, params.currency));
    if (!products.length) return;

    const result = await this.commerce.syncProducts({
      workspaceId: params.workspaceId,
      integrationId: params.integrationId,
      integrationResourceId: params.integrationResourceId ?? null,
      provider: this.provider,
      products,
    });
    totals.products += result.productCount;
  }

  private async syncInitialCustomersGraphql(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
  ) {
    for await (const rows of this.shopifyGraphqlPagedNodes(
      params.shop,
      params.accessToken,
      'customers',
      this.customersGraphqlQuery(),
      { query: this.shopifyUpdatedAtGraphqlQuery(params) },
    )) {
      await this.recordInitialCustomerRows(
        params,
        totals,
        rows.map((row) => this.customerPayloadFromGraphql(row)),
      );
    }
  }

  private async syncInitialCustomersRest(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
  ) {
    for await (const rows of this.shopifyPagedRecords(
      params.shop,
      params.accessToken,
      'customers.json',
      'customers',
      { limit: this.initialSyncPageSize(), ...this.shopifyUpdatedAtRestQuery(params) },
    )) {
      await this.recordInitialCustomerRows(params, totals, rows);
    }
  }

  private async recordInitialCustomerRows(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
    rows: IntegrationJsonRecord[],
  ) {
    for (const row of rows) {
      const customer = this.customerFromPayload(row);
      if (!customer) continue;
      await this.commerce.recordEvent({
        workspaceId: params.workspaceId,
        integrationId: params.integrationId,
        integrationResourceId: params.integrationResourceId ?? null,
        provider: this.provider,
        eventType: 'commerce.customer_updated',
        externalEventId: this.readString(row, 'id'),
        idempotencyKey: `shopify.initial_sync.customer:${this.readString(row, 'id') ?? this.hashFallback('customer', row)}`,
        occurredAt: this.readString(row, 'updated_at') ?? this.readString(row, 'created_at'),
        customer,
        raw: { source: 'initial_sync', resource: 'customers', payload: row },
      });
      totals.customers += 1;
    }
  }

  private async syncInitialOrdersGraphql(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
  ) {
    for await (const rows of this.shopifyGraphqlPagedNodes(
      params.shop,
      params.accessToken,
      'orders',
      this.ordersGraphqlQuery(),
      { query: ['status:any', this.shopifyUpdatedAtGraphqlQuery(params)].filter(Boolean).join(' ') },
    )) {
      await this.recordInitialOrderRows(
        params,
        totals,
        rows.map((row) => this.orderPayloadFromGraphql(row)),
      );
    }
  }

  private async syncInitialOrdersRest(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
  ) {
    for await (const rows of this.shopifyPagedRecords(
      params.shop,
      params.accessToken,
      'orders.json',
      'orders',
      { limit: this.initialSyncPageSize(), status: 'any', ...this.shopifyUpdatedAtRestQuery(params) },
    )) {
      await this.recordInitialOrderRows(params, totals, rows);
    }
  }

  private async recordInitialOrderRows(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
    rows: IntegrationJsonRecord[],
  ) {
    for (const row of rows) {
      await this.commerce.recordEvent({
        workspaceId: params.workspaceId,
        integrationId: params.integrationId,
        integrationResourceId: params.integrationResourceId ?? null,
        provider: this.provider,
        eventType: this.orderEventTypeFromPayload(row),
        externalEventId: this.readString(row, 'id'),
        idempotencyKey: `shopify.initial_sync.order:${this.readString(row, 'id') ?? this.hashFallback('order', row)}`,
        occurredAt: this.readString(row, 'updated_at') ?? this.readString(row, 'created_at'),
        customer: this.customerFromPayload(row),
        products: this.productsFromPayload(row),
        order: this.orderFromPayload(row),
        raw: { source: 'initial_sync', resource: 'orders', payload: row },
      });
      totals.orders += 1;
    }
  }

  private async syncInitialCheckoutsRest(
    params: ShopifyInitialSyncContext,
    totals: ShopifyInitialSyncTotals,
  ) {
    for await (const rows of this.shopifyPagedRecords(
      params.shop,
      params.accessToken,
      'checkouts.json',
      'checkouts',
      { limit: this.initialSyncPageSize(), ...this.shopifyUpdatedAtRestQuery(params) },
    )) {
      for (const row of rows) {
        await this.commerce.recordEvent({
          workspaceId: params.workspaceId,
          integrationId: params.integrationId,
          integrationResourceId: params.integrationResourceId ?? null,
          provider: this.provider,
          eventType: this.cartEventTypeFromPayload(row),
          externalEventId: this.readString(row, 'id') ?? this.readString(row, 'token'),
          idempotencyKey: `shopify.initial_sync.checkout:${this.readString(row, 'id') ?? this.readString(row, 'token') ?? this.hashFallback('checkout', row)}`,
          occurredAt: this.readString(row, 'updated_at') ?? this.readString(row, 'created_at'),
          customer: this.customerFromPayload(row),
          products: this.productsFromPayload(row),
          cart: this.cartFromPayload(row),
          raw: { source: 'initial_sync', resource: 'checkouts', payload: row },
        });
        totals.carts += 1;
      }
    }
  }

  private async runInitialSyncSection(
    skipped: string[],
    resource: string,
    work: () => Promise<void>,
  ) {
    try {
      await work();
    } catch (error) {
      if (!this.isSkippableInitialSyncError(error)) {
        throw error;
      }
      const message = this.errorMessage(error);
      skipped.push(`${resource}: ${message}`);
      this.logger.warn(`Shopify initial sync skipped ${resource}: ${message}`);
    }
  }

  private isSkippableInitialSyncError(error: unknown) {
    return (
      error instanceof ShopifyApiRequestException &&
      (error.providerStatusCode === 403 || error.providerStatusCode === 404)
    );
  }

  private async exchangeCodeForToken(shop: string, code: string) {
    const clientId = process.env.SHOPIFY_API_KEY || '';
    const clientSecret = process.env.SHOPIFY_API_SECRET || '';
    if (!clientId || !clientSecret) {
      throw new BadRequestException('SHOPIFY_API_KEY and SHOPIFY_API_SECRET must be configured');
    }

    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });
    const data = await this.readResponseJson(response);
    if (!response.ok) {
      throw new BadRequestException(this.providerErrorMessage(data, 'Shopify OAuth exchange failed'));
    }
    return this.asRecord(data);
  }

  private async fetchShopInfo(shop: string, accessToken: string) {
    const data = await this.shopifyGet(shop, accessToken, 'shop.json');
    return this.readRecord(data, 'shop') ?? {};
  }

  private readShopifyCredentials(integration: ConnectedIntegrationSnapshot) {
    const credentials = integration.credentialsEncrypted
      ? this.secrets.decryptJson(integration.credentialsEncrypted)
      : {};
    const accessToken = this.readString(credentials, 'accessToken');
    const shop = this.normalizeShopDomain(
      this.readString(credentials, 'shop') ?? integration.externalAccountId,
    );

    if (!accessToken || !shop) {
      throw new BadRequestException('Shopify credentials are incomplete');
    }

    return { accessToken, shop };
  }

  private async registerDefaultWebhooks(params: {
    integrationId: string;
    shop: string;
    accessToken: string;
  }) {
    const baseUrl =
      process.env.SHOPIFY_WEBHOOK_BASE_URL ??
      process.env.INTEGRATION_WEBHOOK_BASE_URL ??
      process.env.PUBLIC_API_BASE_URL ??
      process.env.BACKEND_PUBLIC_URL ??
      process.env.AUTH_API_BASE_URL ??
      process.env.API_BASE_URL;
    if (!baseUrl) {
      return {
        skipped: true,
        reason:
          'SHOPIFY_WEBHOOK_BASE_URL, INTEGRATION_WEBHOOK_BASE_URL, PUBLIC_API_BASE_URL, or BACKEND_PUBLIC_URL is not configured',
      };
    }

    const publicRoot = baseUrl.replace(/\/api\/?$/, '').replace(/\/$/, '');
    const address = `${publicRoot}/api/integrations/shopify/webhook/${params.integrationId}`;
    const existing = await this.listWebhooks(params.shop, params.accessToken);
    const created: string[] = [];
    const reused: string[] = [];
    const failed: Array<{ topic: string; error: string }> = [];

    for (const topic of this.defaultWebhookTopics()) {
      const alreadyRegistered = existing.some(
        (webhook) => webhook.topic === topic && webhook.address === address,
      );
      if (alreadyRegistered) {
        reused.push(topic);
        continue;
      }

      try {
        await this.createWebhook(params.shop, params.accessToken, topic, address);
        created.push(topic);
      } catch (error) {
        failed.push({ topic, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      skipped: false,
      address,
      created,
      reused,
      failed,
    };
  }

  private webhookRegistrationHealthState(value: {
    skipped: boolean;
    failed?: Array<{ topic: string; error: string }>;
  }) {
    if (value.skipped) return 'warning';
    return value.failed?.length ? 'warning' : 'ok';
  }

  private publicApiRoot() {
    return (
      process.env.PUBLIC_API_BASE_URL ??
      process.env.BACKEND_PUBLIC_URL ??
      process.env.AUTH_API_BASE_URL ??
      process.env.API_BASE_URL ??
      'http://localhost:3000'
    ).replace(/\/api\/?$/, '').replace(/\/$/, '');
  }

  private async listWebhooks(shop: string, accessToken: string) {
    const data = await this.shopifyGet(shop, accessToken, 'webhooks.json?limit=250');
    const rows = this.readArray(data, 'webhooks');
    return rows.filter((row): row is IntegrationJsonRecord => this.isRecord(row)).map((row) => ({
      id: this.readString(row, 'id'),
      topic: this.readString(row, 'topic'),
      address: this.readString(row, 'address'),
    }));
  }

  private async createWebhook(shop: string, accessToken: string, topic: string, address: string) {
    await this.shopifyRequest(shop, accessToken, 'webhooks.json', {
      method: 'POST',
      body: {
        webhook: {
          topic,
          address,
          format: 'json',
        },
      },
    });
  }

  private async shopifyGet(shop: string, accessToken: string, path: string) {
    return this.shopifyRequest(shop, accessToken, path, { method: 'GET' });
  }

  private async *shopifyPagedRecords(
    shop: string,
    accessToken: string,
    path: string,
    rootKey: string,
    query: Record<string, string | number | undefined> = {},
  ): AsyncGenerator<IntegrationJsonRecord[]> {
    let nextPath: string | null = this.withQuery(path, query);
    let page = 0;
    const maxPages = this.initialSyncMaxPages();

    while (nextPath && page < maxPages) {
      const result = await this.shopifyRequestWithHeaders(shop, accessToken, nextPath, {
        method: 'GET',
      });
      const rows = this.readArray(result.data, rootKey).filter((row): row is IntegrationJsonRecord =>
        this.isRecord(row),
      );
      yield rows;
      nextPath = result.nextPath;
      page += 1;
    }
  }

  private async *shopifyGraphqlPagedNodes(
    shop: string,
    accessToken: string,
    rootKey: string,
    query: string,
    variables: IntegrationJsonRecord = {},
  ): AsyncGenerator<IntegrationJsonRecord[]> {
    let after: string | null = null;
    let page = 0;
    const maxPages = this.initialSyncMaxPages();

    while (page < maxPages) {
      const data = await this.shopifyGraphqlRequest(shop, accessToken, query, {
        ...variables,
        first: this.initialSyncPageSize(),
        after,
      });
      const connection = this.readRecord(data, rootKey);
      if (!connection) {
        yield [];
        return;
      }

      yield this.graphqlConnectionNodes(connection);

      const pageInfo = this.readRecord(connection, 'pageInfo');
      if (!this.readBoolean(pageInfo ?? {}, 'hasNextPage')) return;
      after = this.readString(pageInfo ?? {}, 'endCursor');
      if (!after) return;
      page += 1;
    }
  }

  private async shopifyGraphqlRequest(
    shop: string,
    accessToken: string,
    query: string,
    variables: IntegrationJsonRecord,
  ) {
    const response = await fetch(`https://${shop}/admin/api/${this.shopifyApiVersion()}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    const data = await this.readResponseJson(response);
    const root = this.asRecord(data);
    const errors = this.readArray(root, 'errors');
    if (!response.ok || errors.length > 0) {
      const message = this.graphqlErrorMessage(errors, response.statusText || 'Unknown error');
      throw new ShopifyGraphqlRequestException(
        response.ok ? this.graphqlErrorStatus(message) : response.status,
        `Shopify GraphQL request failed${response.ok ? '' : ` (${response.status})`}: ${message}`,
      );
    }

    return this.readRecord(root, 'data') ?? {};
  }

  private async shopifyRequest(
    shop: string,
    accessToken: string,
    path: string,
    opts: { method: 'GET' | 'POST'; body?: IntegrationJsonRecord },
  ) {
    const result = await this.shopifyRequestWithHeaders(shop, accessToken, path, opts);
    return result.data;
  }

  private async shopifyRequestWithHeaders(
    shop: string,
    accessToken: string,
    path: string,
    opts: { method: 'GET' | 'POST'; body?: IntegrationJsonRecord },
  ) {
    const response = await fetch(`https://${shop}/admin/api/${this.shopifyApiVersion()}/${path}`, {
      method: opts.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await this.readResponseJson(response);
    if (!response.ok) {
      throw new ShopifyApiRequestException(
        response.status,
        `Shopify API request failed (${response.status}): ${this.providerErrorMessage(data, response.statusText || 'Unknown error')}`,
      );
    }
    return {
      data: this.asRecord(data),
      nextPath: this.nextLinkPath(response.headers.get('link')),
    };
  }

  private nextLinkPath(linkHeader: string | null) {
    if (!linkHeader) return null;
    const nextLink = linkHeader
      .split(',')
      .map((part) => part.trim())
      .find((part) => /rel="?next"?/.test(part));
    const urlMatch = nextLink?.match(/<([^>]+)>/);
    if (!urlMatch?.[1]) return null;

    try {
      const url = new URL(urlMatch[1]);
      const versionPrefix = `/admin/api/${this.shopifyApiVersion()}/`;
      const versionIndex = url.pathname.indexOf(versionPrefix);
      const relativePath =
        versionIndex >= 0
          ? url.pathname.slice(versionIndex + versionPrefix.length)
          : url.pathname.replace(/^\/+/, '');
      return `${relativePath}${url.search}`;
    } catch {
      return null;
    }
  }

  private withQuery(path: string, query: Record<string, string | number | undefined>) {
    const cleanPath = path.replace(/^\/+/, '');
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    });
    const queryString = params.toString();
    if (!queryString) return cleanPath;
    return `${cleanPath}${cleanPath.includes('?') ? '&' : '?'}${queryString}`;
  }

  private initialSyncMaxPages() {
    const parsed = Number(process.env.SHOPIFY_INITIAL_SYNC_MAX_PAGES ?? 8);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.trunc(parsed))) : 8;
  }

  private initialSyncPageSize() {
    const parsed = Number(process.env.SHOPIFY_INITIAL_SYNC_PAGE_SIZE ?? 100);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(250, Math.trunc(parsed))) : 100;
  }

  private assertOAuthHmac(query: Record<string, string | undefined>) {
    const secret = process.env.SHOPIFY_API_SECRET;
    const hmac = query.hmac;
    if (!secret || !hmac) return;

    const message = Object.entries(query)
      .filter(([key, value]) => key !== 'hmac' && key !== 'signature' && value != null)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const digest = createHmac('sha256', secret).update(message).digest('hex');
    const expected = Buffer.from(digest, 'utf8');
    const provided = Buffer.from(hmac, 'utf8');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new BadRequestException('Invalid Shopify OAuth signature');
    }
  }

  private defaultWebhookTopics() {
    return [
      'customers/create',
      'customers/update',
      'orders/create',
      'orders/paid',
      'orders/fulfilled',
      'orders/cancelled',
      'refunds/create',
      'checkouts/create',
      'checkouts/update',
    ];
  }

  private shopifyApiVersion() {
    return process.env.SHOPIFY_API_VERSION || '2026-04';
  }

  private topicToCommerceEvent(topic: string): CommerceEventType | null {
    switch (topic) {
      case 'customers/create':
        return 'commerce.customer_created';
      case 'customers/update':
        return 'commerce.customer_updated';
      case 'orders/create':
        return 'commerce.order_created';
      case 'orders/paid':
        return 'commerce.order_paid';
      case 'orders/fulfilled':
        return 'commerce.order_fulfilled';
      case 'orders/cancelled':
        return 'commerce.order_cancelled';
      case 'refunds/create':
        return 'commerce.refund_created';
      case 'checkouts/create':
        return 'commerce.cart_created';
      case 'checkouts/update':
        return 'commerce.cart_updated';
      case 'carts/update':
        return 'commerce.cart_updated';
      default:
        return null;
    }
  }

  private commerceEventTypeFromStoredEvent(eventType: string): CommerceEventType | null {
    switch (eventType) {
      case 'commerce.customer_created':
      case 'commerce.customer_updated':
      case 'commerce.cart_created':
      case 'commerce.cart_updated':
      case 'commerce.cart_abandoned':
      case 'commerce.order_created':
      case 'commerce.order_paid':
      case 'commerce.order_fulfilled':
      case 'commerce.order_cancelled':
      case 'commerce.refund_created':
        return eventType;
      default:
        return null;
    }
  }

  private productsGraphqlQuery() {
    return `
      query AxodeskProducts($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
          edges {
            cursor
            node {
              id
              title
              handle
              productType
              vendor
              status
              createdAt
              updatedAt
              featuredImage { url }
              images(first: 1) { edges { node { url } } }
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    inventoryQuantity
                    image { url }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
  }

  private customersGraphqlQuery() {
    return `
      query AxodeskCustomers($first: Int!, $after: String, $query: String) {
        customers(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
          edges {
            cursor
            node {
              id
              email
              phone
              firstName
              lastName
              numberOfOrders
              amountSpent { amount currencyCode }
              defaultAddress { company }
              createdAt
              updatedAt
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
  }

  private ordersGraphqlQuery() {
    return `
      query AxodeskOrders($first: Int!, $after: String, $query: String) {
        orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
          edges {
            cursor
            node {
              id
              name
              email
              phone
              currencyCode
              displayFinancialStatus
              displayFulfillmentStatus
              createdAt
              updatedAt
              processedAt
              cancelledAt
              closedAt
              subtotalPriceSet { shopMoney { amount currencyCode } }
              totalDiscountsSet { shopMoney { amount currencyCode } }
              totalTaxSet { shopMoney { amount currencyCode } }
              totalShippingPriceSet { shopMoney { amount currencyCode } }
              totalPriceSet { shopMoney { amount currencyCode } }
              customer {
                id
                email
                phone
                firstName
                lastName
                numberOfOrders
                amountSpent { amount currencyCode }
                defaultAddress { company }
                createdAt
                updatedAt
              }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    quantity
                    product { id }
                    variant { id }
                    originalUnitPriceSet { shopMoney { amount currencyCode } }
                    discountedTotalSet { shopMoney { amount currencyCode } }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
  }

  private productPayloadFromGraphql(node: IntegrationJsonRecord): IntegrationJsonRecord {
    const featuredImage = this.readRecord(node, 'featuredImage');
    const imageUrl =
      this.readString(featuredImage ?? {}, 'url') ??
      this.graphqlConnectionNodes(this.readRecord(node, 'images') ?? {})
        .map((image) => this.readString(image, 'url'))
        .find((url): url is string => !!url) ??
      null;
    const variants = this.graphqlConnectionNodes(this.readRecord(node, 'variants') ?? {})
      .map((variant) => ({
        id: this.shopifyScalarId(this.readString(variant, 'id')),
        title: this.readString(variant, 'title'),
        sku: this.readString(variant, 'sku'),
        price: this.readString(variant, 'price'),
        inventory_quantity: this.readNumber(variant, 'inventoryQuantity'),
        image: this.readString(this.readRecord(variant, 'image') ?? {}, 'url')
          ? { src: this.readString(this.readRecord(variant, 'image') ?? {}, 'url') }
          : undefined,
      }));

    return {
      id: this.shopifyScalarId(this.readString(node, 'id')),
      title: this.readString(node, 'title'),
      handle: this.readString(node, 'handle'),
      product_type: this.readString(node, 'productType'),
      vendor: this.readString(node, 'vendor'),
      status: this.lowerProviderStatus(this.readString(node, 'status')),
      created_at: this.readString(node, 'createdAt'),
      updated_at: this.readString(node, 'updatedAt'),
      image: imageUrl ? { src: imageUrl } : undefined,
      images: imageUrl ? [{ src: imageUrl }] : [],
      variants,
    };
  }

  private customerPayloadFromGraphql(node: IntegrationJsonRecord): IntegrationJsonRecord {
    const amountSpent = this.readRecord(node, 'amountSpent');
    const defaultAddress = this.readRecord(node, 'defaultAddress');

    return {
      id: this.shopifyScalarId(this.readString(node, 'id')),
      email: this.readString(node, 'email'),
      phone: this.readString(node, 'phone'),
      first_name: this.readString(node, 'firstName'),
      last_name: this.readString(node, 'lastName'),
      orders_count: this.readNumber(node, 'numberOfOrders'),
      total_spent: this.readString(amountSpent ?? {}, 'amount'),
      currency: this.readString(amountSpent ?? {}, 'currencyCode'),
      billing_address: defaultAddress ? { company: this.readString(defaultAddress, 'company') } : undefined,
      created_at: this.readString(node, 'createdAt'),
      updated_at: this.readString(node, 'updatedAt'),
    };
  }

  private orderPayloadFromGraphql(node: IntegrationJsonRecord): IntegrationJsonRecord {
    const customer = this.readRecord(node, 'customer');
    const shippingAmount = this.moneyAmountFromGraphql(node, 'totalShippingPriceSet');
    const lineItems = this.graphqlConnectionNodes(this.readRecord(node, 'lineItems') ?? {})
      .map((item) => ({
        id: this.shopifyScalarId(this.readString(item, 'id')),
        product_id: this.shopifyScalarId(this.readString(this.readRecord(item, 'product') ?? {}, 'id')),
        variant_id: this.shopifyScalarId(this.readString(this.readRecord(item, 'variant') ?? {}, 'id')),
        sku: this.readString(item, 'sku'),
        title: this.readString(item, 'title'),
        quantity: this.readNumber(item, 'quantity'),
        price: this.moneyAmountFromGraphql(item, 'originalUnitPriceSet'),
        line_price: this.moneyAmountFromGraphql(item, 'discountedTotalSet'),
      }));

    return {
      id: this.shopifyScalarId(this.readString(node, 'id')),
      name: this.readString(node, 'name'),
      order_number: this.readString(node, 'name'),
      financial_status: this.lowerProviderStatus(this.readString(node, 'displayFinancialStatus')),
      fulfillment_status: this.lowerProviderStatus(this.readString(node, 'displayFulfillmentStatus')),
      currency: this.readString(node, 'currencyCode'),
      subtotal_price: this.moneyAmountFromGraphql(node, 'subtotalPriceSet'),
      total_discounts: this.moneyAmountFromGraphql(node, 'totalDiscountsSet'),
      total_tax: this.moneyAmountFromGraphql(node, 'totalTaxSet'),
      total_price: this.moneyAmountFromGraphql(node, 'totalPriceSet'),
      shipping_lines: shippingAmount ? [{ price: shippingAmount }] : [],
      email: this.readString(node, 'email'),
      phone: this.readString(node, 'phone'),
      created_at: this.readString(node, 'createdAt'),
      updated_at: this.readString(node, 'updatedAt'),
      processed_at: this.readString(node, 'processedAt'),
      closed_at: this.readString(node, 'closedAt'),
      cancelled_at: this.readString(node, 'cancelledAt'),
      customer: customer ? this.customerPayloadFromGraphql(customer) : undefined,
      line_items: lineItems,
    };
  }

  private assertWebhookSignature(params: IntegrationWebhookParams) {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET ?? process.env.SHOPIFY_API_SECRET;
    if (!secret) return;

    const providedHmac = this.headerValue(params.headers, 'x-shopify-hmac-sha256');
    if (!providedHmac) {
      throw new BadRequestException('Missing Shopify webhook signature');
    }

    if (!params.rawBody) {
      throw new BadRequestException('Shopify webhook verification requires raw body support');
    }

    const rawBody = Buffer.isBuffer(params.rawBody)
      ? params.rawBody
      : Buffer.from(params.rawBody, 'utf8');
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(providedHmac, 'utf8');
    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      throw new BadRequestException('Invalid Shopify webhook signature');
    }
  }

  private customerFromPayload(payload: IntegrationJsonRecord): CommerceCustomerInput | null {
    const customer = this.readRecord(payload, 'customer') ?? payload;
    const externalCustomerId = this.readString(customer, 'id');
    const email = this.readString(customer, 'email') ?? this.readString(payload, 'email');
    const phone = this.readString(customer, 'phone') ?? this.readString(payload, 'phone');
    if (!externalCustomerId && !email && !phone) return null;

    return {
      externalCustomerId: externalCustomerId ?? email ?? phone ?? this.hashFallback('customer', payload),
      email,
      phone,
      firstName: this.readString(customer, 'first_name'),
      lastName: this.readString(customer, 'last_name'),
      company: this.readString(this.readRecord(payload, 'billing_address') ?? {}, 'company'),
      marketingOptIn: this.readBoolean(customer, 'accepts_marketing'),
      totalOrders: this.readNumber(customer, 'orders_count') ?? 0,
      totalSpentAmount: this.moneyToMinorUnit(this.readString(customer, 'total_spent')),
      currency: this.readString(payload, 'currency'),
      firstSeenAt: this.readString(customer, 'created_at'),
      lastSeenAt: this.readString(customer, 'updated_at') ?? this.readString(payload, 'updated_at'),
      metadata: customer,
    };
  }

  private orderFromPayload(payload: IntegrationJsonRecord): CommerceOrderInput {
    return {
      externalOrderId: this.readString(payload, 'id') ?? this.hashFallback('order', payload),
      orderNumber:
        this.readString(payload, 'name') ??
        this.readString(payload, 'order_number') ??
        this.readString(payload, 'number'),
      status: this.orderStatusFromPayload(payload),
      financialStatus: this.readString(payload, 'financial_status'),
      fulfillmentStatus: this.readString(payload, 'fulfillment_status'),
      currency: this.readString(payload, 'currency'),
      subtotalAmount: this.moneyToMinorUnit(this.readString(payload, 'subtotal_price')),
      discountAmount: this.moneyToMinorUnit(this.readString(payload, 'total_discounts')),
      taxAmount: this.moneyToMinorUnit(this.readString(payload, 'total_tax')),
      shippingAmount: this.shippingAmount(payload),
      totalAmount: this.moneyToMinorUnit(this.readString(payload, 'total_price')),
      email: this.readString(payload, 'email'),
      phone: this.readString(payload, 'phone'),
      placedAt: this.readString(payload, 'created_at'),
      paidAt: this.readString(payload, 'processed_at'),
      fulfilledAt: this.readString(payload, 'closed_at'),
      cancelledAt: this.readString(payload, 'cancelled_at'),
      lineItems: this.lineItemsFromPayload(payload),
      metadata: payload,
    };
  }

  private cartFromPayload(payload: IntegrationJsonRecord): CommerceCartInput {
    const completedAt = this.readString(payload, 'completed_at');
    const abandonedCheckoutUrl = this.readString(payload, 'abandoned_checkout_url');
    return {
      externalCartId:
        this.readString(payload, 'id') ??
        this.readString(payload, 'token') ??
        this.hashFallback('cart', payload),
      externalCheckoutId: this.readString(payload, 'checkout_id') ?? this.readString(payload, 'token'),
      status: completedAt ? 'recovered' : abandonedCheckoutUrl ? 'abandoned' : 'active',
      currency: this.readString(payload, 'currency'),
      subtotalAmount: this.moneyToMinorUnit(this.readString(payload, 'subtotal_price')),
      totalAmount:
        this.moneyToMinorUnit(this.readString(payload, 'total_price')) ??
        this.moneyToMinorUnit(this.readString(payload, 'total_price_set')),
      itemCount: this.lineItemsFromPayload(payload).reduce((sum, item) => sum + (item.quantity ?? 1), 0),
      checkoutUrl:
        abandonedCheckoutUrl ??
        this.readString(payload, 'web_url') ??
        this.readString(payload, 'checkout_url'),
      email: this.readString(payload, 'email'),
      phone: this.readString(payload, 'phone'),
      providerCreatedAt: this.readString(payload, 'created_at'),
      providerUpdatedAt: this.readString(payload, 'updated_at'),
      abandonedAt: abandonedCheckoutUrl
        ? this.readString(payload, 'updated_at') ?? this.readString(payload, 'created_at') ?? new Date()
        : null,
      recoveredAt: completedAt,
      lineItems: this.lineItemsFromPayload(payload),
      metadata: payload,
    };
  }

  private orderEventTypeFromPayload(payload: IntegrationJsonRecord): CommerceEventType {
    if (this.readString(payload, 'cancelled_at')) return 'commerce.order_cancelled';
    if (this.readString(payload, 'fulfillment_status') === 'fulfilled') {
      return 'commerce.order_fulfilled';
    }
    if (this.readString(payload, 'financial_status') === 'paid') return 'commerce.order_paid';
    return 'commerce.order_created';
  }

  private orderStatusFromPayload(payload: IntegrationJsonRecord) {
    if (this.readString(payload, 'cancelled_at')) return 'cancelled';
    if (this.readString(payload, 'fulfillment_status') === 'fulfilled') return 'fulfilled';
    if (this.readString(payload, 'financial_status') === 'paid') return 'paid';
    return 'created';
  }

  private cartEventTypeFromPayload(payload: IntegrationJsonRecord): CommerceEventType {
    if (this.readString(payload, 'abandoned_checkout_url') && !this.readString(payload, 'completed_at')) {
      return 'commerce.cart_abandoned';
    }
    return 'commerce.cart_updated';
  }

  private productInputsFromPayload(
    payload: IntegrationJsonRecord,
    currency?: string,
  ): CommerceProductInput[] {
    const productId = this.readString(payload, 'id');
    if (!productId) return [];

    const title = this.readString(payload, 'title') ?? 'Product';
    const variants = this.readArray(payload, 'variants').filter((row): row is IntegrationJsonRecord =>
      this.isRecord(row),
    );

    if (variants.length === 0) {
      return [{
        externalProductId: productId,
        title,
        handle: this.readString(payload, 'handle'),
        productType: this.readString(payload, 'product_type'),
        vendor: this.readString(payload, 'vendor'),
        status: this.readString(payload, 'status') ?? 'active',
        imageUrl: this.productImageUrl(payload),
        currency: currency ?? null,
        metadata: payload,
      }];
    }

    return variants.map((variant) => {
      const variantTitle = this.readString(variant, 'title');
      const displayTitle =
        variantTitle && variantTitle !== 'Default Title'
          ? `${title} - ${variantTitle}`
          : title;
      return {
        externalProductId: productId,
        externalVariantId: this.readString(variant, 'id'),
        title: displayTitle,
        sku: this.readString(variant, 'sku'),
        handle: this.readString(payload, 'handle'),
        productType: this.readString(payload, 'product_type'),
        vendor: this.readString(payload, 'vendor'),
        status: this.readString(payload, 'status') ?? 'active',
        imageUrl: this.productImageUrl(payload),
        priceAmount: this.moneyToMinorUnit(this.readString(variant, 'price')),
        currency: currency ?? null,
        inventoryQuantity: this.readNumber(variant, 'inventory_quantity') ?? null,
        metadata: { product: payload, variant },
      };
    });
  }

  private productImageUrl(payload: IntegrationJsonRecord) {
    return (
      this.readString(this.readRecord(payload, 'image') ?? {}, 'src') ??
      this.readArray(payload, 'images')
        .map((image) => this.readString(image, 'src'))
        .find((src): src is string => !!src) ??
      null
    );
  }

  private productsFromPayload(payload: IntegrationJsonRecord) {
    return this.lineItemsFromPayload(payload)
      .filter((item) => item.externalProductId)
      .map((item) => ({
        externalProductId: item.externalProductId as string,
        externalVariantId: item.externalVariantId,
        title: item.title,
        sku: item.sku,
        priceAmount: item.unitPriceAmount,
        currency: this.readString(payload, 'currency'),
        metadata: item.metadata ?? {},
      }));
  }

  private lineItemsFromPayload(payload: IntegrationJsonRecord): CommerceLineItemInput[] {
    const rows =
      this.readArray(payload, 'line_items').length > 0
        ? this.readArray(payload, 'line_items')
        : this.readArray(payload, 'items');

    return rows.filter((row): row is IntegrationJsonRecord => this.isRecord(row)).map((row) => ({
      externalLineItemId: this.readString(row, 'id'),
      externalProductId: this.readString(row, 'product_id'),
      externalVariantId: this.readString(row, 'variant_id'),
      sku: this.readString(row, 'sku'),
      title: this.readString(row, 'title') ?? this.readString(row, 'name') ?? 'Product',
      quantity: this.readNumber(row, 'quantity') ?? 1,
      unitPriceAmount: this.moneyToMinorUnit(this.readString(row, 'price')),
      totalAmount: this.moneyToMinorUnit(this.readString(row, 'line_price')),
      metadata: row,
    }));
  }

  private shippingAmount(payload: IntegrationJsonRecord) {
    const lines = this.readArray(payload, 'shipping_lines');
    return lines.reduce<number>((sum, line) => {
      if (!this.isRecord(line)) return sum;
      return sum + (this.moneyToMinorUnit(this.readString(line, 'price')) ?? 0);
    }, 0);
  }

  private graphqlConnectionNodes(connection: IntegrationJsonRecord | unknown): IntegrationJsonRecord[] {
    const edges = this.readArray(connection, 'edges');
    return edges
      .map((edge) => this.readRecord(edge, 'node'))
      .filter((node): node is IntegrationJsonRecord => !!node);
  }

  private moneyAmountFromGraphql(record: IntegrationJsonRecord, key: string) {
    const moneySet = this.readRecord(record, key);
    const shopMoney = this.readRecord(moneySet ?? {}, 'shopMoney') ?? moneySet;
    return this.readString(shopMoney ?? {}, 'amount');
  }

  private shopifyScalarId(value?: string | null) {
    if (!value) return null;
    return value.split('/').filter(Boolean).at(-1) ?? value;
  }

  private lowerProviderStatus(value?: string | null) {
    return value ? value.toLowerCase() : null;
  }

  private initialSyncApiMode() {
    return (process.env.SHOPIFY_INITIAL_SYNC_API ?? 'graphql').toLowerCase() === 'rest'
      ? 'rest'
      : 'graphql';
  }

  private shopifySyncResources(values?: string[]): ShopifySyncResource[] | undefined {
    if (!values?.length) return undefined;
    const allowed = new Set<ShopifySyncResource>(['products', 'customers', 'orders', 'carts']);
    const resources = [...new Set(values)]
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is ShopifySyncResource => allowed.has(value as ShopifySyncResource));
    return resources.length ? resources : undefined;
  }

  private shopifySyncResourcesFromInput(input: IntegrationJsonRecord): ShopifySyncResource[] | undefined {
    const raw = input.resources;
    return Array.isArray(raw)
      ? this.shopifySyncResources(raw.map((item) => String(item)))
      : undefined;
  }

  private shopifyUpdatedAtRestQuery(params: Pick<ShopifyInitialSyncContext, 'since' | 'until'>) {
    return {
      updated_at_min: params.since,
      updated_at_max: params.until,
    };
  }

  private shopifyUpdatedAtGraphqlQuery(params: Pick<ShopifyInitialSyncContext, 'since' | 'until'>) {
    const parts: string[] = [];
    if (params.since) parts.push(`updated_at:>=${params.since}`);
    if (params.until) parts.push(`updated_at:<=${params.until}`);
    return parts.length ? parts.join(' ') : undefined;
  }

  private shouldFallbackToRestInitialSync(error: unknown) {
    return (
      process.env.SHOPIFY_INITIAL_SYNC_GRAPHQL_FALLBACK !== 'false' &&
      error instanceof ShopifyGraphqlRequestException &&
      error.providerStatusCode === 400
    );
  }

  private normalizeShopDomain(value?: string | null) {
    const raw = value?.trim().toLowerCase();
    if (!raw) return null;
    const host = raw.replace(/^https?:\/\//, '').split('/')[0]?.split('?')[0];
    if (!host) return null;
    const candidate = host.endsWith('.myshopify.com')
      ? host
      : `${host.replace(/\.myshopify\.com$/, '')}.myshopify.com`;
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(candidate) ? candidate : null;
  }

  private headerValue(headers: IntegrationWebhookParams['headers'], key: string) {
    if (!headers) return null;
    const found = Object.entries(headers).find(([headerKey]) => headerKey.toLowerCase() === key);
    const value = found?.[1];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }

  private asRecord(value: unknown): IntegrationJsonRecord {
    return this.isRecord(value) ? value : {};
  }

  private isRecord(value: unknown): value is IntegrationJsonRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private readRecord(record: IntegrationJsonRecord | unknown, key: string): IntegrationJsonRecord | null {
    if (!this.isRecord(record)) return null;
    const value = record[key];
    return this.isRecord(value) ? value : null;
  }

  private readArray(record: IntegrationJsonRecord | unknown, key: string): unknown[] {
    if (!this.isRecord(record)) return [];
    const value = record[key];
    return Array.isArray(value) ? value : [];
  }

  private readString(record: IntegrationJsonRecord | unknown, key: string): string | null {
    if (!this.isRecord(record)) return null;
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
  }

  private readNumber(record: IntegrationJsonRecord | unknown, key: string): number | undefined {
    if (!this.isRecord(record)) return undefined;
    const value = record[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private readBoolean(record: IntegrationJsonRecord | unknown, key: string): boolean | null {
    if (!this.isRecord(record)) return null;
    const value = record[key];
    return typeof value === 'boolean' ? value : null;
  }

  private moneyToMinorUnit(value?: string | null) {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
  }

  private async readResponseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { message: text };
    }
  }

  private providerErrorMessage(value: unknown, fallback: string) {
    const root = this.asRecord(value);
    const errors = root.errors;
    const error = root.error;

    if (typeof errors === 'string') return errors;
    if (Array.isArray(errors)) {
      const messages = errors
        .map((item) => this.providerErrorPart(item))
        .filter((item): item is string => !!item);
      if (messages.length) return messages.join('; ');
    }
    if (this.isRecord(errors)) {
      const message = this.readString(errors, 'message');
      if (message) return message;
      const messages = Object.entries(errors)
        .map(([key, entry]) => `${key}: ${this.providerErrorPart(entry) ?? String(entry)}`)
        .filter(Boolean);
      if (messages.length) return messages.join('; ');
    }

    if (typeof error === 'string') return error;
    if (this.isRecord(error)) {
      const message = this.readString(error, 'message');
      if (message) return message;
    }

    return (
      this.readString(root, 'error_description') ??
      this.readString(root, 'message') ??
      fallback
    );
  }

  private providerErrorPart(value: unknown) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      return value
        .map((item) => this.providerErrorPart(item))
        .filter((item): item is string => !!item)
        .join(', ');
    }
    if (this.isRecord(value)) {
      return this.readString(value, 'message') ?? JSON.stringify(value);
    }
    return null;
  }

  private graphqlErrorMessage(errors: unknown[], fallback: string) {
    const messages = errors
      .map((error) => {
        if (!this.isRecord(error)) return null;
        return this.readString(error, 'message');
      })
      .filter((message): message is string => !!message);
    return messages.length ? messages.join('; ') : fallback;
  }

  private graphqlErrorStatus(message: string) {
    const normalized = message.toLowerCase();
    if (
      normalized.includes('access denied') ||
      normalized.includes('requires merchant approval') ||
      normalized.includes('scope')
    ) {
      return 403;
    }
    return 400;
  }

  private errorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private toInputJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }

  private hashFallback(prefix: string, value: unknown) {
    return `${prefix}-${createHmac('sha256', 'shopify-fallback').update(JSON.stringify(value ?? {})).digest('hex')}`;
  }
}
