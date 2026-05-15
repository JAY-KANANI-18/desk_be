import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Integration, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { MessageProcessingQueueService } from '../outbound/message-processing-queue.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  INTEGRATION_PROVIDER_CATALOG,
  IntegrationProviderKey,
} from './integration-catalog';
import { IntegrationSecretService } from './integration-secret.service';
import { IntegrationAdapterRegistry } from './adapters/integration-adapter.registry';
import { IntegrationJobQueue } from './integration-job.queue';
import type {
  IntegrationProviderActionDescriptor,
  IntegrationProviderAdapter,
  IntegrationSyncOptions,
} from './adapters/integration-adapter.interface';
import { IntegrationSyncDto } from './dto/integration-sync.dto';
import { UpdateIntegrationResourceDto } from './dto/update-integration-resource.dto';

type JsonRecord = Record<string, unknown>;

interface MetaAdAccount {
  id: string;
  name: string;
  accountStatus?: string;
  currency?: string;
}

interface NormalizedMetaAdsEvent {
  eventType: string;
  idempotencyKey: string;
  leadId: string;
  adId?: string;
  campaignId?: string;
  email?: string;
  phone?: string;
  message: string;
  raw: unknown;
}

export interface IntegrationSummary {
  accountName?: string;
  accountId?: string;
  accountStatus?: string;
  currency?: string;
  campaignCount?: number;
}

export interface IntegrationCatalogItem {
  id: IntegrationProviderKey;
  name: string;
  desc: string;
  icon: string;
  category: string;
  providerCategory: string;
  availability: string;
  connectMode: string;
  authType: string;
  capabilities: string[];
  plannedDomains: string[];
  connected: boolean;
  status: string;
  integrationId: string | null;
  routingChannelId: string | null;
  webhookPath: string | null;
  summary: IntegrationSummary | null;
  health: Prisma.JsonValue | null;
  lastSyncedAt: Date | null;
  lastWebhookAt: Date | null;
  actions: {
    connect: string;
    disconnect: boolean;
    refresh: boolean;
    sync: boolean;
    providerActions: IntegrationProviderActionDescriptor[];
    configure: boolean;
  };
}

export interface IntegrationCatalogResponse {
  integrations: IntegrationCatalogItem[];
}

export interface IntegrationLogListParams {
  limit?: number;
  cursor?: string;
}

export interface IntegrationResourceListParams {
  type?: string;
}

