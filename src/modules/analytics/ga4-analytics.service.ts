import { Injectable, Logger } from '@nestjs/common';

type Ga4ParamValue = string | number | boolean | null | undefined;
type Ga4CleanParamValue = string | number | boolean;

export type Ga4EventParams = Record<string, Ga4ParamValue>;
export type Ga4UserProperties = Record<string, Ga4ParamValue>;

export interface Ga4Consent {
  adUserData?: 'GRANTED' | 'DENIED';
  adPersonalization?: 'GRANTED' | 'DENIED';
}

export interface Ga4TrackEventInput {
  name: string;
  params?: Ga4EventParams;
  userId?: string | null;
  clientId?: string | null;
  timestampMicros?: number;
  userProperties?: Ga4UserProperties;
  consent?: Ga4Consent;
  debug?: boolean;
}

export type Ga4SkippedReason =
  | 'disabled'
  | 'not_configured'
  | 'invalid_event_name'
  | 'missing_identity'
  | 'request_failed'
  | 'http_error';

export interface Ga4ValidationMessage {
  fieldPath?: string;
  description?: string;
  validationCode?: string;
}

export type Ga4TrackResult =
  | {
      sent: true;
      status: number;
      debug: boolean;
      validationMessages?: Ga4ValidationMessage[];
    }
  | {
      sent: false;
      reason: Ga4SkippedReason;
      status?: number;
      debug?: boolean;
      validationMessages?: Ga4ValidationMessage[];
    };

interface Ga4Config {
  enabled: boolean;
  measurementId: string;
  apiSecret: string;
  endpointBase: string;
  debug: boolean;
  defaultClientId: string;
  timeoutMs: number;
}

interface Ga4MeasurementEvent {
  name: string;
  params?: Record<string, Ga4CleanParamValue>;
  timestamp_micros?: number;
}

interface Ga4Payload {
  client_id: string;
  user_id?: string;
  timestamp_micros?: number;
  user_properties?: Record<string, { value: Ga4CleanParamValue }>;
  consent?: {
    ad_user_data?: 'GRANTED' | 'DENIED';
    ad_personalization?: 'GRANTED' | 'DENIED';
  };
  validation_behavior?: 'ENFORCE_RECOMMENDATIONS';
  events: Ga4MeasurementEvent[];
}

const EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const PARAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const USER_PROPERTY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
const SENSITIVE_PARAM_NAME_PATTERN =
  /(email|phone|password|token|secret|credential|authorization|cookie|raw_message|message_body|message_text)/i;

const RESERVED_EVENT_NAMES = new Set([
  'ad_activeview',
  'ad_click',
  'ad_exposure',
  'ad_query',
  'ad_reward',
  'adunit_exposure',
  'app_clear_data',
  'app_exception',
  'app_install',
  'app_remove',
  'app_store_refund',
  'app_update',
  'app_upgrade',
  'dynamic_link_app_open',
  'dynamic_link_app_update',
  'dynamic_link_first_open',
  'error',
  'firebase_campaign',
  'firebase_in_app_message_action',
  'firebase_in_app_message_dismiss',
  'firebase_in_app_message_impression',
  'first_open',
  'first_visit',
  'notification_dismiss',
  'notification_foreground',
  'notification_open',
  'notification_receive',
  'notification_send',
  'os_update',
  'session_start',
  'user_engagement',
]);

@Injectable()
export class Ga4AnalyticsService {
  private readonly logger = new Logger(Ga4AnalyticsService.name);

  async trackEvent(input: Ga4TrackEventInput): Promise<Ga4TrackResult> {
    const config = this.getConfig();

    if (!config.enabled) {
      return { sent: false, reason: 'disabled' };
    }

    if (!config.measurementId || !config.apiSecret) {
      return { sent: false, reason: 'not_configured' };
    }

    const eventName = input.name.trim();
    if (!this.isValidEventName(eventName)) {
      return { sent: false, reason: 'invalid_event_name' };
    }

    const clientId = this.resolveClientId(input, config);
    if (!clientId) {
      return { sent: false, reason: 'missing_identity' };
    }

    const debug = input.debug ?? config.debug;
    const payload = this.buildPayload(input, eventName, clientId, debug);

    try {
      const response = await this.postEvent(config, payload, debug);
      const validationMessages = debug
        ? await this.readValidationMessages(response)
        : undefined;

      if (!response.ok) {
        this.logger.warn(
          `GA4 event ${eventName} failed with status ${response.status}`,
        );
        return {
          sent: false,
          reason: 'http_error',
          status: response.status,
          debug,
          validationMessages,
        };
      }

      return {
        sent: true,
        status: response.status,
        debug,
        validationMessages,
      };
    } catch (error) {
      this.logger.warn(
        `GA4 event ${eventName} failed: ${this.getErrorMessage(error)}`,
      );
      return { sent: false, reason: 'request_failed', debug };
    }
  }

  trackEventAndForget(input: Ga4TrackEventInput): void {
    void this.trackEvent(input);
  }

  private getConfig(): Ga4Config {
    const endpointBase =
      process.env.GA4_ENDPOINT_BASE?.trim() ||
      'https://www.google-analytics.com';

    return {
      enabled: this.parseBoolean(process.env.GA4_ENABLED, false),
      measurementId: process.env.GA4_MEASUREMENT_ID?.trim() ?? '',
      apiSecret: process.env.GA4_API_SECRET?.trim() ?? '',
      endpointBase: endpointBase.replace(/\/+$/, ''),
      debug: this.parseBoolean(process.env.GA4_DEBUG, false),
      defaultClientId: process.env.GA4_DEFAULT_CLIENT_ID?.trim() ?? '',
      timeoutMs: this.parsePositiveNumber(process.env.GA4_TIMEOUT_MS, 2000),
    };
  }

