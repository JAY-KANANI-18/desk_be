const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const OAUTH_CALLBACK_RESPONSE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'unsafe-none',
} as const;

export function buildOAuthCallbackPage(input: {
  provider: string;
  providerKey?: string;
  status: 'success' | 'error';
  title?: string;
  message: string;
  redirectUri: string;
  payload?: Record<string, unknown>;
  redirectPayload?: Record<string, string | undefined>;
}) {
  const title =
    input.title ??
    (input.status === 'success'
      ? `${input.provider} connected`
      : `${input.provider} connection failed`);
  const callbackPayload = JSON.stringify({
    type: 'OAUTH_CALLBACK',
    provider: input.provider,
    providerKey: input.providerKey ?? input.provider,
    status: input.status,
    message: input.message,
    ...(input.payload ?? {}),
  }).replace(/</g, '\\u003c');
  const redirectUri = buildRedirectUri(input.redirectUri, input.redirectPayload);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Arial, sans-serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f4f6fb;
        color: #111827;
      }

      .card {
        width: min(440px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 18px;
        background: white;
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
        text-align: center;
      }

      .status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 52px;
        height: 52px;
        margin-bottom: 16px;
        border-radius: 999px;
        font-size: 24px;
        background: ${input.status === 'success' ? '#dcfce7' : '#fee2e2'};
      }

      h1 {
        margin: 0;
        font-size: 20px;
      }

      p {
        margin: 10px 0 0;
        color: #4b5563;
        line-height: 1.5;
      }

      a {
        color: #2563eb;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="status">${input.status === 'success' ? 'OK' : '!'}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(input.message)}</p>
      <p>You can close this window if nothing happens automatically.</p>
      <p><a href="${escapeHtml(redirectUri)}">Return to the app</a></p>
    </main>
<script>
  var oauthDeliveredToOpener = false;
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        ${callbackPayload},
        "*"
      );
      oauthDeliveredToOpener = true;
    }
  } catch (e) {}

  setTimeout(() => {
    if (oauthDeliveredToOpener) {
      window.close();
      return;
    }
    window.location.replace(${JSON.stringify(redirectUri)});
  }, 300);

  setTimeout(() => {
    window.location.href = ${JSON.stringify(redirectUri)};
  }, 1200);
</script>
  </body>
</html>`;
}

function buildRedirectUri(
  redirectUri: string,
  payload: Record<string, string | undefined> | undefined,
) {
  if (!payload) {
    return redirectUri;
  }

  try {
    const url = new URL(redirectUri);
    Object.entries(payload).forEach(([key, value]) => {
      if (value) {
        url.searchParams.set(key, value);
      }
    });
    return url.toString();
  } catch {
    const params = new URLSearchParams();
    Object.entries(payload).forEach(([key, value]) => {
      if (value) {
        params.set(key, value);
      }
    });
    const query = params.toString();
    return query
      ? `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}${query}`
      : redirectUri;
  }
}