export interface EnqueueIntegrationJobParams {
  workspaceId: string;
  integrationId: string;
  resourceId?: string | null;
  type: string;
  input?: unknown;
  maxRetries?: number;
  scheduledAt?: Date;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private readonly eventReplayJobType = 'integration.event_replay';

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: IntegrationSecretService,
    private readonly events: EventEmitter2,
    private readonly processingQueue: MessageProcessingQueueService,
    private readonly integrationJobQueue: IntegrationJobQueue,
    private readonly adapterRegistry: IntegrationAdapterRegistry,
  ) {}

  async listCatalog(workspaceId: string): Promise<IntegrationCatalogResponse> {
    const integrations = await this.prisma.integration.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        provider: true,
        status: true,
        externalAccountId: true,
        externalAccountName: true,
        metadata: true,
        health: true,
        connectedAt: true,
        lastSyncedAt: true,
        lastWebhookAt: true,
      },
    });
    const legacyMetaAds = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'meta_ads' },
      select: { id: true, status: true, config: true },
    });

    const byProvider = new Map<string, (typeof integrations)[number]>();
    for (const integration of integrations) {
      if (!byProvider.has(integration.provider)) {
        byProvider.set(integration.provider, integration);
      }
    }

    return {
      integrations: INTEGRATION_PROVIDER_CATALOG.map((entry) => {
        const integration = byProvider.get(entry.id);
        const adapter = this.adapterRegistry.maybeGet(entry.id);
        const legacyConnected = entry.id === 'meta_ads' && !!legacyMetaAds;
        const connected = integration?.status === 'connected' || legacyConnected;
        const summary = integration
          ? adapter?.summarize?.(integration) ?? this.integrationSummary(integration)
          : legacyMetaAds
            ? adapter?.summarizeLegacy?.(legacyMetaAds) ?? this.legacyMetaAdsSummary(legacyMetaAds.config)
            : null;
        const integrationId = integration?.id ?? null;
        const webhookPath = connected
          ? adapter?.webhookPath?.(integration ?? null, legacyMetaAds ?? null) ?? null
          : null;
        const providerActions =
          connected && integration && adapter?.providerActions
            ? adapter.providerActions(integration)
            : [];

        return {
          id: entry.id,
          name: entry.name,
          desc: entry.desc,
          icon: entry.icon,
          category: entry.category,
          providerCategory: entry.providerCategory,
          availability: entry.availability,
          connectMode: entry.connectMode,
          authType: entry.authType,
          capabilities: entry.capabilities,
          plannedDomains: entry.plannedDomains,
          connected,
          status: integration?.status ?? (legacyConnected ? 'connected' : entry.availability),
          integrationId,
          routingChannelId: legacyMetaAds?.id ?? null,
          webhookPath,
          summary,
          health: integration?.health ?? null,
          lastSyncedAt: integration?.lastSyncedAt ?? null,
          lastWebhookAt: integration?.lastWebhookAt ?? null,
          actions: {
            connect: entry.connectMode,
            disconnect: connected,
            refresh: connected && entry.id === 'meta_ads',
            sync: connected && !!adapter?.buildSyncJob && !!integration,
            providerActions,
            configure: connected,
          },
        };
      }),
    };
  }

  buildMetaAdsOAuthUrl(workspaceId: string) {
    return this.buildProviderOAuthUrl('meta_ads', workspaceId);
  }

  buildProviderOAuthUrl(
    provider: string,
    workspaceId: string,
    query?: Record<string, string | undefined>,
  ) {
    const adapter = this.adapterRegistry.get(provider);
    if (!adapter.buildOAuthUrl) {
      throw new BadRequestException('Integration provider does not support OAuth');
    }
    return adapter.buildOAuthUrl({ workspaceId, query });
  }

  private buildLegacyMetaAdsOAuthUrl(workspaceId: string) {
    const redirectUri = process.env.META_ADS_REDIRECT_URI || process.env.META_REDIRECT_URI || '';
    const clientId = process.env.META_APP_ID || '';
    const state = encodeURIComponent(JSON.stringify({ workspaceId, provider: 'meta_ads' }));
    const scope = encodeURIComponent('ads_management,business_management');
    const url =
      `https://www.facebook.com/v19.0/dialog/oauth` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${scope}` +
      `&state=${state}`;

    return { url, redirectUri };
  }

  async connectMetaAdsOAuthCode(code: string, workspaceId: string, createdById?: string) {
    return this.connectProviderOAuth('meta_ads', { code, workspaceId, createdById });
  }

  async connectProviderOAuth(
    provider: string,
    params: {
      code: string;
      workspaceId: string;
      createdById?: string;
      query?: Record<string, string | undefined>;
    },
  ) {
    const adapter = this.adapterRegistry.get(provider);
    if (!adapter.connectOAuth) {
      throw new BadRequestException('Integration provider does not support OAuth exchange yet');
    }
    return adapter.connectOAuth(params);
  }

  private async connectLegacyMetaAdsOAuthCode(code: string, workspaceId: string, createdById?: string) {
    if (!code.trim()) {
      throw new BadRequestException('code is required');
    }

    const redirectUri = process.env.META_ADS_REDIRECT_URI || process.env.META_REDIRECT_URI;
    if (!redirectUri) {
      throw new BadRequestException('META_ADS_REDIRECT_URI or META_REDIRECT_URI is not configured');
    }

    const userToken = await this.exchangeMetaCode(code, redirectUri);
    const account = await this.fetchFirstMetaAdAccount(userToken);
    const campaignCount = await this.fetchMetaCampaignCount(userToken, account.id);

    const metadata: Prisma.InputJsonObject = {
      accountId: account.id,
      accountName: account.name,
      provider: 'meta_ads',
      ...(account.accountStatus ? { accountStatus: account.accountStatus } : {}),
      ...(account.currency ? { currency: account.currency } : {}),
      ...(campaignCount != null ? { campaignCount } : {}),
    };
    const health: Prisma.InputJsonObject = {
      state: 'ok',
      checkedAt: new Date().toISOString(),
    };
    const credentialsEncrypted = this.secrets.encryptJson({
      provider: 'meta_ads',
      accessToken: userToken,
    });

    const { integration, resource } = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.integration.findFirst({
        where: {
          workspaceId,
          provider: 'meta_ads',
          externalAccountId: account.id,
        },
      });

      const integrationRow = existing
        ? await tx.integration.update({
            where: { id: existing.id },
            data: {
              name: `Meta Ads - ${account.name}`,
              category: 'ads',
              status: 'connected',
              externalAccountName: account.name,
              authType: 'oauth',
              scopes: ['ads_management', 'business_management'],
              credentialsEncrypted,
              metadata,
              health,
              connectedAt: existing.connectedAt ?? new Date(),
              disconnectedAt: null,
              createdById: createdById ?? existing.createdById,
            },
          })
        : await tx.integration.create({
            data: {
              workspaceId,
              provider: 'meta_ads',
              category: 'ads',
              name: `Meta Ads - ${account.name}`,
              status: 'connected',
              externalAccountId: account.id,
              externalAccountName: account.name,
              authType: 'oauth',
              scopes: ['ads_management', 'business_management'],
              credentialsEncrypted,
              metadata,
              health,
              connectedAt: new Date(),
              createdById,
            },
          });

      const resourceRow = await tx.integrationResource.upsert({
        where: {
          integrationId_type_externalId: {
            integrationId: integrationRow.id,
            type: 'ad_account',
            externalId: account.id,
          },
        },
        update: {
          name: account.name,
          status: 'active',
          metadata,
        },
        create: {
          workspaceId,
          integrationId: integrationRow.id,
          type: 'ad_account',
          externalId: account.id,
          name: account.name,
          status: 'active',
          metadata,
        },
      });

      await tx.integration.update({
        where: { id: integrationRow.id },
        data: {
          settings: {
            primaryResourceId: resourceRow.id,
            primaryAdAccountId: account.id,
          },
        },
      });

      return { integration: integrationRow, resource: resourceRow };
    });

    return {
      integrationId: integration.id,
      resourceId: resource.id,
      provider: integration.provider,
      name: integration.name,
      summary: this.integrationSummary(integration),
      webhookPath: `/api/integrations/meta-ads/webhook/${integration.id}`,
    };
  }

  async getMetaAdsStatus(workspaceId: string) {
    const adapter = this.adapterRegistry.get('meta_ads');
    if (!adapter.refreshStatus) {
      throw new BadRequestException('Integration provider does not support status refresh');
    }
    return adapter.refreshStatus(workspaceId);
  }

  private async getLegacyMetaAdsStatusViaService(workspaceId: string) {
    const integration = await this.findProviderIntegration(workspaceId, 'meta_ads');
    if (!integration) {
      return this.getLegacyMetaAdsStatus(workspaceId);
    }

    const summary = this.integrationSummary(integration);
    const credentials = integration.credentialsEncrypted
      ? this.secrets.decryptJson(integration.credentialsEncrypted)
      : {};
    const accessToken = this.readString(credentials, 'accessToken');
    const accountId = summary?.accountId ?? integration.externalAccountId;

    if (accessToken && accountId) {
      const campaignCount = await this.fetchMetaCampaignCount(accessToken, accountId);
      if (campaignCount != null) {
        const nextMetadata: Prisma.InputJsonObject = {
          ...this.jsonInputObject(integration.metadata),
          campaignCount,
        };
        await this.prisma.integration.update({
          where: { id: integration.id },
          data: {
            metadata: nextMetadata,
            health: { state: 'ok', checkedAt: new Date().toISOString() },
          },
        });
        return {
          connected: true,
          integrationId: integration.id,
          name: integration.name,
          ...summary,
          campaignCount,
        };
      }
    }

    return {
      connected: true,
      integrationId: integration.id,
      name: integration.name,
      ...summary,
    };
  }

  async disconnectProvider(workspaceId: string, provider: string) {
    const knownProvider = INTEGRATION_PROVIDER_CATALOG.some((entry) => entry.id === provider);
    if (!knownProvider) {
      throw new NotFoundException('Unknown integration');
    }

    await this.prisma.integration.updateMany({
      where: { workspaceId, provider, status: { not: 'disconnected' } },
      data: {
        status: 'disconnected',
        disconnectedAt: new Date(),
        credentialsEncrypted: null,
        health: { state: 'disconnected', checkedAt: new Date().toISOString() },
      },
    });

    await this.adapterRegistry.maybeGet(provider)?.disconnect?.(workspaceId);

    return { disconnected: true };
  }

  async ingestMetaAdsWebhook(integrationOrLegacyChannelId: string | undefined, payload: unknown) {
    return this.ingestProviderWebhook('meta_ads', {
      integrationId: integrationOrLegacyChannelId,
      payload,
    });
  }

  async ingestProviderWebhook(
    provider: string,
    params: {
      integrationId?: string;
      payload: unknown;
      headers?: Record<string, string | string[] | undefined>;
      rawBody?: Buffer | string;
    },
  ) {
    const adapter = this.adapterRegistry.get(provider);
    if (!adapter.ingestWebhook) {
      throw new BadRequestException('Integration provider does not support webhooks yet');
    }
    return adapter.ingestWebhook(params);
  }

  async listIntegrationEvents(
    workspaceId: string,
    integrationId: string,
    params: IntegrationLogListParams = {},
  ) {
    await this.assertIntegrationInWorkspace(workspaceId, integrationId);
    const limit = this.logLimit(params.limit);
    const rows = await this.prisma.integrationEvent.findMany({
      where: { workspaceId, integrationId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      skip: params.cursor ? 1 : 0,
      cursor: params.cursor ? { id: params.cursor } : undefined,
      select: {
        id: true,
        resourceId: true,
        provider: true,
        eventType: true,
        externalEventId: true,
        status: true,
        occurredAt: true,
        processedAt: true,
        error: true,
        createdAt: true,
      },
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async listIntegrationJobs(
    workspaceId: string,
    integrationId: string,
    params: IntegrationLogListParams = {},
  ) {
    await this.assertIntegrationInWorkspace(workspaceId, integrationId);
    const limit = this.logLimit(params.limit);
    const rows = await this.prisma.integrationJob.findMany({
      where: { workspaceId, integrationId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      skip: params.cursor ? 1 : 0,
      cursor: params.cursor ? { id: params.cursor } : undefined,
      select: {
        id: true,
        resourceId: true,
        type: true,
        status: true,
        attempts: true,
        maxRetries: true,
        scheduledAt: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async listIntegrationResources(
    workspaceId: string,
    integrationId: string,
    params: IntegrationResourceListParams = {},
  ) {
    await this.assertIntegrationInWorkspace(workspaceId, integrationId);
    const rows = await this.prisma.integrationResource.findMany({
      where: {
        workspaceId,
        integrationId,
        ...(params.type ? { type: params.type } : {}),
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        type: true,
        externalId: true,
        name: true,
        status: true,
        settings: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return { items: rows };
  }

  async updateIntegrationResource(
    workspaceId: string,
    integrationId: string,
    resourceId: string,
    dto: UpdateIntegrationResourceDto,
  ) {
    const resource = await this.prisma.integrationResource.findFirst({
      where: { id: resourceId, workspaceId, integrationId },
      select: {
        id: true,
        workspaceId: true,
        integrationId: true,
        type: true,
        externalId: true,
        name: true,
        status: true,
        settings: true,
        metadata: true,
        integration: {
          select: {
            id: true,
            settings: true,
            metadata: true,
          },
        },
      },
    });

    if (!resource) {
      throw new NotFoundException('Integration resource not found');
    }

    const nextSettings = {
      ...this.asRecord(resource.settings),
      ...this.sanitizeResourceSettings(dto.settings),
    };
    const makePrimary = nextSettings.primary === true;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (makePrimary) {
        const siblings = await tx.integrationResource.findMany({
          where: {
            workspaceId,
            integrationId,
            type: resource.type,
            id: { not: resource.id },
          },
          select: { id: true, settings: true },
        });
        await Promise.all(
          siblings.map((sibling) =>
            tx.integrationResource.update({
              where: { id: sibling.id },
              data: {
                settings: this.toInputJson({
                  ...this.asRecord(sibling.settings),
                  primary: false,
                }),
              },
            }),
          ),
        );

        const integrationSettings = this.asRecord(resource.integration.settings);
        const integrationMetadata = this.asRecord(resource.integration.metadata);
        const metadataKey =
          resource.type === 'ad_account'
            ? {
                accountId: resource.externalId,
                accountName: resource.name,
              }
            : {};
        await tx.integration.update({
          where: { id: integrationId },
          data: {
            settings: this.toInputJson({
              ...integrationSettings,
              primaryResourceId: resource.id,
              primaryResourceType: resource.type,
              [`primary${this.resourceTypePascal(resource.type)}Id`]: resource.externalId,
            }),
            metadata: this.toInputJson({
              ...integrationMetadata,
              ...metadataKey,
            }),
          },
        });
      }

      return tx.integrationResource.update({
        where: { id: resource.id },
        data: {
          status: dto.status ?? resource.status,
          settings: this.toInputJson(nextSettings),
        },
        select: {
          id: true,
          type: true,
          externalId: true,
          name: true,
          status: true,
          settings: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    return { resource: updated };
  }

  async retryIntegrationJob(workspaceId: string, integrationId: string, jobId: string) {
    const job = await this.prisma.integrationJob.findFirst({
      where: { id: jobId, workspaceId, integrationId },
      include: {
        integration: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!job) {
      throw new NotFoundException('Integration job not found');
    }

    if (job.integration.status === 'disconnected') {
      throw new BadRequestException('Integration is disconnected');
    }

    if (!['failed', 'cancelled'].includes(job.status)) {
      throw new BadRequestException('Only failed or cancelled integration jobs can be retried');
    }

    const retryJob = await this.prisma.integrationJob.create({
      data: {
        workspaceId: job.workspaceId,
        integrationId: job.integrationId,
        resourceId: job.resourceId,
        type: job.type,
        status: 'pending',
        maxRetries: job.maxRetries,
        scheduledAt: new Date(),
        input: this.toInputJson(job.input ?? {}),
        output: this.toInputJson({
          retriedFromJobId: job.id,
        }),
      },
      select: {
        id: true,
        resourceId: true,
        type: true,
        status: true,
        attempts: true,
        maxRetries: true,
        scheduledAt: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.integrationJobQueue.add(retryJob.id, {
      attempts: retryJob.maxRetries,
    });

    return {
      retriedFromJobId: job.id,
      job: retryJob,
    };
  }

  async replayIntegrationEvent(workspaceId: string, integrationId: string, eventId: string) {
    const event = await this.prisma.integrationEvent.findFirst({
      where: { id: eventId, workspaceId, integrationId },
      select: {
        id: true,
        workspaceId: true,
        integrationId: true,
        resourceId: true,
        eventType: true,
        status: true,
        integration: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Integration event not found');
    }

    if (event.integration.status === 'disconnected') {
      throw new BadRequestException('Integration is disconnected');
    }

    const job = await this.prisma.integrationJob.create({
      data: {
        workspaceId: event.workspaceId,
        integrationId: event.integrationId,
        resourceId: event.resourceId,
        type: this.eventReplayJobType,
        status: 'pending',
        maxRetries: 3,
        scheduledAt: new Date(),
        input: this.toInputJson({
          integrationEventId: event.id,
          eventType: event.eventType,
          requestedAt: new Date().toISOString(),
        }),
      },
      select: {
        id: true,
        resourceId: true,
        type: true,
        status: true,
        attempts: true,
        maxRetries: true,
        scheduledAt: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.integrationJobQueue.add(job.id, {
      attempts: job.maxRetries,
    });

    return {
      replayedEventId: event.id,
      job,
    };
  }

  async syncIntegration(
    workspaceId: string,
    integrationId: string,
    options: IntegrationSyncDto = {},
  ) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, workspaceId },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        status: true,
        externalAccountId: true,
        externalAccountName: true,
        metadata: true,
        health: true,
        settings: true,
        lastSyncedAt: true,
        lastWebhookAt: true,
        credentialsEncrypted: true,
      },
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    if (integration.status === 'disconnected') {
      throw new BadRequestException('Integration is disconnected');
    }

    const adapter = this.adapterRegistry.get(integration.provider);
    if (!adapter.buildSyncJob) {
      throw new BadRequestException('Integration provider does not support manual sync yet');
    }

    const syncOptions = this.normalizeSyncOptions(options);
    const definition = await adapter.buildSyncJob(integration, syncOptions);
    if (!definition) {
      throw new BadRequestException('Integration provider does not support manual sync yet');
    }

    const existing = await this.prisma.integrationJob.findFirst({
      where: {
        workspaceId,
        integrationId,
        type: definition.type,
        status: { in: ['pending', 'processing'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        resourceId: true,
        type: true,
        status: true,
        attempts: true,
        maxRetries: true,
        scheduledAt: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (existing) {
      return {
        alreadyQueued: true,
        job: existing,
      };
    }

    const scheduledAt = definition.scheduledAt ?? new Date();
    const maxRetries = Math.max(1, Math.min(10, definition.maxRetries ?? 3));
    const input = {
      ...this.asRecord(definition.input),
      source: syncOptions.mode === 'backfill' ? 'manual_backfill' : 'manual_sync',
      mode: syncOptions.mode ?? 'manual_sync',
      ...(syncOptions.resources?.length ? { resources: syncOptions.resources } : {}),
      ...(syncOptions.since ? { since: syncOptions.since } : {}),
      ...(syncOptions.until ? { until: syncOptions.until } : {}),
      requestedAt: new Date().toISOString(),
    };
    const job = await this.prisma.integrationJob.create({
      data: {
        workspaceId,
        integrationId,
        resourceId: definition.resourceId ?? null,
        type: definition.type,
        status: 'pending',
        maxRetries,
        scheduledAt,
        input: this.toInputJson(input),
      },
      select: {
        id: true,
        resourceId: true,
        type: true,
        status: true,
        attempts: true,
        maxRetries: true,
        scheduledAt: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.integrationJobQueue.add(job.id, {
      attempts: job.maxRetries,
      delay: this.queueDelayFromDate(job.scheduledAt),
    });

    return {
      alreadyQueued: false,
      job,
    };
  }

  async runIntegrationAction(workspaceId: string, integrationId: string, action: string) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, workspaceId },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        status: true,
        externalAccountId: true,
        externalAccountName: true,
        metadata: true,
        health: true,
        settings: true,
        lastSyncedAt: true,
        lastWebhookAt: true,
        credentialsEncrypted: true,
      },
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    if (integration.status === 'disconnected') {
      throw new BadRequestException('Integration is disconnected');
    }

    const adapter = this.adapterRegistry.get(integration.provider);
    const supportedActions = adapter.providerActions?.(integration) ?? [];
    const descriptor = supportedActions.find((item) => item.key === action);
    if (supportedActions.length > 0 && !descriptor) {
      throw new BadRequestException('Integration provider action is not supported');
    }

    if ((descriptor?.mode === 'immediate' || !descriptor) && adapter.runAction) {
      const result = await adapter.runAction({ integration, action });
      return {
        mode: 'immediate',
        action,
        result,
      };
    }

    if (adapter.buildActionJob) {
      const definition = await adapter.buildActionJob({ integration, action });
      if (definition) {
        const existing = await this.prisma.integrationJob.findFirst({
          where: {
            workspaceId,
            integrationId,
            type: definition.type,
            status: { in: ['pending', 'processing'] },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            resourceId: true,
            type: true,
            status: true,
            attempts: true,
            maxRetries: true,
            scheduledAt: true,
            startedAt: true,
            completedAt: true,
            lastError: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        if (existing) {
          return {
            mode: 'job',
            action,
            alreadyQueued: true,
            job: existing,
          };
        }

        const scheduledAt = definition.scheduledAt ?? new Date();
        const maxRetries = Math.max(1, Math.min(10, definition.maxRetries ?? 3));
        const job = await this.prisma.integrationJob.create({
          data: {
            workspaceId,
            integrationId,
            resourceId: definition.resourceId ?? null,
            type: definition.type,
            status: 'pending',
            maxRetries,
            scheduledAt,
            input: this.toInputJson({
              ...this.asRecord(definition.input),
              source: 'provider_action',
              action,
              requestedAt: new Date().toISOString(),
            }),
          },
          select: {
            id: true,
            resourceId: true,
            type: true,
            status: true,
            attempts: true,
            maxRetries: true,
            scheduledAt: true,
            startedAt: true,
            completedAt: true,
            lastError: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        await this.integrationJobQueue.add(job.id, {
          attempts: job.maxRetries,
          delay: this.queueDelayFromDate(job.scheduledAt),
        });

        return {
          mode: 'job',
          action,
          alreadyQueued: false,
          job,
        };
      }
    }

    throw new BadRequestException('Integration provider action is not supported');
  }

  async enqueueIntegrationJob(params: EnqueueIntegrationJobParams) {
    const integration = await this.prisma.integration.findFirst({
      where: {
        id: params.integrationId,
        workspaceId: params.workspaceId,
        status: { not: 'disconnected' },
      },
      select: { id: true },
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    const scheduledAt = params.scheduledAt ?? new Date();
    const maxRetries = Math.max(1, Math.min(10, params.maxRetries ?? 3));
    const job = await this.prisma.integrationJob.create({
      data: {
        workspaceId: params.workspaceId,
        integrationId: params.integrationId,
        resourceId: params.resourceId ?? null,
        type: params.type,
        status: 'pending',
        maxRetries,
        scheduledAt,
        input: this.toInputJson(params.input ?? {}),
      },
    });

    await this.integrationJobQueue.add(job.id, {
      attempts: job.maxRetries,
      delay: this.queueDelayFromDate(job.scheduledAt),
    });

    return job;
  }

  async processIntegrationJob(jobId: string) {
    const job = await this.prisma.integrationJob.findUnique({
      where: { id: jobId },
      include: {
        integration: {
          select: {
            id: true,
            workspaceId: true,
            provider: true,
            status: true,
            externalAccountId: true,
            externalAccountName: true,
            metadata: true,
            health: true,
            settings: true,
            lastSyncedAt: true,
            lastWebhookAt: true,
            credentialsEncrypted: true,
          },
        },
      },
    });

    if (!job) {
      throw new NotFoundException('Integration job not found');
    }

    if (job.status === 'completed' || job.status === 'cancelled') {
      return { status: job.status };
    }

    if (job.integration.status === 'disconnected') {
      const message = 'Integration is disconnected';
      await this.prisma.integrationJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          lastError: message,
          completedAt: new Date(),
        },
      });
      throw new BadRequestException(message);
    }

    const adapter = this.adapterRegistry.get(job.integration.provider);

    const attemptNumber = job.attempts + 1;
    await this.prisma.integrationJob.update({
      where: { id: job.id },
      data: {
        status: 'processing',
        attempts: attemptNumber,
        startedAt: new Date(),
        lastError: null,
      },
    });

    try {
      const output =
        job.type === this.eventReplayJobType
          ? await this.processIntegrationEventReplayJob(job, adapter)
          : await this.processProviderIntegrationJob(job, adapter, attemptNumber);

      await this.prisma.integrationJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          lastError: null,
          output: this.toInputJson(output),
        },
      });

      return { status: 'completed', output };
    } catch (error) {
      const message = this.errorMessage(error);
      const exhausted = attemptNumber >= Math.max(1, job.maxRetries);
      await this.prisma.integrationJob.update({
        where: { id: job.id },
        data: {
          status: exhausted ? 'failed' : 'pending',
          lastError: message,
          scheduledAt: exhausted
            ? job.scheduledAt
            : new Date(Date.now() + this.integrationJobRetryDelayMs(attemptNumber)),
          completedAt: exhausted ? new Date() : null,
        },
      });
      throw error;
    }
  }

  private async processProviderIntegrationJob(
    job: {
      id: string;
      workspaceId: string;
      integrationId: string;
      resourceId: string | null;
      type: string;
      attempts: number;
      maxRetries: number;
      input: Prisma.JsonValue | null;
      integration: Parameters<NonNullable<IntegrationProviderAdapter['processJob']>>[0]['integration'];
    },
    adapter: IntegrationProviderAdapter,
    attemptNumber: number,
  ) {
    if (!adapter.processJob) {
      throw new BadRequestException('Integration provider does not support jobs yet');
    }

    return adapter.processJob({
      job: {
        id: job.id,
        workspaceId: job.workspaceId,
        integrationId: job.integrationId,
        resourceId: job.resourceId,
        type: job.type,
        attempts: attemptNumber,
        maxRetries: job.maxRetries,
        input: job.input,
      },
      integration: job.integration,
    });
  }

  private async processIntegrationEventReplayJob(
    job: {
      id: string;
      workspaceId: string;
      integrationId: string;
      input: Prisma.JsonValue | null;
      integration: Parameters<NonNullable<IntegrationProviderAdapter['replayEvent']>>[0]['integration'];
    },
    adapter: IntegrationProviderAdapter,
  ) {
    if (!adapter.replayEvent) {
      throw new BadRequestException('Integration provider does not support event replay yet');
    }

    const input = this.asRecord(job.input);
    const integrationEventId = this.readString(input, 'integrationEventId');
    if (!integrationEventId) {
      throw new BadRequestException('Integration replay job is missing integrationEventId');
    }

    const event = await this.prisma.integrationEvent.findFirst({
      where: {
        id: integrationEventId,
        workspaceId: job.workspaceId,
        integrationId: job.integrationId,
      },
      select: {
        id: true,
        workspaceId: true,
        integrationId: true,
        resourceId: true,
        provider: true,
        eventType: true,
        externalEventId: true,
        idempotencyKey: true,
        occurredAt: true,
        payload: true,
      },
    });

    if (!event) {
      throw new NotFoundException('Integration event not found');
    }

    try {
      const output = await adapter.replayEvent({
        integration: job.integration,
        event,
      });

      await this.prisma.integrationEvent.update({
        where: { id: event.id },
        data: {
          status: 'replayed',
          processedAt: new Date(),
          error: null,
        },
      });

      return {
        status: 'ok',
        replayedEventId: event.id,
        ...output,
      };
    } catch (error) {
      await this.prisma.integrationEvent.update({
        where: { id: event.id },
        data: {
          status: 'failed',
          error: this.errorMessage(error),
        },
      });
      throw error;
    }
  }

  private async ingestLegacyMetaAdsWebhook(integrationOrLegacyChannelId: string | undefined, payload: unknown) {
    if (!integrationOrLegacyChannelId) {
      return { status: 'integration_id_required' };
    }

    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationOrLegacyChannelId },
    });

    if (!integration) {
      return this.ingestLegacyMetaAdsChannelWebhook(integrationOrLegacyChannelId, payload);
    }

    if (integration.provider !== 'meta_ads' || integration.status !== 'connected') {
      return { status: 'integration_not_connected' };
    }

    const event = this.normalizeMetaAdsEvent(integration.id, payload);
    const integrationEvent = await this.createIntegrationEvent(integration, event);

    await this.prisma.integration.update({
      where: { id: integration.id },
      data: { lastWebhookAt: new Date() },
    });

    await this.emitMetaAdsWorkflowEvent(integration, event);

    this.events.emit('integration.event.received', {
      workspaceId: integration.workspaceId,
      integrationId: integration.id,
      provider: integration.provider,
      eventType: event.eventType,
      integrationEventId: integrationEvent.id,
    });

    return { status: 'ok', eventId: integrationEvent.id };
  }

  private async exchangeMetaCode(code: string, redirectUri: string) {
    const q = new URLSearchParams({
      client_id: process.env.META_APP_ID || '',
      redirect_uri: redirectUri,
      client_secret: process.env.META_APP_SECRET || '',
      code,
    });
    const data = await this.fetchJson(
      `https://graph.facebook.com/v19.0/oauth/access_token?${q.toString()}`,
    );
    const token = this.readString(data, 'access_token');
    if (!token) {
      throw new BadRequestException(this.providerErrorMessage(data, 'Meta OAuth failed'));
    }
    return token;
  }

  private async fetchFirstMetaAdAccount(accessToken: string): Promise<MetaAdAccount> {
    const q = new URLSearchParams({
      fields: 'id,name,account_id,account_status,currency',
      access_token: accessToken,
    });
    const data = await this.fetchJson(
      `https://graph.facebook.com/v19.0/me/adaccounts?${q.toString()}`,
    );
    const rows = this.readArray(data, 'data');
    const account = rows.find((row): row is JsonRecord => this.isRecord(row));
    const id = account ? this.readString(account, 'id') : null;
    const name = account ? this.readString(account, 'name') : null;

    if (!id || !name) {
      throw new BadRequestException(
        'No ad accounts found. Ensure this Facebook user has access to an ad account.',
      );
    }

    return {
      id,
      name,
      accountStatus: this.readString(account, 'account_status') ?? undefined,
      currency: this.readString(account, 'currency') ?? undefined,
    };
  }

  private async fetchMetaCampaignCount(accessToken: string, accountId: string) {
    try {
      const q = new URLSearchParams({
        fields: 'id',
        limit: '1',
        summary: 'true',
        access_token: accessToken,
      });
      const data = await this.fetchJson(
        `https://graph.facebook.com/v19.0/${accountId}/campaigns?${q.toString()}`,
      );
      const summary = this.readRecord(data, 'summary');
      return summary ? this.readNumber(summary, 'total_count') : undefined;
    } catch (error) {
      this.logger.warn(`Meta campaign count refresh failed: ${this.errorMessage(error)}`);
      return undefined;
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url);
    const data: unknown = await response.json();
    if (!response.ok) {
      throw new BadRequestException(this.providerErrorMessage(data, 'Provider request failed'));
    }
    return data;
  }

  private async findProviderIntegration(workspaceId: string, provider: string): Promise<Integration | null> {
    return this.prisma.integration.findFirst({
      where: {
        workspaceId,
        provider,
        status: { not: 'disconnected' },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async assertIntegrationInWorkspace(workspaceId: string, integrationId: string) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, workspaceId },
      select: { id: true },
    });
    if (!integration) {
      throw new NotFoundException('Integration not found');
    }
  }

  private logLimit(value?: number) {
    if (!value || !Number.isFinite(value)) return 25;
    return Math.max(1, Math.min(100, Math.trunc(value)));
  }

  private queueDelayFromDate(value: Date) {
    return Math.max(0, value.getTime() - Date.now());
  }

  private integrationJobRetryDelayMs(attempt: number) {
    return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  }

  private normalizeSyncOptions(dto: IntegrationSyncDto): IntegrationSyncOptions {
    const resources = Array.isArray(dto.resources)
      ? [...new Set(dto.resources.map((resource) => resource.trim()).filter(Boolean))]
      : undefined;
    const since = this.normalizeIsoDate(dto.since, 'since');
    const until = this.normalizeIsoDate(dto.until, 'until');
    if (since && until && new Date(since).getTime() > new Date(until).getTime()) {
      throw new BadRequestException('since must be before until');
    }
    return {
      mode: dto.mode ?? (resources?.length || since || until ? 'backfill' : 'manual_sync'),
      ...(resources?.length ? { resources } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
    };
  }

  private normalizeIsoDate(value: string | undefined, label: string) {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${label} must be a valid ISO date`);
    }
    return parsed.toISOString();
  }

  private sanitizeResourceSettings(settings?: Record<string, unknown>) {
    if (!settings) return {};
    return JSON.parse(JSON.stringify(settings)) as JsonRecord;
  }

  private resourceTypePascal(type: string) {
    return type
      .split('_')
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join('');
  }

  private async getLegacyMetaAdsStatus(workspaceId: string) {
    const row = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'meta_ads' },
    });
    if (!row) {
      return { connected: false };
    }
    const cfg = this.asRecord(row.config);
    return {
      connected: true,
      channelId: row.id,
      name: row.name,
      accountName: this.readString(cfg, 'accountName') ?? undefined,
      accountId: this.readString(cfg, 'accountId') ?? undefined,
      accountStatus: this.readString(cfg, 'accountStatus') ?? undefined,
      currency: this.readString(cfg, 'currency') ?? undefined,
      campaignCount: this.readNumber(cfg, 'campaignCount') ?? undefined,
    };
  }

  private async ingestLegacyMetaAdsChannelWebhook(channelId: string, payload: unknown) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.type !== 'meta_ads') {
      return { status: 'integration_not_found' };
    }

    const event = this.normalizeMetaAdsEvent(channel.id, payload);
    const identifier = event.phone ?? event.email ?? event.leadId;

    await this.processingQueue.enqueueInboundProcess({
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      channelType: 'meta_ads',
      contactIdentifier: identifier,
      direction: 'incoming',
      messageType: 'lead_event',
      text: event.message,
      attachments: [],
      metadata: {
        provider: 'meta_ads',
        leadId: event.leadId,
        adId: event.adId,
        campaignId: event.campaignId,
        eventName: event.eventType,
      },
      raw: payload,
    });

    return { status: 'ok', legacyChannelId: channel.id };
  }

  private async createIntegrationEvent(integration: Integration, event: NormalizedMetaAdsEvent) {
    try {
      return await this.prisma.integrationEvent.create({
        data: {
          workspaceId: integration.workspaceId,
          integrationId: integration.id,
          provider: integration.provider,
          eventType: event.eventType,
          externalEventId: event.leadId,
          idempotencyKey: event.idempotencyKey,
          payload: this.toInputJson(event.raw),
          status: 'received',
          occurredAt: new Date(),
        },
      });
    } catch (error) {
      if (this.isPrismaUniqueError(error)) {
        const existing = await this.prisma.integrationEvent.findUnique({
          where: {
            integrationId_idempotencyKey: {
              integrationId: integration.id,
              idempotencyKey: event.idempotencyKey,
            },
          },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  private async emitMetaAdsWorkflowEvent(integration: Integration, event: NormalizedMetaAdsEvent) {
    const filters: Prisma.ContactIntegrationWhereInput[] = [{ externalId: event.leadId }];
    if (event.email) filters.push({ email: event.email });
    if (event.phone) filters.push({ phone: event.phone });

    const identity = await this.prisma.contactIntegration.findFirst({
      where: {
        workspaceId: integration.workspaceId,
        integrationId: integration.id,
        OR: filters,
      },
      select: { contactId: true },
    });

    if (!identity?.contactId) return;

    this.events.emit('meta_ads.click', {
      workspaceId: integration.workspaceId,
      contactId: identity.contactId,
      conversationId: null,
      triggerData: {
        leadId: event.leadId,
        adId: event.adId,
        campaignId: event.campaignId,
        identifier: event.phone ?? event.email ?? event.leadId,
        raw: event.raw,
      },
    });
  }

  private normalizeMetaAdsEvent(seed: string, payload: unknown): NormalizedMetaAdsEvent {
    const root = this.asRecord(payload);
    const changeValue = this.firstMetaChangeValue(root);
    const source = changeValue ?? root;
    const leadId =
      this.readString(source, 'leadgen_id') ??
      this.readString(source, 'leadId') ??
      this.readString(source, 'id') ??
      `lead-${Date.now()}`;
    const adId = this.readString(source, 'ad_id') ?? this.readString(source, 'adId') ?? undefined;
    const campaignId =
      this.readString(source, 'campaign_id') ?? this.readString(source, 'campaignId') ?? undefined;
    const eventType =
      this.readString(source, 'event_name') ??
      this.readString(source, 'eventName') ??
      'ads.lead_created';
    const email =
      this.readString(source, 'email') ??
      this.readString(source, 'customer_email') ??
      this.readString(root, 'email') ??
      undefined;
    const phone =
      this.readString(source, 'phone') ??
      this.readString(source, 'customer_phone') ??
      this.readString(root, 'phone') ??
      undefined;
    const message =
      this.readString(source, 'message') ??
      this.readString(root, 'message') ??
      'Meta ad lead event';

    return {
      eventType,
      idempotencyKey: this.hash(`${seed}:${leadId}:${adId ?? ''}:${campaignId ?? ''}:${eventType}`),
      leadId,
      adId,
      campaignId,
      email,
      phone,
      message,
      raw: payload,
    };
  }

  private firstMetaChangeValue(root: JsonRecord): JsonRecord | null {
    const entries = this.readArray(root, 'entry');
    for (const entry of entries) {
      if (!this.isRecord(entry)) continue;
      const changes = this.readArray(entry, 'changes');
      for (const change of changes) {
        if (!this.isRecord(change)) continue;
        const value = this.readRecord(change, 'value');
        if (value) return value;
      }
    }
    return null;
  }

  private integrationSummary(integration: {
    externalAccountId?: string | null;
    externalAccountName?: string | null;
    metadata?: Prisma.JsonValue | null;
  }): IntegrationSummary {
    const metadata = this.asRecord(integration.metadata);
    return {
      accountName:
        integration.externalAccountName ?? this.readString(metadata, 'accountName') ?? undefined,
      accountId: integration.externalAccountId ?? this.readString(metadata, 'accountId') ?? undefined,
      accountStatus: this.readString(metadata, 'accountStatus') ?? undefined,
      currency: this.readString(metadata, 'currency') ?? undefined,
      campaignCount: this.readNumber(metadata, 'campaignCount') ?? undefined,
    };
  }

  private legacyMetaAdsSummary(config: Prisma.JsonValue | null): IntegrationSummary {
    const cfg = this.asRecord(config);
    return {
      accountName: this.readString(cfg, 'accountName') ?? undefined,
      accountId: this.readString(cfg, 'accountId') ?? undefined,
      accountStatus: this.readString(cfg, 'accountStatus') ?? undefined,
      currency: this.readString(cfg, 'currency') ?? undefined,
      campaignCount: this.readNumber(cfg, 'campaignCount') ?? undefined,
    };
  }

  private asRecord(value: unknown): JsonRecord {
    return this.isRecord(value) ? value : {};
  }

  private isRecord(value: unknown): value is JsonRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private readRecord(record: JsonRecord | unknown, key: string): JsonRecord | null {
    if (!this.isRecord(record)) return null;
    const value = record[key];
    return this.isRecord(value) ? value : null;
  }

  private readArray(record: JsonRecord | unknown, key: string): unknown[] {
    if (!this.isRecord(record)) return [];
    const value = record[key];
    return Array.isArray(value) ? value : [];
  }

  private readString(record: JsonRecord | unknown, key: string): string | null {
    if (!this.isRecord(record)) return null;
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
  }

  private readNumber(record: JsonRecord | unknown, key: string): number | undefined {
    if (!this.isRecord(record)) return undefined;
    const value = record[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private jsonInputObject(value: unknown): Prisma.InputJsonObject {
    return this.isRecord(value)
      ? (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject)
      : {};
  }

  private toInputJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private providerErrorMessage(value: unknown, fallback: string) {
    const error = this.readRecord(value, 'error');
    return this.readString(error, 'message') ?? this.readString(value, 'message') ?? fallback;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private isPrismaUniqueError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
