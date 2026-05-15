import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Integration, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { MessageProcessingQueueService } from '../../outbound/message-processing-queue.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { IntegrationSecretService } from '../integration-secret.service';
import {
  ConnectedIntegrationSnapshot,
  IntegrationEventReplayParams,
  IntegrationJsonRecord,
  IntegrationOAuthExchangeParams,
  IntegrationOAuthUrlParams,
  IntegrationProviderAdapter,
  IntegrationProviderActionDescriptor,
  IntegrationProviderActionParams,
  IntegrationProviderActionResult,
  IntegrationSummary,
  IntegrationWebhookParams,
  LegacyIntegrationSnapshot,
} from '../adapters/integration-adapter.interface';

interface MetaAdAccount {
  id: string;
  name: string;
  accountStatus?: string;
  currency?: string;
}

interface MetaPage {
  id: string;
  name: string;
  category?: string;
  accessToken?: string;
  tasks?: unknown[];
}

interface MetaLeadForm {
  id: string;
  name: string;
  status?: string;
  createdTime?: string;
  pageId: string;
  pageName: string;
}

interface MetaSourceRefreshResult {
  adAccounts: number;
  pages: number;
  leadForms: number;
  warnings: string[];
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

@Injectable()
export class MetaAdsIntegrationAdapter implements IntegrationProviderAdapter {
  readonly provider = 'meta_ads' as const;
  private readonly logger = new Logger(MetaAdsIntegrationAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: IntegrationSecretService,
    private readonly events: EventEmitter2,
    private readonly processingQueue: MessageProcessingQueueService,
  ) {}

