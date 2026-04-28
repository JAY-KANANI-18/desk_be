export type EmailTemplateName =
  | 'billing-alert'
  | 'email-verification'
  | 'magic-link'
  | 'notification'
  | 'otp'
  | 'reset-password'
  | 'welcome'
  | 'workspace-invite';

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

type BaseTemplateInput = {
  appUrl?: string;
  preheader?: string;
};

type ActionInput = {
  label: string;
  url: string;
};

export type EmailTemplateInput =
  | (BaseTemplateInput & {
      template: 'otp';
      code: string;
      purposeLabel: string;
      expiresInMinutes: number;
    })
  | (BaseTemplateInput & {
      template: 'magic-link';
      magicLink: string;
      expiresInMinutes: number;
    })
  | (BaseTemplateInput & {
      template: 'reset-password';
      code: string;
      resetLink: string;
      expiresInMinutes: number;
    })
  | (BaseTemplateInput & {
      template: 'email-verification';
      code: string;
      verifyLink: string;
      expiresInMinutes: number;
    })
  | (BaseTemplateInput & {
      template: 'workspace-invite';
      inviteLink: string;
      organizationName?: string | null;
      workspaceName?: string | null;
      role?: string | null;
      expiresInMinutes?: number;
    })
  | (BaseTemplateInput & {
      template: 'welcome';
      firstName?: string | null;
      actionUrl: string;
    })
  | (BaseTemplateInput & {
      template: 'notification';
      title: string;
      body: string;
      action?: ActionInput;
    })
  | (BaseTemplateInput & {
      template: 'billing-alert';
      title: string;
      body: string;
      action?: ActionInput;
      amountLabel?: string | null;
      dueDateLabel?: string | null;
    });

const brand = {
  name: 'AxoDesk',
  primary: '#4f46e5',
  primaryDark: '#3730a3',
  background: '#f8fafc',
  border: '#e2e8f0',
  text: '#0f172a',
  muted: '#64748b',
  subtle: '#f1f5f9',
  success: '#059669',
  warning: '#d97706',
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function compactText(parts: Array<string | undefined | null | false>) {
  return parts.filter(Boolean).join('\n\n');
}

function paragraph(value: string) {
  return `<p style="margin:0 0 16px;color:${brand.muted};font-size:15px;line-height:24px;">${escapeHtml(value)}</p>`;
}

function actionButton(action: ActionInput) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 6px;">
  <tr>
    <td style="border-radius:12px;background:${brand.primary};">
      <a href="${escapeAttribute(action.url)}" style="display:inline-block;padding:13px 20px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:12px;">${escapeHtml(action.label)}</a>
    </td>
  </tr>
</table>`;
}

function codeBlock(code: string) {
  return `<div style="margin:22px 0;border:1px solid ${brand.border};border-radius:16px;background:${brand.subtle};padding:18px;text-align:center;">
  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:30px;font-weight:800;letter-spacing:6px;color:${brand.text};">${escapeHtml(code)}</div>
</div>`;
}

function detailList(items: Array<{ label: string; value?: string | null }>) {
  const rows = items
    .filter((item) => item.value)
    .map(
      (item) => `<tr>
  <td style="padding:8px 0;color:${brand.muted};font-size:13px;">${escapeHtml(item.label)}</td>
  <td style="padding:8px 0;color:${brand.text};font-size:13px;font-weight:700;text-align:right;">${escapeHtml(item.value ?? '')}</td>
</tr>`,
    )
    .join('');

  if (!rows) {
    return '';
  }

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0;border-top:1px solid ${brand.border};border-bottom:1px solid ${brand.border};">
${rows}
</table>`;
}

