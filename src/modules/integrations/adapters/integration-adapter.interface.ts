import { Prisma } from '@prisma/client';
import { IntegrationProviderKey } from '../integration-catalog';

export type IntegrationJsonRecord = Record<string, unknown>;

export interface IntegrationSummary {
  accountName?: string;
  accountId?: string;
  accountStatus?: string;
  currency?: string;
  campaignCount?: number;
  shopDomain?: string;
  shopName?: string;
}

export interface ConnectedIntegrationSnapshot {
  id: string;
  workspaceId?: string;
  provider: string;
  status: string;
  externalAccountId: string | null;
  externalAccountName: string | null;
  metadata: Prisma.JsonValue | null;
  health?: Prisma.JsonValue | null;
  settings?: Prisma.JsonValue | null;
  lastSyncedAt?: Date | null;
  lastWebhookAt?: Date | null;
  credentialsEncrypted?: string | null;
}

export interface IntegrationJobSnapshot {
  id: string;
  workspaceId: string;
  integrationId: string;
  resourceId: string | null;
  type: string;
  attempts: number;
  maxRetries: number;
  input: Prisma.JsonValue | null;
}

export interface IntegrationJobProcessParams {
  job: IntegrationJobSnapshot;
  integration: ConnectedIntegrationSnapshot;
}

export interface IntegrationEventReplaySnapshot {
  id: string;
  workspaceId: string;
  integrationId: string;
  resourceId: string | null;
  provider: string;
  eventType: string;
  externalEventId: string | null;
  idempotencyKey: string;
  occurredAt: Date | null;
  payload: Prisma.JsonValue | null;
}

export interface IntegrationEventReplayParams {
  integration: ConnectedIntegrationSnapshot;
  event: IntegrationEventReplaySnapshot;
}

export interface IntegrationSyncJobDefinition {
  type: string;
  resourceId?: string | null;
  input?: IntegrationJsonRecord;
  maxRetries?: number;
  scheduledAt?: Date;
}

export interface IntegrationSyncOptions {
  mode?: 'manual_sync' | 'backfill';
  resources?: string[];
  since?: string;
  until?: string;
}

export interface IntegrationProviderActionDescriptor {
  key: string;
  label: string;
  description?: string;
  mode: 'immediate' | 'job';
  destructive?: boolean;
}

export interface IntegrationProviderActionParams {
  integration: ConnectedIntegrationSnapshot;
  action: string;
}

export interface IntegrationProviderActionResult {
  status: string;
  action: string;
  message?: string;
  details?: IntegrationJsonRecord;
}

export type IntegrationActionJobDefinition = IntegrationSyncJobDefinition;

export interface LegacyIntegrationSnapshot {
  id: string;
  status: string;
  config: Prisma.JsonValue | null;
}

export interface IntegrationOAuthUrlParams {
  workspaceId: string;
  query?: Record<string, string | undefined>;
}

export interface IntegrationOAuthExchangeParams {
  workspaceId: string;
  code: string;
  createdById?: string;
  query?: Record<string, string | undefined>;
}

export interface IntegrationWebhookParams {
  integrationId?: string;
  payload: unknown;
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: Buffer | string;
}

export interface IntegrationProviderAdapter {
  provider: IntegrationProviderKey;
  buildOAuthUrl?(params: IntegrationOAuthUrlParams): Promise<Record<string, unknown>> | Record<string, unknown>;
  connectOAuth?(params: IntegrationOAuthExchangeParams): Promise<Record<string, unknown>>;
  refreshStatus?(workspaceId: string): Promise<Record<string, unknown>>;
  ingestWebhook?(params: IntegrationWebhookParams): Promise<Record<string, unknown>>;
  disconnect?(workspaceId: string): Promise<void>;
  processJob?(params: IntegrationJobProcessParams): Promise<Record<string, unknown>>;
  replayEvent?(params: IntegrationEventReplayParams): Promise<Record<string, unknown>>;
  buildSyncJob?(
    integration: ConnectedIntegrationSnapshot,
    options?: IntegrationSyncOptions,
  ): Promise<IntegrationSyncJobDefinition | null> | IntegrationSyncJobDefinition | null;
  providerActions?(
    integration: ConnectedIntegrationSnapshot,
  ): IntegrationProviderActionDescriptor[];
  runAction?(
    params: IntegrationProviderActionParams,
  ): Promise<IntegrationProviderActionResult> | IntegrationProviderActionResult;
  buildActionJob?(
    params: IntegrationProviderActionParams,
  ): Promise<IntegrationActionJobDefinition | null> | IntegrationActionJobDefinition | null;
  summarize?(integration: ConnectedIntegrationSnapshot): IntegrationSummary | null;
  summarizeLegacy?(legacy: LegacyIntegrationSnapshot): IntegrationSummary | null;
  webhookPath?(integration: ConnectedIntegrationSnapshot | null, legacy?: LegacyIntegrationSnapshot | null): string | null;
}
