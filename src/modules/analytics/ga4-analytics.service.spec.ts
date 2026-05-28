import { Ga4AnalyticsService } from './ga4-analytics.service';

const makeResponse = (
  input: {
    ok?: boolean;
    status?: number;
    body?: unknown;
  } = {},
): Response =>
  ({
    ok: input.ok ?? true,
    status: input.status ?? 204,
    json: jest.fn().mockResolvedValue(input.body ?? {}),
  }) as unknown as Response;

describe('Ga4AnalyticsService', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.GA4_ENABLED = 'true';
    process.env.GA4_MEASUREMENT_ID = 'G-TEST123';
    process.env.GA4_API_SECRET = 'test-secret';
    global.fetch = jest.fn().mockResolvedValue(makeResponse()) as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('skips when GA4 is disabled', async () => {
    process.env.GA4_ENABLED = 'false';
    const service = new Ga4AnalyticsService();

    const result = await service.trackEvent({
      name: 'workspace_created',
      userId: 'user_123',
    });

    expect(result).toEqual({ sent: false, reason: 'disabled' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends a sanitized web stream payload to GA4', async () => {
    const service = new Ga4AnalyticsService();

    const result = await service.trackEvent({
      name: 'workspace_created',
      userId: 'user_123',
      params: {
        workspace_id: 'workspace_123',
        plan: 'growth',
        seat_count: 4,
        email: 'private@example.com',
        ga_reserved: 'drop-me',
        long_value: 'x'.repeat(120),
      },
      userProperties: {
        account_tier: 'growth',
        user_id: 'drop-me',
      },
      consent: {
        adUserData: 'DENIED',
        adPersonalization: 'DENIED',
      },
    });

    expect(result).toMatchObject({ sent: true, status: 204, debug: false });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body)) as {
      client_id: string;
      user_id: string;
      events: Array<{
        name: string;
        params: Record<string, string | number | boolean>;
      }>;
      user_properties: Record<string, { value: string | number | boolean }>;
      consent: {
        ad_user_data: string;
        ad_personalization: string;
      };
    };

    expect(url).toContain('/mp/collect?');
    expect(url).toContain('measurement_id=G-TEST123');
    expect(url).toContain('api_secret=test-secret');
    expect(init.method).toBe('POST');
    expect(body.client_id).toBe('user_123');
    expect(body.user_id).toBe('user_123');
    expect(body.events[0]).toMatchObject({
      name: 'workspace_created',
      params: {
        workspace_id: 'workspace_123',
        plan: 'growth',
        seat_count: 4,
        long_value: 'x'.repeat(100),
      },
    });
    expect(body.events[0].params.email).toBeUndefined();
    expect(body.events[0].params.ga_reserved).toBeUndefined();
    expect(body.user_properties.account_tier.value).toBe('growth');
    expect(body.user_properties.user_id).toBeUndefined();
    expect(body.consent).toEqual({
      ad_user_data: 'DENIED',
      ad_personalization: 'DENIED',
    });
  });

  it('uses the debug endpoint and returns validation messages', async () => {
    const validationMessages = [
      {
        fieldPath: 'events[0].params.bad',
        description: 'Invalid parameter',
        validationCode: 'VALUE_INVALID',
      },
    ];
    global.fetch = jest.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: { validationMessages },
      }),
    ) as unknown as typeof fetch;
    const service = new Ga4AnalyticsService();

    const result = await service.trackEvent({
      name: 'sign_up',
      userId: 'user_123',
      debug: true,
    });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body)) as {
      validation_behavior: string;
    };

    expect(result).toEqual({
      sent: true,
      status: 200,
      debug: true,
      validationMessages,
    });
    expect(url).toContain('/debug/mp/collect?');
    expect(body.validation_behavior).toBe('ENFORCE_RECOMMENDATIONS');
  });

  it('rejects invalid or reserved event names before sending', async () => {
    const service = new Ga4AnalyticsService();

    await expect(
      service.trackEvent({ name: 'session_start', userId: 'user_123' }),
    ).resolves.toEqual({
      sent: false,
      reason: 'invalid_event_name',
    });
    await expect(
      service.trackEvent({ name: '123_bad', userId: 'user_123' }),
    ).resolves.toEqual({
      sent: false,
      reason: 'invalid_event_name',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('requires a user id, client id, or configured default client id', async () => {
    const service = new Ga4AnalyticsService();

    const result = await service.trackEvent({
      name: 'backend_health_check',
    });

    expect(result).toEqual({ sent: false, reason: 'missing_identity' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
