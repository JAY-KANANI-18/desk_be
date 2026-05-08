import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { log } from 'console';

export type ProviderUrgency = 'low' | 'normal' | 'high';

export interface AiConversationContext {
  workspaceId: string;
  conversation: {
    id: string;
    subject: string | null;
    status: string;
    priority: string;
    createdAt: string;
    updatedAt: string;
    lastMessageAt: string | null;
    lastIncomingAt: string | null;
  };
  contact: {
    id: string;
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    status: string | null;
    marketingOptOut: boolean;
    lifecycleStage: string | null;
    assigneeName: string | null;
    teamName: string | null;
    currentTags: string[];
    linkedChannels: Array<{ type: string | null; identifier: string | null }>;
  };
  channel: string;
  recentMessages: Array<{
    direction: string;
    type: string;
    text: string | null;
    subject: string | null;
    status: string;
    createdAt: string;
    channelName: string | null;
    channelType: string | null;
    authorName: string | null;
  }>;
  recentActivities: Array<{
    eventType: string;
    description: string;
    createdAt: string;
  }>;
  workspaceTags: string[];
  facts: {
    incomingCount: number;
    outgoingCount: number;
    lastCustomerMessage: string | null;
    lastTeamReply: string | null;
  };
}

export interface AiAssistProviderOutput {
  summary: string | null;
  suggestedReply: string | null;
  suggestedTags: string[];
  intent: string | null;
  urgency: ProviderUrgency | null;
  confidence: 'low' | 'medium' | 'high' | null;
}

export interface WorkspaceAiRuntimeSettings {
  provider: string;
  model: string;
}

const DEFAULT_AI_PROVIDER = 'mistral';
const DEFAULT_MISTRAL_MODEL = 'mistral-large-2512';

