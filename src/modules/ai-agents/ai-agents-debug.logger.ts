import { Logger } from '@nestjs/common';

type DebugLevel = 'log' | 'warn' | 'error';

const REDACT_KEYS = [
  'authorization',
  'bearer',
  'accessToken',
  'access_token',
  'id_token',
  'apiKey',
  'api_key',
  'secret',
  'password',
  'token',
  'refreshToken',
  'credentials',
  'x-api-key',
];

class AiAgentsDebugLogger {
  private readonly logger = new Logger('AiAgentsDebug');

  enabled() {
    return this.flag('AI_AGENTS_DEBUG') || this.flag('AI_DEBUG');
  }

  verbose() {
    return this.enabled() && (this.flag('AI_AGENTS_DEBUG_VERBOSE') || this.flag('AI_DEBUG_VERBOSE'));
  }

  log(scope: string, event: string, data?: Record<string, any>) {
    this.write('log', scope, event, data);
  }

  warn(scope: string, event: string, data?: Record<string, any>) {
    this.write('warn', scope, event, data);
  }

  error(scope: string, event: string, error: unknown, data?: Record<string, any>) {
    this.write('error', scope, event, {
      ...(data || {}),
      error: this.errorPayload(error),
    });
  }

  step(runId: string | undefined, step: string, data?: Record<string, any>) {
    this.log('runtime', step, { runId, ...(data || {}) });
  }

  private write(level: DebugLevel, scope: string, event: string, data?: Record<string, any>) {
    if (!this.enabled()) return;

    const payload = data ? ` ${this.stringify(data)}` : '';
    const line = `[${scope}] ${event}${payload}`;

    if (level === 'error') {
      this.logger.error(line);
      return;
    }

    if (level === 'warn') {
      this.logger.warn(line);
      return;
    }

    this.logger.log(line);
  }

  private stringify(value: unknown) {
    const redacted = this.redact(value, 0, new WeakSet<object>());
    const text = JSON.stringify(redacted);
    const max = Number(process.env.AI_AGENTS_DEBUG_MAX_CHARS || 4000) || 4000;
    return text.length > max ? `${text.slice(0, max)}...<truncated ${text.length - max} chars>` : text;
  }

  private redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value;
    if (depth > 8) return '[max-depth]';
    if (typeof value === 'bigint') return value.toString();

    if (typeof value === 'string') {
      if (this.verbose()) return value;
      return value.length > 600 ? `${value.slice(0, 600)}...<truncated>` : value;
    }

    if (typeof value !== 'object') return value;
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const limit = this.verbose() ? value.length : Math.min(value.length, 20);
      const items = value.slice(0, limit).map((item) => this.redact(item, depth + 1, seen));
      return value.length > limit ? [...items, `<${value.length - limit} more items>`] : items;
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (this.shouldRedact(key)) {
        out[key] = '[redacted]';
        continue;
      }

      if (!this.verbose() && key.toLowerCase().includes('embedding') && Array.isArray(item)) {
        out[key] = `[embedding:${item.length}]`;
        continue;
      }

      out[key] = this.redact(item, depth + 1, seen);
    }

    return out;
  }

  private errorPayload(error: unknown) {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: this.verbose() ? error.stack : undefined,
      };
    }

    return error;
  }

  private shouldRedact(key: string) {
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (['prompt_tokens', 'completion_tokens', 'total_tokens', 'max_tokens'].includes(normalized)) {
      return false;
    }

    return REDACT_KEYS.some((part) => {
      const normalizedPart = part
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

      if (normalizedPart === 'token') {
        return normalized === 'token' || normalized.endsWith('_token');
      }

      return normalized === normalizedPart || normalized.includes(normalizedPart);
    });
  }

  private flag(name: string) {
    return ['1', 'true', 'yes', 'on', 'debug', 'verbose'].includes(String(process.env[name] || '').toLowerCase());
  }
}

export const aiAgentsDebug = new AiAgentsDebugLogger();