  buildOAuthUrl(params: IntegrationOAuthUrlParams) {
    const redirectUri = this.oauthRedirectUri();
    const clientId = process.env.META_APP_ID || '';
    if (!clientId) {
      throw new BadRequestException('META_APP_ID must be configured');
    }

    const state = encodeURIComponent(
      JSON.stringify({ workspaceId: params.workspaceId, provider: this.provider }),
    );
    const scope = encodeURIComponent(
      'ads_management,business_management,pages_show_list,pages_read_engagement',
    );
    const url =
      `https://www.facebook.com/v19.0/dialog/oauth` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${scope}` +
      `&state=${state}`;

    return { url, redirectUri };
  }

  async connectOAuth(params: IntegrationOAuthExchangeParams) {
    const code = params.code.trim();
    if (!code) {
      throw new BadRequestException('code is required');
    }

    const redirectUri = this.oauthRedirectUri();
    const userToken = await this.exchangeCode(code, redirectUri);
    const account = await this.fetchFirstAdAccount(userToken);
    const campaignCount = await this.fetchCampaignCount(userToken, account.id);

    const metadata: Prisma.InputJsonObject = {
      accountId: account.id,
      accountName: account.name,
      provider: this.provider,
      ...(account.accountStatus ? { accountStatus: account.accountStatus } : {}),
      ...(account.currency ? { currency: account.currency } : {}),
      ...(campaignCount != null ? { campaignCount } : {}),
    };
    const health: Prisma.InputJsonObject = {
      state: 'ok',
      checkedAt: new Date().toISOString(),
    };
    const credentialsEncrypted = this.secrets.encryptJson({
      provider: this.provider,
      accessToken: userToken,
    });

    const { integration, resource } = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.integration.findFirst({
        where: {
          workspaceId: params.workspaceId,
          provider: this.provider,
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
              scopes: [
                'ads_management',
                'business_management',
                // 'leads_retrieval',
                'pages_show_list',
                'pages_read_engagement',
              ],
              credentialsEncrypted,
              metadata,
              health,
              connectedAt: existing.connectedAt ?? new Date(),
              disconnectedAt: null,
              createdById: params.createdById ?? existing.createdById,
            },
          })
        : await tx.integration.create({
            data: {
              workspaceId: params.workspaceId,
              provider: this.provider,
              category: 'ads',
              name: `Meta Ads - ${account.name}`,
              status: 'connected',
              externalAccountId: account.id,
              externalAccountName: account.name,
              authType: 'oauth',
              scopes: [
                'ads_management',
                'business_management',
                // 'leads_retrieval',
                'pages_show_list',
                'pages_read_engagement',
              ],
              credentialsEncrypted,
              metadata,
              health,
              connectedAt: new Date(),
              createdById: params.createdById,
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
          settings: {
            primary: true,
            sourceLabel: account.name,
          },
          metadata,
        },
        create: {
          workspaceId: params.workspaceId,
          integrationId: integrationRow.id,
          type: 'ad_account',
          externalId: account.id,
          name: account.name,
          status: 'active',
          settings: {
            primary: true,
            sourceLabel: account.name,
          },
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

    try {
      await this.refreshSourceResources({
        workspaceId: params.workspaceId,
        integrationId: integration.id,
        accessToken: userToken,
        preferredAdAccountId: account.id,
      });
    } catch (error) {
      this.logger.warn(`Meta Ads source discovery failed after OAuth: ${this.errorMessage(error)}`);
      await this.prisma.integration.update({
        where: { id: integration.id },
        data: {
          health: {
            state: 'warning',
            checkedAt: new Date().toISOString(),
            sourceRefresh: {
              status: 'failed',
              error: this.errorMessage(error),
            },
          },
        },
      });
    }

    return {
      integrationId: integration.id,
      resourceId: resource.id,
      provider: integration.provider,
      name: integration.name,
      summary: this.summarize(integration),
      webhookPath: `/api/integrations/meta-ads/webhook/${integration.id}`,
    };
  }

  async refreshStatus(workspaceId: string) {
    const integration = await this.prisma.integration.findFirst({
      where: {
        workspaceId,
        provider: this.provider,
        status: { not: 'disconnected' },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!integration) {
      return this.getLegacyStatus(workspaceId);
    }

    const summary = this.summarize(integration) ?? {};
    const credentials = integration.credentialsEncrypted
      ? this.secrets.decryptJson(integration.credentialsEncrypted)
      : {};
    const accessToken = this.readString(credentials, 'accessToken');
    const accountId = summary.accountId ?? integration.externalAccountId;

    if (accessToken && accountId) {
      const campaignCount = await this.fetchCampaignCount(accessToken, accountId);
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

  async disconnect(workspaceId: string) {
    await this.prisma.channel.deleteMany({
      where: { workspaceId, type: this.provider },
    });
  }

  async ingestWebhook(params: IntegrationWebhookParams) {
    if (!params.integrationId) {
      return { status: 'integration_id_required' };
    }

    const integration = await this.prisma.integration.findUnique({
      where: { id: params.integrationId },
    });

    if (!integration) {
      return this.ingestLegacyChannelWebhook(params.integrationId, params.payload);
    }

    if (integration.provider !== this.provider || integration.status !== 'connected') {
      return { status: 'integration_not_connected' };
    }

    const event = this.normalizeEvent(integration.id, params.payload);
    const integrationEvent = await this.createIntegrationEvent(integration, event);

    await this.prisma.integration.update({
      where: { id: integration.id },
      data: { lastWebhookAt: new Date() },
    });

    await this.emitWorkflowEvent(integration, event);

    this.events.emit('integration.event.received', {
      workspaceId: integration.workspaceId,
      integrationId: integration.id,
      provider: integration.provider,
      eventType: event.eventType,
      integrationEventId: integrationEvent.id,
    });

    return { status: 'ok', eventId: integrationEvent.id };
  }

  async replayEvent(params: IntegrationEventReplayParams) {
    const workspaceId = params.integration.workspaceId ?? params.event.workspaceId;
    const integration = {
      id: params.integration.id,
      workspaceId,
      provider: params.integration.provider,
    };
    const event = this.normalizeEvent(params.integration.id, params.event.payload ?? {});

    await this.emitWorkflowEvent(integration, event);

    this.events.emit('integration.event.received', {
      workspaceId,
      integrationId: params.integration.id,
      provider: params.integration.provider,
      eventType: event.eventType,
      integrationEventId: params.event.id,
      replayed: true,
    });

    return {
      provider: this.provider,
      mode: 'event_replay',
      eventType: event.eventType,
    };
  }

  summarize(integration: ConnectedIntegrationSnapshot): IntegrationSummary | null {
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

  summarizeLegacy(legacy: LegacyIntegrationSnapshot): IntegrationSummary | null {
    const cfg = this.asRecord(legacy.config);
    return {
      accountName: this.readString(cfg, 'accountName') ?? undefined,
      accountId: this.readString(cfg, 'accountId') ?? undefined,
      accountStatus: this.readString(cfg, 'accountStatus') ?? undefined,
      currency: this.readString(cfg, 'currency') ?? undefined,
      campaignCount: this.readNumber(cfg, 'campaignCount') ?? undefined,
    };
  }

  providerActions(): IntegrationProviderActionDescriptor[] {
    return [
      {
        key: 'test_connection',
        label: 'Test connection',
        description: 'Check the saved Meta token and campaign access.',
        mode: 'immediate',
      },
      {
        key: 'refresh_sources',
        label: 'Refresh ad sources',
        description: 'Discover ad accounts, pages, and lead forms for source mapping.',
        mode: 'immediate',
      },
    ];
  }

  async runAction(params: IntegrationProviderActionParams): Promise<IntegrationProviderActionResult> {
    if (params.action === 'test_connection') {
      const accessToken = this.readMetaAccessToken(params.integration);
      const accountId =
        this.readString(this.asRecord(params.integration.metadata), 'accountId') ??
        params.integration.externalAccountId;
      const accounts = await this.fetchAdAccounts(accessToken);
      const selectedAccount =
        accounts.find((account) => account.id === accountId) ?? accounts[0];
      const campaignCount = selectedAccount
        ? await this.fetchCampaignCount(accessToken, selectedAccount.id)
        : undefined;

      await this.prisma.integration.update({
        where: { id: params.integration.id },
        data: {
          metadata: {
            ...this.asRecord(params.integration.metadata),
            ...(selectedAccount
              ? {
                  accountId: selectedAccount.id,
                  accountName: selectedAccount.name,
                  accountStatus: selectedAccount.accountStatus,
                  currency: selectedAccount.currency,
                }
              : {}),
            ...(campaignCount != null ? { campaignCount } : {}),
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
        message: 'Meta Ads connection is healthy.',
        details: {
          adAccounts: accounts.length,
          accountId: selectedAccount?.id,
          campaignCount,
        },
      };
    }

    if (params.action === 'refresh_sources') {
      const accessToken = this.readMetaAccessToken(params.integration);
      const preferredAdAccountId =
        this.readString(this.asRecord(params.integration.metadata), 'accountId') ??
        params.integration.externalAccountId ??
        undefined;
      const result = await this.refreshSourceResources({
        workspaceId: params.integration.workspaceId ?? '',
        integrationId: params.integration.id,
        accessToken,
        preferredAdAccountId,
      });
      const state = result.warnings.length ? 'warning' : 'ok';

      await this.prisma.integration.update({
        where: { id: params.integration.id },
        data: {
          health: {
            ...this.asRecord(params.integration.health),
            state,
            checkedAt: new Date().toISOString(),
            lastAction: 'refresh_sources',
            sourceRefresh: {
              status: 'completed',
              ...result,
            },
          },
        },
      });

      return {
        status: state,
        action: params.action,
        message: result.warnings.length
          ? 'Meta Ads sources refreshed with warnings.'
          : 'Meta Ads sources refreshed.',
        details: { ...result },
      };
    }

    throw new BadRequestException(`Unsupported Meta Ads action: ${params.action}`);
  }

  webhookPath(
    integration: ConnectedIntegrationSnapshot | null,
    legacy?: LegacyIntegrationSnapshot | null,
  ) {
    const id = integration?.id ?? legacy?.id;
    return id ? `/api/integrations/meta-ads/webhook/${id}` : null;
  }

  private async exchangeCode(code: string, redirectUri: string) {
    const clientId = process.env.META_APP_ID || '';
    const clientSecret = process.env.META_APP_SECRET || '';
    if (!clientId || !clientSecret) {
      throw new BadRequestException('META_APP_ID and META_APP_SECRET must be configured');
    }

    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      client_secret: clientSecret,
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

  private oauthRedirectUri() {
    return (
      process.env.META_ADS_REDIRECT_URI ||
      `${this.publicApiRoot()}/api/integrations/meta-ads/oauth/callback`
    );
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

  private async fetchFirstAdAccount(accessToken: string): Promise<MetaAdAccount> {
    const accounts = await this.fetchAdAccounts(accessToken);
    const account = accounts[0];
    if (!account) {
      throw new BadRequestException(
        'No ad accounts found. Ensure this Facebook user has access to an ad account.',
      );
    }
    return account;
  }

  private async fetchAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
    const q = new URLSearchParams({
      fields: 'id,name,account_id,account_status,currency',
      limit: '100',
      access_token: accessToken,
    });

    const rows = await this.fetchGraphCollection(`me/adaccounts?${q.toString()}`);
    return rows
      .map((row): MetaAdAccount | null => {
        const id = this.readString(row, 'id');
        const name = this.readString(row, 'name');
        if (!id || !name) return null;
        return {
          id,
          name,
          accountStatus: this.readString(row, 'account_status') ?? undefined,
          currency: this.readString(row, 'currency') ?? undefined,
        };
      })
      .filter((row): row is MetaAdAccount => !!row);
  }

  private async fetchCampaignCount(accessToken: string, accountId: string) {
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

  private async fetchGraphCollection(pathOrUrl: string): Promise<IntegrationJsonRecord[]> {
    const rows: IntegrationJsonRecord[] = [];
    let url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `https://graph.facebook.com/v19.0/${pathOrUrl.replace(/^\/+/, '')}`;
    let page = 0;

    while (url && page < 10) {
      const data = await this.fetchJson(url);
      rows.push(
        ...this.readArray(data, 'data').filter((row): row is IntegrationJsonRecord =>
          this.isRecord(row),
        ),
      );
      const paging = this.readRecord(data, 'paging');
      const next = this.readString(paging ?? {}, 'next');
      if (!next) break;
      url = next;
      page += 1;
    }

    return rows;
  }

