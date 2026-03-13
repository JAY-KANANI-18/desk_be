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
} from '../../channel-provider.interface';

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
    const from      = body.sender ?? body.from ?? '';
    const to        = body.recipient ?? body.To ?? '';
    const subject   = body.subject ?? body.Subject ?? '';
    const textBody  = await this.extractReply(body['body-plain'] ?? body['stripped-text'] ?? '') ;
    const htmlBody  = body['body-html'] ?? '';
    const messageId = body['Message-Id'] ?? body['message-id'] ?? `mailgun-${Date.now()}`;

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
        from, to, htmlBody, senderName,
        messageId:  body['Message-Id']  ?? body['message-id'],
        inReplyTo:  body['In-Reply-To'] ?? body['in-reply-to'],
        references: body['References']  ?? body['references'],
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
    const result: string[] = [];
    for (const line of text.split('\n')) {
      if (stopPatterns.some(p => p.test(line.trim()))) break;
      result.push(line);
    }
    return result.join('\n').trim();
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
      host:   config.smtpserver,
      port:   config.smtpport,
      secure: config.encryption === 'SSL/TLS',
      auth: { user: config.userId || config.emailaddress, pass: config.password },
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
}