@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);

  getProviderMeta(settings?: Partial<WorkspaceAiRuntimeSettings>) {
    console.log({settings});
    
    const requestedProvider = this.normalizeProvider(settings?.provider);
    const provider = this.resolveProvider(requestedProvider);
    console.log(`Resolved AI provider: ${provider} (requested: ${requestedProvider || 'none'})`);
    
    const model =
      settings?.model && (!requestedProvider || provider === requestedProvider)
        ? settings.model
        : this.defaultModelFor(provider);

    return {
      provider,
      model,
      configured: this.isConfigured(provider),
    };
  }

  ensureConfigured(settings?: Partial<WorkspaceAiRuntimeSettings>) {
    const meta = this.getProviderMeta(settings);
    if (!meta.configured) {
      throw new BadRequestException(`${meta.provider} provider is not configured`);
    }
    return meta;
  }

  async generateText(input: {
    settings?: Partial<WorkspaceAiRuntimeSettings>;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    responseFormat?: 'json_object';
  }) {
    const meta = this.ensureConfigured(input.settings);
    const provider = meta.provider;

    if (provider === 'cohere') {
      return this.generateWithCohere(meta.model, input.systemPrompt, input.userPrompt, input.temperature);
    }

    if (provider === 'mistral') {
      return this.generateWithMistral(
        meta.model,
        input.systemPrompt,
        input.userPrompt,
        input.temperature,
        input.responseFormat,
      );
    }

    if (provider === 'anthropic' || provider === 'claude') {
      return this.generateWithAnthropic(meta.model, input.systemPrompt, input.userPrompt, input.temperature);
    }

    return this.generateWithOpenAi(
      meta.model,
      input.systemPrompt,
      input.userPrompt,
      input.temperature,
      input.responseFormat,
    );
  }

  async generateStructuredObject<T>(input: {
    settings?: Partial<WorkspaceAiRuntimeSettings>;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
  }): Promise<T> {
    const text = await this.generateText({
      ...input,
      systemPrompt: `${input.systemPrompt}\nReturn valid JSON only.`,
      responseFormat: 'json_object',
    });
    log(`Raw AI output: ${text}`);
    return this.extractJson<T>(text);
  }

  normalizeAssistOutput(raw: any, workspaceTags: string[]): AiAssistProviderOutput {
    const allowedUrgency = new Set<ProviderUrgency>(['low', 'normal', 'high']);
    const allowedConfidence = new Set(['low', 'medium', 'high']);
    const allowedTagNames = new Set(workspaceTags.map((tag) => tag.toLowerCase()));

    const suggestedTags = Array.isArray(raw?.suggestedTags)
      ? raw.suggestedTags
          .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim())
          .filter((value) => allowedTagNames.has(value.toLowerCase()))
          .slice(0, 5)
      : [];

    return {
      summary: typeof raw?.summary === 'string' ? raw.summary.trim() || null : null,
      suggestedReply:
        typeof raw?.suggestedReply === 'string' ? raw.suggestedReply.trim() || null : null,
      suggestedTags,
      intent: typeof raw?.intent === 'string' ? raw.intent.trim() || null : null,
      urgency:
        typeof raw?.urgency === 'string' && allowedUrgency.has(raw.urgency as ProviderUrgency)
          ? raw.urgency
          : null,
      confidence:
        typeof raw?.confidence === 'string' && allowedConfidence.has(raw.confidence)
          ? raw.confidence
          : null,
    };
  }

  private isConfigured(provider: string) {
    return Boolean(this.apiKeyFor(provider));
  }

  private resolveProvider(requestedProvider?: string) {
    const configured = [
      requestedProvider,
      this.normalizeProvider(process.env.AI_PROVIDER),
      DEFAULT_AI_PROVIDER,
    ].filter(Boolean) as string[];

    return configured.find((provider) => this.isConfigured(provider)) || configured[0] || DEFAULT_AI_PROVIDER;
  }

  private normalizeProvider(provider?: string) {
    const normalized = provider?.trim().toLowerCase();
    if (!normalized) return undefined;
    return normalized === 'claude' ? 'anthropic' : normalized;
  }

  private apiKeyFor(provider: string) {
    switch (provider) {
      case 'mistral':
        return process.env.MISTRAL_API_KEY;
      case 'cohere':
        return process.env.COHERE_API_KEY || process.env.AI_API_KEY;
      case 'anthropic':
      case 'claude':
        return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
      default:
        return process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
    }
  }

  private defaultModelFor(provider: string) {
    console.log(` Getting default model for provider: ${provider}`);
    
    switch (provider) {
      case 'mistral':
        return process.env.MISTRAL_MODEL || process.env.AI_MODEL || DEFAULT_MISTRAL_MODEL;
      case 'cohere':
        return process.env.COHERE_MODEL || 'command-a-03-2025';
      case 'anthropic':
      case 'claude':
        return process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
      default:
        return process.env.OPENAI_MODEL || process.env.AI_MODEL || 'gpt-4.1-mini';
    }
  }

  private async generateWithOpenAi(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.2,
    responseFormat?: 'json_object',
  ) {
    const baseUrl = (process.env.OPENAI_BASE_URL || process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await this.postJson(`${baseUrl}/chat/completions`, {
      headers: {
        Authorization: `Bearer ${this.apiKeyFor('openai')}`,
        ...(process.env.AI_ORG_ID ? { 'OpenAI-Organization': process.env.AI_ORG_ID } : {}),
      },
      body: {
        model,
        temperature,
        ...(responseFormat === 'json_object'
          ? { response_format: { type: 'json_object' } }
          : {}),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
    });

    return response?.choices?.[0]?.message?.content?.trim() || '';
  }

  private async generateWithMistral(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.2,
    responseFormat?: 'json_object',
  ) {
    const baseUrl = (process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/$/, '');
    const response = await this.postJson(`${baseUrl}/chat/completions`, {
      headers: {
        Authorization: `Bearer ${this.apiKeyFor('mistral')}`,
      },
      body: {
        model,
        temperature,
        ...(responseFormat === 'json_object'
          ? { response_format: { type: 'json_object' } }
          : {}),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
    });

    return this.extractContentText(response?.choices?.[0]?.message?.content);
  }

  private async generateWithCohere(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.2,
  ) {
    const baseUrl = (process.env.COHERE_BASE_URL || 'https://api.cohere.com').replace(/\/$/, '');
    const response = await this.postJson(`${baseUrl}/v2/chat`, {
      headers: {
        Authorization: `Bearer ${this.apiKeyFor('cohere')}`,
      },
      body: {
        model,
        temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
    });

    return response?.message?.content?.map((item: any) => item?.text || '').join('').trim() || '';
  }

  private async generateWithAnthropic(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.2,
  ) {
    const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    const response = await this.postJson(`${baseUrl}/v1/messages`, {
      headers: {
        'x-api-key': this.apiKeyFor('anthropic'),
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      },
      body: {
        model,
        system: systemPrompt,
        temperature,
        max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 900),
        messages: [{ role: 'user', content: userPrompt }],
      },
    });

    return response?.content?.map((item: any) => item?.text || '').join('').trim() || '';
  }

  private async postJson(
    url: string,
    input: { headers?: Record<string, string | undefined>; body: Record<string, any> },
  ) {
    const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 20000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...input.headers,
        } as Record<string, string>,
        body: JSON.stringify(input.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.warn(`AI provider request failed: ${response.status} ${errorText}`);
        throw new BadRequestException('AI provider request failed');
      }

      return response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`AI provider request error: ${message}`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractJson<T>(text: string): T {
    const trimmed = text.trim();
    const candidates = [trimmed];

    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      candidates.push(trimmed.slice(objectStart, objectEnd + 1));
    }

    const arrayStart = trimmed.indexOf('[');
    const arrayEnd = trimmed.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
    }

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as T;
      } catch (error) {
        lastError = error;
      }
    }

    throw new BadRequestException(
      `AI provider returned invalid JSON${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
    );
  }

  private extractContentText(content: unknown) {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';

    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const maybeText = (item as { text?: unknown }).text;
        return typeof maybeText === 'string' ? maybeText : '';
      })
      .join('')
      .trim();
  }
}
