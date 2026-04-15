export function resolveAppUrl(requestOrigin?: string) {
  const base = process.env.APP_URL ?? requestOrigin ?? 'http://localhost:3000';
  return base.replace(/\/api\/?$/, '').replace(/\/$/, '');
}

export function resolveCallbackUrl(
  provider: 'instagram' | 'messenger' | 'whatsapp',
  requestOrigin?: string,
) {
  return `${resolveAppUrl(requestOrigin)}/api/channels/${provider}/auth/callback`;
}
