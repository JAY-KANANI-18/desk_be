const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function buildOAuthCallbackPage(input: {
  provider: string;
  status: 'success' | 'error';
  message: string;
  redirectUri: string;
}) {
  const title =
    input.status === 'success'
      ? `${input.provider} connected`
      : `${input.provider} connection failed`;

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
      <p><a href="${escapeHtml(input.redirectUri)}">Return to the app</a></p>
    </main>
<script>
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        {
          type: "OAUTH_CALLBACK",
          provider: "${input.provider}",
          status: "${input.status}"
        },
        "*"
      );
    }
  } catch (e) {}

  setTimeout(() => {
    window.close();
  }, 300);

  setTimeout(() => {
    window.location.href = ${JSON.stringify(input.redirectUri)};
  }, 1200);
</script>
  </body>
</html>`;
}
