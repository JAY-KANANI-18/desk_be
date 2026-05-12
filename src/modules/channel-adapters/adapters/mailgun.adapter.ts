// modules/channels/providers/mailgun/mailgun.provider.ts

import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import axios from 'axios';
import {
  ChannelProvider,
  ParsedInbound,
  ParsedAttachment,
  DownloadResult,
  ContactProfile,
  ValidateOutboundOpts,
} from '../channel-adapter.interface';

function mimeToType(mime: string): ParsedAttachment['type'] {
  if (!mime) return 'unsupported';
  const m = mime.toLowerCase();
  if (m === 'image/gif')  return 'gif';
  if (m.startsWith('image/'))  return 'image';
  if (m.startsWith('video/'))  return 'video';
  if (m === 'audio/ogg' || m === 'audio/amr' || m === 'audio/opus') return 'voice';
  if (m.startsWith('audio/'))  return 'audio';
  if (m === 'text/vcard' || m === 'text/x-vcard') return 'contact';
  if (
    m.includes('pdf') || m.includes('word') || m.includes('excel') ||
    m.includes('sheet') || m.includes('powerpoint') || m.includes('presentation') ||
    m.startsWith('text/') || m.includes('zip') || m.includes('json') || m.includes('xml')
  ) return 'document';
  return 'document';
}

@Injectable()
export class MailgunProvider implements ChannelProvider {
  readonly type = 'email';
  private readonly logger = new Logger(MailgunProvider.name);

  // ─── parseWebhook ──────────────────────────────────────────────────────────

  async parseWebhook(body: any): Promise<ParsedInbound[]> {
    if (!body) return [];
    try {
      const parsed = await this.parseBody(body);
      return parsed ? [parsed] : [];
    } catch (e) {
      this.logger.error(`Mailgun parse error: ${e.message}`);
      return [];
    }
  }

  private async parseBody(body: any): Promise<ParsedInbound | null> {
    const envelopeSender = this.stringField(body.sender) ?? this.stringField(body['X-Envelope-From']);
    const from =
      this.stringField(body.From) ??
      this.stringField(body.from) ??
      this.getMessageHeader(body, 'From') ??
      envelopeSender ??
      '';
    const to =
      this.stringField(body.To) ??
      this.stringField(body.to) ??
      this.getMessageHeader(body, 'To') ??
      this.stringField(body.recipient) ??
      '';
    const cc =
      this.stringField(body.Cc) ??
      this.stringField(body.cc) ??
      this.getMessageHeader(body, 'Cc');
    const subject =
      this.stringField(body.Subject) ??
      this.stringField(body.subject) ??
      this.getMessageHeader(body, 'Subject') ??
      '';
    const plainBody = body['body-plain'] ?? body['stripped-text'] ?? '';
    const textBody  = await this.extractReply(plainBody);
    const htmlBody  = this.selectHtmlBody(body, plainBody);
    const messageId =
      this.stringField(body['Message-Id']) ??
      this.stringField(body['message-id']) ??
      this.getMessageHeader(body, 'Message-Id') ??
      `mailgun-${Date.now()}`;
    const inReplyTo =
      this.stringField(body['In-Reply-To']) ??
      this.stringField(body['in-reply-to']) ??
      this.getMessageHeader(body, 'In-Reply-To');
    const references =
      this.stringField(body.References) ??
      this.stringField(body.references) ??
      this.getMessageHeader(body, 'References');

    const senderEmail = this.extractEmail(from);
    const senderName  = this.extractName(from);

    const attachments: ParsedAttachment[] = [];

    // File attachments
    const count = parseInt(body['attachment-count'] ?? '0', 10);
    for (let i = 1; i <= count; i++) {
      const att = this.parseFileField(body[`attachment-${i}`]);
      if (att) attachments.push(att);
    }

    // Inline CID images
    const cidMap = this.parseCidMap(body['content-id-map']);
    for (const [cid, fieldName] of Object.entries(cidMap)) {
      const att = this.parseFileField(body[fieldName as string]);
      if (att) attachments.push({ ...att, caption: `[inline:${cid}]` });
    }

    // Multer files injected by controller
    for (const file of body.files ?? []) {
      const att = this.parseMulterFile(file);
      if (att) attachments.push(att);
    }

    return {
      externalId:        messageId,
      contactIdentifier: senderEmail,
      direction:         'incoming',
      messageType:       attachments.length > 0 ? attachments[0].type : 'text',
      text:              textBody || (htmlBody ? '[HTML body]' : undefined),
      subject,
      attachments,
      metadata: {
        email: {
          from,
          to,
          cc,
          subject,
          htmlBody,
          senderName,
          envelopeSender,
          messageId,
          inReplyTo,
          references,
        },
        from,
        to,
        htmlBody,
        senderName,
        envelopeSender,
        messageId,
        inReplyTo,
        references,
      },
      raw: body,
    };
  }

  

