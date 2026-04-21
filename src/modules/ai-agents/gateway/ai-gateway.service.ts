import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { aiAgentsDebug } from '../ai-agents-debug.logger';

export type AiProviderName = 'openai' | 'cohere' | 'anthropic' | 'claude' | 'gemini';

export interface AiGatewayMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface AiGatewayRequest {
  workspaceId: string;
  runId?: string;
  operation: 'intent' | 'decision' | 'reply' | 'summary' | 'guardrail' | 'embedding';
  messages: AiGatewayMessage[];
  provider?: AiProviderName;
  providerOrder?: AiProviderName[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  metadata?: Record<string, any>;
}

export interface AiGatewayResponse {
  provider: string;
  model: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
}

@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);

  constructor(private readonly prisma: PrismaService) {}

  async completeText(input: AiGatewayRequest): Promise<AiGatewayResponse> {
    const providers = this.resolveProviderOrder(input);
    const errors: string[] = [];
    aiAgentsDebug.log('gateway', 'completeText start', {
      workspaceId: input.workspaceId,
      runId: input.runId,
      operation: input.operation,
      requestedProvider: input.provider,
      providerOrder: providers,
      requestedModel: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      timeoutMs: input.timeoutMs || Number(process.env.AI_TIMEOUT_MS || 20000),
      messageCount: input.messages.length,
      messages: input.messages.map((message) => ({
        role: message.role,
        chars: message.content?.length || 0,
        content: message.content,
      })),
      metadata: input.metadata,
    });

    for (const provider of providers) {
      if (!this.apiKeyFor(provider)) {
        aiAgentsDebug.warn('gateway', 'provider skipped because API key is missing', {
          workspaceId: input.workspaceId,
          runId: input.runId,
          operation: input.operation,
          provider,
        });
        errors.push(`${provider}: missing api key`);
        continue;
      }

      const model = input.model || this.defaultModelFor(provider);
      const started = Date.now();
      aiAgentsDebug.log('gateway', 'provider attempt start', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        operation: input.operation,
        provider,
        model,
      });

      try {
        const response = await this.withRetries(
          () => this.callProvider(provider, model, input),
          Number(process.env.AI_PROVIDER_RETRIES || 2),
          {
            workspaceId: input.workspaceId,
            runId: input.runId,
            operation: input.operation,
            provider,
            model,
          },
        );
        const latencyMs = Date.now() - started;
        const usage = this.normalizeUsage(response.usage, input.messages, response.content);
        const result: AiGatewayResponse = {
          provider,
          model,
          content: response.content.trim(),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          latencyMs,
        };

        await this.recordUsage(input, result);
        aiAgentsDebug.log('gateway', 'provider attempt succeeded', {
          workspaceId: input.workspaceId,
          runId: input.runId,
          operation: input.operation,
          provider,
          model,
          latencyMs,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.totalTokens,
          contentChars: result.content.length,
          content: result.content,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider}: ${message}`);
        aiAgentsDebug.error('gateway', 'provider attempt failed', error, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          operation: input.operation,
          provider,
          model,
          latencyMs: Date.now() - started,
        });
        this.logger.warn(`AI provider failed provider=${provider} model=${model}: ${message}`);
      }
    }

    aiAgentsDebug.warn('gateway', 'all providers failed', {
      workspaceId: input.workspaceId,
      runId: input.runId,
      operation: input.operation,
      providers,
      errors,
    });
    throw new BadRequestException(`All AI providers failed: ${errors.join('; ')}`);
  }

  async completeJson<T>(input: AiGatewayRequest): Promise<{ data: T; raw: AiGatewayResponse }> {
    aiAgentsDebug.log('gateway', 'completeJson start', {
      workspaceId: input.workspaceId,
      runId: input.runId,
      operation: input.operation,
      provider: input.provider,
      model: input.model,
    });
    const raw = await this.completeText({
      ...input,
      messages: [
        ...input.messages,
        { role: 'system', content: 'Return strict JSON only. Do not wrap it in Markdown.' },
      ],
    });

    try {
      const data = this.extractJson<T>(raw.content);
      aiAgentsDebug.log('gateway', 'completeJson parsed', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        operation: input.operation,
        provider: raw.provider,
        model: raw.model,
        data,
      });
      return { data, raw };
    } catch (error) {
      aiAgentsDebug.error('gateway', 'completeJson parse failed', error, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        operation: input.operation,
        provider: raw.provider,
        model: raw.model,
        rawContent: raw.content,
      });
      throw error;
    }
  }

  async embed(input: {
    workspaceId: string;
    runId?: string;
    text: string;
    provider?: AiProviderName;
    model?: string;
    timeoutMs?: number;
  }): Promise<{ provider: string; model: string; embedding: number[]; dim: number; latencyMs: number }> {
    const providers = this.resolveEmbeddingProviderOrder(input.provider);
    const errors: string[] = [];
    aiAgentsDebug.log('gateway.embedding', 'embed start', {
      workspaceId: input.workspaceId,
      runId: input.runId,
      requestedProvider: input.provider,
      providerOrder: providers,
      requestedModel: input.model,
      textChars: input.text?.length || 0,
      text: input.text,
      timeoutMs: input.timeoutMs || Number(process.env.AI_TIMEOUT_MS || 20000),
    });

    for (const provider of providers) {
      const model = input.model && provider === input.provider ? input.model : this.defaultEmbeddingModelFor(provider);
      const started = Date.now();

      if (!this.apiKeyFor(provider)) {
        errors.push(`${provider}: missing api key`);
        aiAgentsDebug.warn('gateway.embedding', 'embedding provider skipped because API key is missing', {
          workspaceId: input.workspaceId,
          runId: input.runId,
          provider,
          model,
        });
        continue;
      }

      try {
        const response = await this.callEmbeddingProvider(provider, model, input.text, input.timeoutMs);
        const result = {
          provider,
          model,
          embedding: response.embedding,
          dim: response.embedding.length,
          latencyMs: Date.now() - started,
        };

        await this.recordUsage(
          {
            workspaceId: input.workspaceId,
            runId: input.runId,
            operation: 'embedding',
            messages: [{ role: 'user', content: input.text }],
          },
          {
            provider,
            model,
            content: '',
            promptTokens: this.estimateTokens(input.text),
            completionTokens: 0,
            totalTokens: this.estimateTokens(input.text),
            latencyMs: result.latencyMs,
          },
        );

        aiAgentsDebug.log('gateway.embedding', 'embed result', {
          workspaceId: input.workspaceId,
          runId: input.runId,
          provider,
          model,
          dim: result.dim,
          latencyMs: result.latencyMs,
          embedding: result.embedding,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider}: ${message}`);
        aiAgentsDebug.error('gateway.embedding', 'embed provider failed; trying fallback', error, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          provider,
          model,
          latencyMs: Date.now() - started,
        });
      }
    }

    throw new BadRequestException(`All embedding providers failed: ${errors.join('; ')}`);
  }

  private resolveProviderOrder(input: AiGatewayRequest): AiProviderName[] {
    const configured = [
      input.provider,
      ...(input.providerOrder || []),
      process.env.AI_PROVIDER as AiProviderName,
      'cohere',
      'openai',
      'anthropic',
      'gemini',
    ].filter(Boolean) as AiProviderName[];

    return [...new Set(configured.map((provider) => (provider === 'claude' ? 'anthropic' : provider)))];
  }

  private resolveEmbeddingProviderOrder(provider?: AiProviderName): AiProviderName[] {
    const configured = [
      provider,
      process.env.AI_EMBEDDING_PROVIDER as AiProviderName,
      process.env.AI_PROVIDER as AiProviderName,
      'cohere',
      'openai',
      'gemini',
    ].filter(Boolean) as AiProviderName[];

    const embeddingProviders = new Set(['cohere', 'openai', 'gemini']);
    return [
      ...new Set(
        configured
          .map((item) => (item === 'claude' ? 'anthropic' : item))
          .filter((item) => embeddingProviders.has(item)),
      ),
    ] as AiProviderName[];
  }

  private async withRetries<T>(
    fn: () => Promise<T>,
    retries: number,
    debugContext?: Record<string, any>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        aiAgentsDebug.log('gateway.retry', 'attempt start', {
          ...(debugContext || {}),
          attempt: attempt + 1,
          maxAttempts: retries + 1,
        });
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          const delayMs = Math.min(2000 * (attempt + 1), 6000);
          aiAgentsDebug.error('gateway.retry', 'attempt failed; retry scheduled', error, {
            ...(debugContext || {}),
            attempt: attempt + 1,
            maxAttempts: retries + 1,
            delayMs,
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    aiAgentsDebug.error('gateway.retry', 'all retry attempts exhausted', lastError, debugContext);
    throw lastError;
  }

  private async callProvider(provider: AiProviderName, model: string, input: AiGatewayRequest) {
    if (provider === 'cohere') return this.callCohere(model, input);
    if (provider === 'anthropic' || provider === 'claude') return this.callAnthropic(model, input);
    if (provider === 'gemini') return this.callGemini(model, input);
    return this.callOpenAi(model, input);
  }

  private async callOpenAi(model: string, input: AiGatewayRequest) {
    const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await this.postJson(`${baseUrl}/chat/completions`, {
      timeoutMs: input.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.apiKeyFor('openai')}`,
        ...(process.env.AI_ORG_ID ? { 'OpenAI-Organization': process.env.AI_ORG_ID } : {}),
      },
      body: {
        model,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens,
        messages: input.messages,
      },
    });

    return {
      content: response?.choices?.[0]?.message?.content || '',
      usage: response?.usage,
    };
  }

  private async callCohere(model: string, input: AiGatewayRequest) {
    const baseUrl = (process.env.COHERE_BASE_URL || 'https://api.cohere.com').replace(/\/$/, '');
    const response = await this.postJson(`${baseUrl}/v2/chat`, {
      timeoutMs: input.timeoutMs,
      headers: { Authorization: `Bearer ${this.apiKeyFor('cohere')}` },
      body: {
        model,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens,
        messages: input.messages.map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
          content: message.content,
        })),
      },
    });

    return {
      content: response?.message?.content?.map((item: any) => item?.text || '').join('') || '',
      usage: response?.usage,
    };
  }

  private async callAnthropic(model: string, input: AiGatewayRequest) {
    const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    const system = input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const messages = input.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));

    const response = await this.postJson(`${baseUrl}/v1/messages`, {
      timeoutMs: input.timeoutMs,
      headers: {
        'x-api-key': this.apiKeyFor('anthropic'),
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      },
      body: {
        model,
        system,
        messages,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens || Number(process.env.AI_MAX_TOKENS || 900),
      },
    });

    return {
      content: response?.content?.map((item: any) => item?.text || '').join('') || '',
      usage: response?.usage,
    };
  }

  private async callGemini(model: string, input: AiGatewayRequest) {
    const baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const system = input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const contents = input.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));

    const response = await this.postJson(`${baseUrl}/models/${model}:generateContent?key=${this.apiKeyFor('gemini')}`, {
      timeoutMs: input.timeoutMs,
      body: {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: {
          temperature: input.temperature ?? 0.2,
          maxOutputTokens: input.maxTokens,
        },
      },
    });

    return {
      content: response?.candidates?.[0]?.content?.parts?.map((item: any) => item?.text || '').join('') || '',
      usage: response?.usageMetadata,
    };
  }

  private async callEmbeddingProvider(provider: AiProviderName, model: string, text: string, timeoutMs?: number) {
    if (provider === 'cohere') {
      const baseUrl = (process.env.COHERE_BASE_URL || 'https://api.cohere.com').replace(/\/$/, '');
      const response = await this.postJson(`${baseUrl}/v2/embed`, {
        timeoutMs,
        headers: { Authorization: `Bearer ${this.apiKeyFor('cohere')}` },
        body: {
          model,
          texts: [text],
          input_type: 'search_document',
          embedding_types: ['float'],
        },
      });
      return { embedding: response?.embeddings?.float?.[0] || response?.embeddings?.[0] || [] };
    }

    if (provider === 'gemini') {
      const baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
      const response = await this.postJson(`${baseUrl}/models/${model}:embedContent?key=${this.apiKeyFor('gemini')}`, {
        timeoutMs,
        body: { content: { parts: [{ text }] } },
      });
      return { embedding: response?.embedding?.values || [] };
    }

    const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await this.postJson(`${baseUrl}/embeddings`, {
      timeoutMs,
      headers: { Authorization: `Bearer ${this.apiKeyFor('openai')}` },
      body: { model, input: text },
    });
    return { embedding: response?.data?.[0]?.embedding || [] };
  }

  private async postJson(url: string, input: { headers?: Record<string, string | undefined>; body: Record<string, any>; timeoutMs?: number }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs || Number(process.env.AI_TIMEOUT_MS || 20000));
    const started = Date.now();
    aiAgentsDebug.log('gateway.http', 'request start', {
      url: this.safeUrl(url),
      timeoutMs: input.timeoutMs || Number(process.env.AI_TIMEOUT_MS || 20000),
      headers: input.headers,
      body: input.body,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(input.headers || {}),
        } as Record<string, string>,
        body: JSON.stringify(input.body),
        signal: controller.signal,
      });

      aiAgentsDebug.log('gateway.http', 'response received', {
        url: this.safeUrl(url),
        status: response.status,
        ok: response.ok,
        latencyMs: Date.now() - started,
      });

      if (!response.ok) {
        const errorText = await response.text();
        aiAgentsDebug.warn('gateway.http', 'request failed response body', {
          url: this.safeUrl(url),
          status: response.status,
          body: errorText,
        });
        throw new Error(`${response.status} ${errorText.slice(0, 500)}`);
      }

      return response.json();
    } catch (error) {
      aiAgentsDebug.error('gateway.http', 'request threw error', error, {
        url: this.safeUrl(url),
        latencyMs: Date.now() - started,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeUsage(usage: any, messages: AiGatewayMessage[], content: string) {
    const promptTokens =
      usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.tokens?.input_tokens ?? usage?.promptTokenCount;
    const completionTokens =
      usage?.completion_tokens ?? usage?.output_tokens ?? usage?.tokens?.output_tokens ?? usage?.candidatesTokenCount;

    const estimatedPrompt = messages.reduce((sum, message) => sum + this.estimateTokens(message.content), 0);
    const estimatedCompletion = this.estimateTokens(content);

    return {
      promptTokens: Number(promptTokens ?? estimatedPrompt),
      completionTokens: Number(completionTokens ?? estimatedCompletion),
      totalTokens: Number(usage?.total_tokens ?? usage?.totalTokenCount ?? (promptTokens ?? estimatedPrompt) + (completionTokens ?? estimatedCompletion)),
    };
  }

  private async recordUsage(input: AiGatewayRequest, response: AiGatewayResponse) {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

    try {
      aiAgentsDebug.log('gateway.usage', 'recordUsage start', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        operation: input.operation,
        provider: response.provider,
        model: response.model,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        totalTokens: response.totalTokens,
        periodStart: periodStart.toISOString().slice(0, 10),
        periodEnd: periodEnd.toISOString().slice(0, 10),
        metadata: input.metadata,
      });
      await this.prisma.$executeRawUnsafe(
        `
          INSERT INTO "ai_usage_billing"
            ("workspace_id", "run_id", "provider", "model", "operation", "prompt_tokens",
             "completion_tokens", "total_tokens", "period_start", "period_end", "metadata")
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11::jsonb)
        `,
        input.workspaceId,
        input.runId || null,
        response.provider,
        response.model,
        input.operation,
        response.promptTokens,
        response.completionTokens,
        response.totalTokens,
        periodStart.toISOString().slice(0, 10),
        periodEnd.toISOString().slice(0, 10),
        JSON.stringify(input.metadata || {}),
      );
      aiAgentsDebug.log('gateway.usage', 'recordUsage result', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        operation: input.operation,
        totalTokens: response.totalTokens,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aiAgentsDebug.error('gateway.usage', 'recordUsage failed', error, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        operation: input.operation,
      });
      this.logger.warn(`Failed to record AI usage: ${message}`);
    }
  }

  private extractJson<T>(text: string): T {
    const trimmed = text.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      }
      throw new BadRequestException('AI provider returned invalid JSON');
    }
  }

  private estimateTokens(text: string) {
    return Math.max(1, Math.ceil((text || '').length / 4));
  }

  private safeUrl(url: string) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url.split('?')[0];
    }
  }

  private apiKeyFor(provider: AiProviderName) {
    switch (provider) {
      case 'cohere':
        return process.env.COHERE_API_KEY || process.env.AI_API_KEY;
      case 'anthropic':
      case 'claude':
        return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
      case 'gemini':
        return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
      default:
        return process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
    }
  }

  private defaultModelFor(provider: AiProviderName) {
    switch (provider) {
      case 'cohere':
        return process.env.COHERE_MODEL || 'command-a-03-2025';
      case 'anthropic':
      case 'claude':
        return process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
      case 'gemini':
        return process.env.GEMINI_MODEL || 'gemini-1.5-flash';
      default:
        return process.env.OPENAI_MODEL || process.env.AI_MODEL || 'gpt-4.1-mini';
    }
  }

  private defaultEmbeddingModelFor(provider: AiProviderName) {
    switch (provider) {
      case 'cohere':
        return process.env.COHERE_EMBEDDING_MODEL || 'embed-v4.0';
      case 'gemini':
        return process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004';
      default:
        return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    }
  }
}