function renderLayout(input: {
  subject: string;
  preheader: string;
  heading: string;
  bodyHtml: string;
  footerNote?: string;
  appUrl?: string;
  text: string;
}) {
  const logoUrl = `${(input.appUrl ?? process.env.FRONTEND_URL ?? process.env.APP_URL ?? 'https://app.axodesk.com').replace(/\/$/, '')}/axodesk-logo.png`;
  const safePreheader = escapeHtml(input.preheader);

  return {
    subject: input.subject,
    text: input.text,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeHtml(input.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${brand.background};font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:${brand.text};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safePreheader}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${brand.background};">
      <tr>
        <td align="center" style="padding:32px 14px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;">
            <tr>
              <td style="padding:0 0 18px;text-align:center;">
                <img src="${escapeAttribute(logoUrl)}" width="140" alt="${brand.name}" style="display:inline-block;border:0;outline:none;text-decoration:none;max-width:140px;height:auto;">
              </td>
            </tr>
            <tr>
              <td style="border:1px solid ${brand.border};border-radius:24px;background:#ffffff;padding:34px 30px;box-shadow:0 24px 70px rgba(15,23,42,0.08);">
                <h1 style="margin:0 0 14px;color:${brand.text};font-size:26px;line-height:32px;font-weight:800;">${escapeHtml(input.heading)}</h1>
                ${input.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 8px 0;text-align:center;color:${brand.muted};font-size:12px;line-height:18px;">
                ${escapeHtml(input.footerNote ?? `You received this email because your ${brand.name} account or workspace triggered this message.`)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };
}

export function renderEmailTemplate(input: EmailTemplateInput): RenderedEmail {
  switch (input.template) {
    case 'otp': {
      const subject = `Your AxoDesk ${input.purposeLabel} code`;
      const preheader = `Use code ${input.code} within ${input.expiresInMinutes} minutes.`;
      return renderLayout({
        subject,
        preheader,
        heading: 'Your secure code',
        appUrl: input.appUrl,
        bodyHtml: [
          paragraph(`Use this one-time code to ${input.purposeLabel}.`),
          codeBlock(input.code),
          paragraph(`This code expires in ${input.expiresInMinutes} minutes.`),
        ].join(''),
        text: compactText([
          `Use this one-time code to ${input.purposeLabel}: ${input.code}.`,
          `It expires in ${input.expiresInMinutes} minutes.`,
        ]),
      });
    }

    case 'magic-link': {
      const subject = 'Your AxoDesk magic link';
      return renderLayout({
        subject,
        preheader: `This secure sign-in link expires in ${input.expiresInMinutes} minutes.`,
        heading: 'Sign in securely',
        appUrl: input.appUrl,
        bodyHtml: [
          paragraph('Use this secure link to sign in to AxoDesk.'),
          actionButton({ label: 'Sign in to AxoDesk', url: input.magicLink }),
          paragraph(`This link expires in ${input.expiresInMinutes} minutes.`),
        ].join(''),
        text: compactText([
          `Use this secure link to sign in to AxoDesk: ${input.magicLink}`,
          `It expires in ${input.expiresInMinutes} minutes.`,
        ]),
      });
    }

    case 'reset-password': {
      const subject = 'Reset your AxoDesk password';
      return renderLayout({
        subject,
        preheader: `Use code ${input.code} or the secure link to reset your password.`,
        heading: 'Reset your password',
        appUrl: input.appUrl,
        bodyHtml: [
          paragraph('Use this reset code or open the secure reset link below.'),
          codeBlock(input.code),
          actionButton({ label: 'Reset password', url: input.resetLink }),
          paragraph(`This code and link expire in ${input.expiresInMinutes} minutes.`),
        ].join(''),
        text: compactText([
          `Use this reset code: ${input.code}.`,
          `Or reset with this secure link: ${input.resetLink}`,
          `They expire in ${input.expiresInMinutes} minutes.`,
        ]),
      });
    }

    case 'email-verification': {
      const subject = 'Verify your AxoDesk email';
      return renderLayout({
        subject,
        preheader: `Use code ${input.code} or verify instantly with the secure link.`,
        heading: 'Verify your email',
        appUrl: input.appUrl,
        bodyHtml: [
          paragraph('Use this verification code or open the secure verification link below.'),
          codeBlock(input.code),
          actionButton({ label: 'Verify email', url: input.verifyLink }),
          paragraph(`This code expires in ${input.expiresInMinutes} minutes.`),
        ].join(''),
        text: compactText([
          `Use this verification code: ${input.code}.`,
          `Or verify using this secure link: ${input.verifyLink}`,
          `The code expires in ${input.expiresInMinutes} minutes.`,
        ]),
      });
    }

    case 'workspace-invite': {
      const subject = 'You have been invited to AxoDesk';
      const target = input.workspaceName ?? input.organizationName ?? 'an AxoDesk workspace';
      return renderLayout({
        subject,
        preheader: `Accept your invitation to ${target}.`,
        heading: 'Join your team on AxoDesk',
        appUrl: input.appUrl,
        bodyHtml: [
          paragraph(`You have been invited to ${target}.`),
          detailList([
            { label: 'Organization', value: input.organizationName },
            { label: 'Workspace', value: input.workspaceName },
            { label: 'Role', value: input.role },
          ]),
          actionButton({ label: 'Accept invitation', url: input.inviteLink }),
          input.expiresInMinutes
            ? paragraph(`This invitation expires in ${input.expiresInMinutes} minutes.`)
            : '',
        ].join(''),
        text: compactText([
          `You have been invited to ${target}.`,
          input.role ? `Role: ${input.role}` : undefined,
          `Accept your invitation here: ${input.inviteLink}`,
        ]),
      });
    }

    case 'welcome': {
      const name = input.firstName?.trim() || 'there';
      const subject = 'Welcome to AxoDesk';
      return renderLayout({
        subject,
        preheader: 'Your workspace is ready for customer conversations.',
        heading: `Welcome, ${name}`,
        appUrl: input.appUrl,
        bodyHtml: [
          paragraph('Your AxoDesk workspace is ready. Start by connecting channels, inviting teammates, and opening the inbox.'),
          actionButton({ label: 'Open AxoDesk', url: input.actionUrl }),
        ].join(''),
        text: compactText([
          `Welcome, ${name}. Your AxoDesk workspace is ready.`,
          `Open AxoDesk: ${input.actionUrl}`,
        ]),
      });
    }

    case 'notification': {
      return renderLayout({
        subject: input.title,
        preheader: input.body,
        heading: input.title,
        appUrl: input.appUrl,
        bodyHtml: [paragraph(input.body), input.action ? actionButton(input.action) : ''].join(''),
        text: compactText([input.title, input.body, input.action?.url]),
      });
    }

    case 'billing-alert': {
      return renderLayout({
        subject: input.title,
        preheader: input.body,
        heading: input.title,
        appUrl: input.appUrl,
        bodyHtml: [
          paragraph(input.body),
          detailList([
            { label: 'Amount', value: input.amountLabel },
            { label: 'Due date', value: input.dueDateLabel },
          ]),
          input.action ? actionButton(input.action) : '',
        ].join(''),
        text: compactText([
          input.title,
          input.body,
          input.amountLabel ? `Amount: ${input.amountLabel}` : undefined,
          input.dueDateLabel ? `Due date: ${input.dueDateLabel}` : undefined,
          input.action?.url,
        ]),
      });
    }
  }
}