  // ─── downloadMedia ─────────────────────────────────────────────────────────

  async downloadMedia(channel: any, mediaId: string): Promise<DownloadResult> {
    const apiKey = channel.config?.apiKey;
    const { data, headers } = await axios.get<ArrayBuffer>(mediaId, {
      auth:         apiKey ? { username: 'api', password: apiKey } : undefined,
      responseType: 'arraybuffer',
    });
    return {
      buffer:   data,
      mimeType: (headers['content-type'] as string)?.split(';')[0].trim() ?? 'application/octet-stream',
    };
  }

  async getContactProfile(_identifier: string): Promise<ContactProfile> {
    return {}; // email has no live profile API
  }

  // ─── validateOutbound ──────────────────────────────────────────────────────

  validateOutbound({ channel, contactChannel, contact }: ValidateOutboundOpts): void {
    const { BadRequestException } = require('@nestjs/common');
    const config = channel.config as any;

    if (!config?.smtpserver || !config?.password) {
      throw new BadRequestException({
        code:      'CHANNEL_MISSING_CREDENTIAL',
        message:   'SMTP credentials are incomplete. Check the email channel settings.',
        retryable: false,
      });
    }

    const to = contactChannel?.identifier ?? contact.email;
    if (!to) {
      throw new BadRequestException({
        code:      'CONTACT_NO_IDENTIFIER',
        message:   'This contact has no email address. Add one to the contact first.',
        retryable: false,
      });
    }
  }

  // ─── normaliseError ────────────────────────────────────────────────────────