  private async fetchPages(accessToken: string): Promise<MetaPage[]> {
    const q = new URLSearchParams({
      fields: 'id,name,access_token,category,tasks',
      limit: '100',
      access_token: accessToken,
    });
    const rows = await this.fetchGraphCollection(`me/accounts?${q.toString()}`);
    return rows
      .map((row): MetaPage | null => {
        const id = this.readString(row, 'id');
        const name = this.readString(row, 'name');
        if (!id || !name) return null;
        return {
          id,
          name,
          accessToken: this.readString(row, 'access_token') ?? undefined,
          category: this.readString(row, 'category') ?? undefined,
          tasks: this.readArray(row, 'tasks'),
        };
      })
      .filter((row): row is MetaPage => !!row);
  }

  private async fetchLeadFormsForPage(page: MetaPage): Promise<{
    forms: MetaLeadForm[];
    warning?: string;
  }> {
    if (!page.accessToken) {
      return {
        forms: [],
        warning: `${page.name} did not return a page access token.`,
      };
    }

    try {
      const q = new URLSearchParams({
        fields: 'id,name,status,created_time',
        limit: '100',
        access_token: page.accessToken,
      });
      const rows = await this.fetchGraphCollection(`${page.id}/leadgen_forms?${q.toString()}`);
      return {
        forms: rows
          .map((row): MetaLeadForm | null => {
            const id = this.readString(row, 'id');
            const name = this.readString(row, 'name');
            if (!id || !name) return null;
            return {
              id,
              name,
              status: this.readString(row, 'status') ?? undefined,
              createdTime: this.readString(row, 'created_time') ?? undefined,
              pageId: page.id,
              pageName: page.name,
            };
          })
          .filter((row): row is MetaLeadForm => !!row),
      };
    } catch (error) {
      return {
        forms: [],
        warning: `${page.name}: ${this.errorMessage(error)}`,
      };
    }
  }