  private buildPayload(
    input: Ga4TrackEventInput,
    eventName: string,
    clientId: string,
    debug: boolean,
  ): Ga4Payload {
    const params = this.normalizeParams(input.params, 40, 100);
    const userProperties = this.normalizeUserProperties(input.userProperties);
    const consent = this.normalizeConsent(input.consent);
    const timestampMicros = this.normalizeTimestamp(input.timestampMicros);

    return {
      client_id: clientId,
      ...(input.userId?.trim() ? { user_id: input.userId.trim() } : {}),
      ...(timestampMicros ? { timestamp_micros: timestampMicros } : {}),
      ...(Object.keys(userProperties).length > 0
        ? { user_properties: userProperties }
        : {}),
      ...(consent ? { consent } : {}),
      ...(debug ? { validation_behavior: 'ENFORCE_RECOMMENDATIONS' } : {}),
      events: [
        {
          name: eventName,
          ...(Object.keys(params).length > 0 ? { params } : {}),
        },
      ],
    };
  }

  private async postEvent(
    config: Ga4Config,
    payload: Ga4Payload,
    debug: boolean,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const url = new URL(
        `${config.endpointBase}/${debug ? 'debug/mp/collect' : 'mp/collect'}`,
      );
      url.searchParams.set('measurement_id', config.measurementId);
      url.searchParams.set('api_secret', config.apiSecret);

      return await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveClientId(
    input: Ga4TrackEventInput,
    config: Ga4Config,
  ): string {
    const explicitClientId = input.clientId?.trim();
    if (explicitClientId) {
      return explicitClientId;
    }

    const userId = input.userId?.trim();
    if (userId) {
      return userId;
    }

    return config.defaultClientId;
  }

  private normalizeParams(
    params: Ga4EventParams | undefined,
    maxNameLength: number,
    maxValueLength: number,
  ): Record<string, Ga4CleanParamValue> {
    const normalized: Record<string, Ga4CleanParamValue> = {};

    for (const [rawName, rawValue] of Object.entries(params ?? {})) {
      if (Object.keys(normalized).length >= 25) {
        break;
      }

      const name = rawName.trim();
      const value = this.normalizeValue(rawValue, maxValueLength);

      if (
        !value.valid ||
        name.length > maxNameLength ||
        !PARAM_NAME_PATTERN.test(name) ||
        this.isReservedParamName(name) ||
        SENSITIVE_PARAM_NAME_PATTERN.test(name)
      ) {
        continue;
      }

      normalized[name] = value.value;
    }

    return normalized;
  }

  private normalizeUserProperties(
    userProperties: Ga4UserProperties | undefined,
  ): Record<string, { value: Ga4CleanParamValue }> {
    const normalized: Record<string, { value: Ga4CleanParamValue }> = {};

    for (const [rawName, rawValue] of Object.entries(userProperties ?? {})) {
      if (Object.keys(normalized).length >= 25) {
        break;
      }

      const name = rawName.trim();
      const value = this.normalizeValue(rawValue, 36);

      if (
        !value.valid ||
        !USER_PROPERTY_NAME_PATTERN.test(name) ||
        this.isReservedParamName(name)
      ) {
        continue;
      }

      normalized[name] = { value: value.value };
    }

    return normalized;
  }

  private normalizeValue(
    value: Ga4ParamValue,
    maxStringLength: number,
  ):
    | { valid: true; value: Ga4CleanParamValue }
    | { valid: false; value?: never } {
    if (value === undefined || value === null) {
      return { valid: false };
    }

    if (typeof value === 'number') {
      return Number.isFinite(value)
        ? { valid: true, value }
        : { valid: false };
    }

    if (typeof value === 'boolean') {
      return { valid: true, value };
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return { valid: false };
    }

    return {
      valid: true,
      value:
        trimmed.length > maxStringLength
          ? trimmed.slice(0, maxStringLength)
          : trimmed,
    };
  }

  private normalizeConsent(
    consent: Ga4Consent | undefined,
  ): Ga4Payload['consent'] | undefined {
    if (!consent) {
      return undefined;
    }

    const normalized: Ga4Payload['consent'] = {};

    if (consent.adUserData) {
      normalized.ad_user_data = consent.adUserData;
    }

    if (consent.adPersonalization) {
      normalized.ad_personalization = consent.adPersonalization;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeTimestamp(value: number | undefined): number | undefined {
    return Number.isFinite(value) && value && value > 0
      ? Math.floor(value)
      : undefined;
  }

  private isValidEventName(name: string): boolean {
    return EVENT_NAME_PATTERN.test(name) && !RESERVED_EVENT_NAMES.has(name);
  }

  private isReservedParamName(name: string): boolean {
    return (
      name === 'firebase_conversion' ||
      name.startsWith('_') ||
      name.startsWith('firebase_') ||
      name.startsWith('ga_') ||
      name.startsWith('google_') ||
      name.startsWith('gtag.')
    );
  }

  private async readValidationMessages(
    response: Response,
  ): Promise<Ga4ValidationMessage[] | undefined> {
    try {
      const value = (await response.json()) as unknown;
      if (!this.isRecord(value) || !Array.isArray(value.validationMessages)) {
        return undefined;
      }

      return value.validationMessages
        .filter(this.isRecord)
        .map((message) => ({
          fieldPath: this.readOptionalString(message, 'fieldPath'),
          description: this.readOptionalString(message, 'description'),
          validationCode: this.readOptionalString(message, 'validationCode'),
        }));
    } catch {
      return undefined;
    }
  }

  private readOptionalString(
    value: Record<string, unknown>,
    key: string,
  ): string | undefined {
    return typeof value[key] === 'string' ? value[key] : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) {
      return fallback;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }

  private parsePositiveNumber(
    value: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