  normaliseError(err: any): never {
    const { BadRequestException } = require('@nestjs/common');
    const msg: string    = err?.message ?? '';
    const code: number   = err?.responseCode ?? 0;

    if (msg.includes('Invalid login') || msg.includes('Authentication failed') || msg.includes('Username and Password not accepted') || code === 535)
      throw new BadRequestException({ code: 'EMAIL_AUTH_FAILED', message: 'SMTP authentication failed. Check username and password in channel settings.', detail: msg, retryable: false });
    if (msg.includes('Recipient address rejected') || msg.includes('User unknown') || code === 550 || code === 551)
      throw new BadRequestException({ code: 'EMAIL_RECIPIENT_REJECTED', message: 'Recipient email address was rejected. Check the contact\'s email.', detail: msg, retryable: false });
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND'))
      throw new BadRequestException({ code: 'EMAIL_CONNECTION_FAILED', message: 'Could not connect to SMTP server. Check host and port in channel settings.', detail: msg, retryable: true });

    throw new BadRequestException({ code: 'PROVIDER_ERROR', message: 'Email could not be sent.', detail: msg, retryable: true });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  async extractReply(text: string): Promise<string> {
    if (!text) return '';
    const stopPatterns = [/^On .* wrote:/i, /^From:/i, /^Sent:/i, /^Subject:/i, /^--$/];
    if (this.hasForwardedMarker(text)) {
      return text.trim();
    }

    const result: string[] = [];
    for (const line of text.split('\n')) {
      if (stopPatterns.some(p => p.test(line.trim()))) break;
      result.push(line);
    }
    return result.join('\n').trim();
  }

  private selectHtmlBody(body: any, plainBody: string): string {
    const fullHtml = body['body-html'] ?? '';
    const strippedHtml = body['stripped-html'] ?? '';

    if (
      fullHtml &&
      this.hasForwardedMarker(`${plainBody}\n${fullHtml}\n${strippedHtml}`)
    ) {
      return fullHtml;
    }

    return strippedHtml || fullHtml;
  }

  private hasForwardedMarker(value: string): boolean {
    return (
      /-{2,}\s*Forwarded message\s*-{2,}/i.test(value) ||
      /Begin forwarded message:/i.test(value) ||
      /-{2,}\s*Original Message\s*-{2,}/i.test(value)
    );
  }

  private parseFileField(field: any): ParsedAttachment | null {
    if (!field) return null;
    let info: any = field;
    if (typeof field === 'string') {
      try { info = JSON.parse(field); } catch { return null; }
    }
    const mimeType = info['content-type'] ?? info.contentType ?? info.mimetype ?? 'application/octet-stream';
    const filename = info.name ?? info.filename;
    const url      = info.url;
    const size     = info.size ? parseInt(info.size, 10) : undefined;

    if (mimeType === 'text/vcard' || mimeType === 'text/x-vcard' || filename?.endsWith('.vcf'))
      return { type: 'contact', url, filename, mimeType, size };
    if (mimeType === 'text/calendar' || filename?.endsWith('.ics'))
      return { type: 'document', url, filename, mimeType, size, caption: '[Calendar invite]' };

    return { type: mimeToType(mimeType), url, filename, mimeType, size };
  }

  private parseMulterFile(file: Express.Multer.File): ParsedAttachment | null {
    if (!file) return null;
    const mimeType = file.mimetype ?? 'application/octet-stream';
    return { type: mimeToType(mimeType), mimeType, filename: file.originalname, size: file.size, url: file.path ? `file://${file.path}` : undefined };
  }

  // ─── sendMessage ───────────────────────────────────────────────────────────

  async sendMessage(channel: any, payload: any): Promise<{ externalId: string }> {
    const config = channel.config as any;

   const transporter = nodemailer.createTransport({
  host: config.smtpserver,
  port: Number(config.smtpport),
  secure: Number(config.smtpport) === 465, // ONLY true for 465
  auth: {
    user: config.userId || config.emailaddress,
    pass: config.password,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

    const attachments = (payload.attachments ?? []).map((att: any) => ({
      filename:    att.filename,
      contentType: att.mimeType,
      href:        att.url,
    }));

    const info = await transporter.sendMail({
      from:       `"${config.displayname}" <${config.emailaddress}>`,
      to:         payload.to,
      subject:    payload.subject ?? '(no subject)',
      text:       payload.text,
      html:       payload.html,
      replyTo:    config.emailaddress,
      attachments,
      headers:    payload.headers ?? {},
    });

    return { externalId: info.messageId };
  }

  private extractEmail(from: string): string {
    return from.match(/<(.+?)>/)?.[1] ?? from.trim();
  }

  private extractName(from: string): string | undefined {
    return from.match(/^(.+?)\s*</)?.[1]?.replace(/"/g, '').trim();
  }

  private parseCidMap(raw: string | undefined): Record<string, string> {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  private stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private getMessageHeader(body: any, name: string): string | undefined {
    const raw = body?.['message-headers'];
    if (!raw) return undefined;

    let headers: unknown = raw;
    if (typeof raw === 'string') {
      try {
        headers = JSON.parse(raw);
      } catch {
        return undefined;
      }
    }

    if (!Array.isArray(headers)) return undefined;

    const match = headers.find((header): header is [string, string] => (
      Array.isArray(header) &&
      typeof header[0] === 'string' &&
      typeof header[1] === 'string' &&
      header[0].toLowerCase() === name.toLowerCase()
    ));

    return match?.[1]?.trim() || undefined;
  }
}