  private async refreshSourceResources(params: {
    workspaceId: string;
    integrationId: string;
    accessToken: string;
    preferredAdAccountId?: string;
  }): Promise<MetaSourceRefreshResult> {
    if (!params.workspaceId) {
      throw new BadRequestException('Integration workspace is missing');
    }

    const adAccounts = await this.fetchAdAccounts(params.accessToken);
    if (!adAccounts.length) {
      throw new BadRequestException(
        'No ad accounts found. Ensure this Facebook user has access to an ad account.',
      );
    }
    const pages = await this.fetchPages(params.accessToken).catch((error) => {
      this.logger.warn(`Meta page discovery failed: ${this.errorMessage(error)}`);
      return [] as MetaPage[];
    });
    const warnings: string[] = [];
    const formGroups = await Promise.all(pages.map((page) => this.fetchLeadFormsForPage(page)));
    const leadForms = formGroups.flatMap((group) => {
      if (group.warning) warnings.push(group.warning);
      return group.forms;
    });
    const campaignCounts = new Map(
      await Promise.all(
        adAccounts.map(async (account) => [
          account.id,
          await this.fetchCampaignCount(params.accessToken, account.id),
        ] as const),
      ),
    );
    const preferredAccount =
      adAccounts.find((account) => account.id === params.preferredAdAccountId) ?? adAccounts[0];

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.integrationResource.findMany({
        where: {
          workspaceId: params.workspaceId,
          integrationId: params.integrationId,
          type: { in: ['ad_account', 'page', 'lead_form'] },
        },
        select: {
          id: true,
          type: true,
          externalId: true,
          settings: true,
        },
      });
      const existingByKey = new Map(
        existing.map((row) => [`${row.type}:${row.externalId}`, row]),
      );
      const accountRows: Array<{ id: string; externalId: string }> = [];

      for (const account of adAccounts) {
        const existingRow = existingByKey.get(`ad_account:${account.id}`);
        const isPrimary = account.id === preferredAccount.id;
        const row = await tx.integrationResource.upsert({
          where: {
            integrationId_type_externalId: {
              integrationId: params.integrationId,
              type: 'ad_account',
              externalId: account.id,
            },
          },
          update: {
            name: account.name,
            status: 'active',
            settings: this.toInputJson({
              ...this.asRecord(existingRow?.settings),
              primary: isPrimary,
              sourceLabel:
                this.readString(existingRow?.settings ?? {}, 'sourceLabel') ?? account.name,
            }),
            metadata: this.toInputJson({
              accountStatus: account.accountStatus,
              currency: account.currency,
              campaignCount: campaignCounts.get(account.id),
            }),
          },
          create: {
            workspaceId: params.workspaceId,
            integrationId: params.integrationId,
            type: 'ad_account',
            externalId: account.id,
            name: account.name,
            status: 'active',
            settings: this.toInputJson({
              primary: isPrimary,
              sourceLabel: account.name,
            }),
            metadata: this.toInputJson({
              accountStatus: account.accountStatus,
              currency: account.currency,
              campaignCount: campaignCounts.get(account.id),
            }),
          },
        });
        accountRows.push(row);
      }

      for (const page of pages) {
        const existingRow = existingByKey.get(`page:${page.id}`);
        await tx.integrationResource.upsert({
          where: {
            integrationId_type_externalId: {
              integrationId: params.integrationId,
              type: 'page',
              externalId: page.id,
            },
          },
          update: {
            name: page.name,
            status: 'active',
            settings: this.toInputJson({
              ...this.asRecord(existingRow?.settings),
              sourceLabel:
                this.readString(existingRow?.settings ?? {}, 'sourceLabel') ?? page.name,
            }),
            metadata: this.toInputJson({
              category: page.category,
              tasks: page.tasks ?? [],
              hasPageAccessToken: Boolean(page.accessToken),
            }),
          },
          create: {
            workspaceId: params.workspaceId,
            integrationId: params.integrationId,
            type: 'page',
            externalId: page.id,
            name: page.name,
            status: 'active',
            settings: this.toInputJson({
              sourceLabel: page.name,
            }),
            metadata: this.toInputJson({
              category: page.category,
              tasks: page.tasks ?? [],
              hasPageAccessToken: Boolean(page.accessToken),
            }),
          },
        });
      }

      for (const form of leadForms) {
        const existingRow = existingByKey.get(`lead_form:${form.id}`);
        const existingSettings = this.asRecord(existingRow?.settings);
        await tx.integrationResource.upsert({
          where: {
            integrationId_type_externalId: {
              integrationId: params.integrationId,
              type: 'lead_form',
              externalId: form.id,
            },
          },
          update: {
            name: form.name,
            status: form.status?.toLowerCase() === 'archived' ? 'inactive' : 'active',
            settings: this.toInputJson({
              ...existingSettings,
              sourceEnabled: this.readBoolean(existingSettings, 'sourceEnabled') ?? true,
              sourceLabel:
                this.readString(existingSettings, 'sourceLabel') ??
                `${form.pageName} - ${form.name}`,
              linkedPageExternalId: form.pageId,
              linkedPageName: form.pageName,
            }),
            metadata: this.toInputJson({
              providerStatus: form.status,
              createdTime: form.createdTime,
              pageExternalId: form.pageId,
              pageName: form.pageName,
            }),
          },
          create: {
            workspaceId: params.workspaceId,
            integrationId: params.integrationId,
            type: 'lead_form',
            externalId: form.id,
            name: form.name,
            status: form.status?.toLowerCase() === 'archived' ? 'inactive' : 'active',
            settings: this.toInputJson({
              sourceEnabled: true,
              sourceLabel: `${form.pageName} - ${form.name}`,
              linkedPageExternalId: form.pageId,
              linkedPageName: form.pageName,
            }),
            metadata: this.toInputJson({
              providerStatus: form.status,
              createdTime: form.createdTime,
              pageExternalId: form.pageId,
              pageName: form.pageName,
            }),
          },
        });
      }

      const primaryRow = accountRows.find((row) => row.externalId === preferredAccount.id);
      const integration = await tx.integration.findUnique({
        where: { id: params.integrationId },
        select: { settings: true, metadata: true },
      });
      await tx.integration.update({
        where: { id: params.integrationId },
        data: {
          settings: this.toInputJson({
            ...this.asRecord(integration?.settings),
            primaryResourceId: primaryRow?.id,
            primaryAdAccountId: preferredAccount.id,
          }),
          metadata: this.toInputJson({
            ...this.asRecord(integration?.metadata),
            accountId: preferredAccount.id,
            accountName: preferredAccount.name,
            accountStatus: preferredAccount.accountStatus,
            currency: preferredAccount.currency,
            resourceCounts: {
              adAccounts: adAccounts.length,
              pages: pages.length,
              leadForms: leadForms.length,
            },
          }),
        },
      });
    });

