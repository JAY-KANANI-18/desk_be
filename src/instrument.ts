import 'dotenv/config';

import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const parseSampleRate = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
};

const sentryDsn = process.env.SENTRY_DSN?.trim();

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    integrations: [nodeProfilingIntegration()],
    enableLogs: parseBoolean(process.env.SENTRY_ENABLE_LOGS, true),
    tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 1),
    profileSessionSampleRate: parseSampleRate(process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE, 1),
    profileLifecycle: process.env.SENTRY_PROFILE_LIFECYCLE === 'manual' ? 'manual' : 'trace',
    sendDefaultPii: parseBoolean(process.env.SENTRY_SEND_DEFAULT_PII, true),
  });
}