    return {
      adAccounts: adAccounts.length,
      pages: pages.length,
      leadForms: leadForms.length,
      warnings,
    };
  }

  private async getLegacyStatus(workspaceId: string) {
    const row = await this.prisma.channel.findFirst({
      where: { workspaceId, type: this.provider },
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

  private readMetaAccessToken(integration: ConnectedIntegrationSnapshot) {
    const credentials = integration.credentialsEncrypted
      ? this.secrets.decryptJson(integration.credentialsEncrypted)
      : {};
    const accessToken = this.readString(credentials, 'accessToken');
    if (!accessToken) {
      throw new BadRequestException('Meta Ads credentials are incomplete');
    }
    return accessToken;
  }

  private async ingestLegacyChannelWebhook(channelId: string, payload: unknown) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.type !== this.provider) {
      return { status: 'integration_not_found' };
    }

    const event = this.normalizeEvent(channel.id, payload);
    const identifier = event.phone ?? event.email ?? event.leadId;

    await this.processingQueue.enqueueInboundProcess({
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      channelType: this.provider,
      contactIdentifier: identifier,
      direction: 'incoming',
      messageType: 'lead_event',
      text: event.message,
      attachments: [],
      metadata: {
        provider: this.provider,
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

  private async emitWorkflowEvent(
    integration: Pick<Integration, 'id' | 'workspaceId' | 'provider'>,
    event: NormalizedMetaAdsEvent,
  ) {
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

  private normalizeEvent(seed: string, payload: unknown): NormalizedMetaAdsEvent {
    const root = this.asRecord(payload);
    const changeValue = this.firstChangeValue(root);
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

  private firstChangeValue(root: IntegrationJsonRecord): IntegrationJsonRecord | null {
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
