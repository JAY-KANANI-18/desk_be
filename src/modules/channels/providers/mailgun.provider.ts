// src/channels/providers/email-mailgun.provider.ts
//
// Handles Mailgun inbound Parse API.
// Controller passes: req.body (form fields) + req.files (Multer) merged.
// All MIME types covered: images, video, audio, documents, inline CID,
// vCard (.vcf), calendar (.ics), zip, JSON, XML.

import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import axios from 'axios';
import {
    ChannelProvider,
    ParsedInbound,
    ParsedAttachment,
    DownloadResult,
    ContactProfile,
} from '../channel-provider.interface';

// Derive our MediaType from MIME
function mimeToType(mime: string): ParsedAttachment['type'] {
    if (!mime) return 'unsupported';
    const m = mime.toLowerCase();
    if (m === 'image/gif') return 'gif';
    if (m === 'image/webp') return 'image';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m === 'audio/ogg' || m === 'audio/amr' || m === 'audio/opus') return 'voice';
    if (m.startsWith('audio/')) return 'audio';
    if (m === 'text/vcard' || m === 'text/x-vcard') return 'contact';
    if (
        m.includes('pdf') || m.includes('word') || m.includes('excel') ||
        m.includes('sheet') || m.includes('powerpoint') || m.includes('presentation') ||
        m.startsWith('text/') || m.includes('zip') || m.includes('json') || m.includes('xml')
    ) return 'document';
    return 'document'; // fallback — don't lose files
}

@Injectable()
export class EmailMailgunProvider implements ChannelProvider {
    readonly type = 'email';
    private readonly logger = new Logger(EmailMailgunProvider.name);


    async extractReply(text: string) {
        if (!text) return '';

        const lines = text.split('\n');

        const stopPatterns = [
            /^On .* wrote:/i,
            /^From:/i,
            /^Sent:/i,
            /^Subject:/i,
            /^--$/,
        ];

        const result: string[] = [];

        for (const line of lines) {
            if (stopPatterns.some(p => p.test(line.trim()))) {
                break;
            }

            result.push(line);
        }

        return result.join('\n').trim();
    }
    // ─── parseWebhook ────────────────────────────────────────────────────────

    async parseWebhook(body: any): Promise<ParsedInbound[]> {
        if (!body) return [];

        try {
            const parsed = await this.parseMailgunBody(body);
            return parsed ? [parsed] : [];
        } catch (e) {
            this.logger.error(`Mailgun parse error: ${e.message}`);
            return [];
        }
    }

    private async parseMailgunBody(body: any): Promise<ParsedInbound | null> {
        const from: string = body.sender ?? body.from ?? '';
        const to: string = body.recipient ?? body.To ?? '';
        const subject: string = body.subject ?? body.Subject ?? '';
        const textBody: string = await this.extractReply(body['body-plain'] || body['stripped-text'] || '') || body['body-plain'] //?? body['stripped-text'] ?? '';
        const htmlBody: string = body['body-html'] ?? '';
        const messageId: string = body['Message-Id'] ?? body['message-id'] ?? `mailgun-${Date.now()}`;

        const senderEmail = this.extractEmail(from);
        const senderName = this.extractName(from);

        const attachments: ParsedAttachment[] = [];

        // ── File attachments: attachment-1..N ────────────────────────────────
        const count = parseInt(body['attachment-count'] ?? '0', 10);
        for (let i = 1; i <= count; i++) {
            const att = this.parseFileField(body[`attachment-${i}`]);
            if (att) attachments.push(att);
        }

        // ── Inline CID images: content-id-map ────────────────────────────────
        const cidMap = this.parseCidMap(body['content-id-map']);
        for (const [cid, fieldName] of Object.entries(cidMap)) {
            const att = this.parseFileField(body[fieldName as string]);
            if (att) attachments.push({ ...att, caption: `[inline:${cid}]` });
        }

        // ── Multer files (injected by controller) ─────────────────────────────
        for (const file of body.files ?? []) {
            const att = this.parseMulterFile(file);
            if (att) attachments.push(att);
        }

        return {
            externalId: messageId,
            contactIdentifier: senderEmail,
            direction: 'incoming',
            messageType: attachments.length > 0 ? attachments[0].type : 'text',
            text: textBody || (htmlBody ? '[HTML body]' : undefined),
            subject,
            attachments,
            metadata: {
                from,
                to,
                htmlBody: htmlBody, //htmlBody.substring(0, 2000),
                senderName,
                inReplyTo: body['In-Reply-To'] ?? body['in-reply-to'],
                references: body['References'] ?? body['references'],
                messageId: body['Message-Id'] ?? body['message-id'],

            },
            raw: body,
        };
    }

    // ─── File field parsers ───────────────────────────────────────────────────

    private parseFileField(field: any): ParsedAttachment | null {
        if (!field) return null;

        let info: any = field;
        if (typeof field === 'string') {
            try { info = JSON.parse(field); } catch { return null; }
        }

        const mimeType: string = info['content-type'] ?? info.contentType ?? info.mimetype ?? 'application/octet-stream';
        const filename: string | undefined = info.name ?? info.filename;
        const url: string | undefined = info.url;
        const size: number | undefined = info.size ? parseInt(info.size, 10) : undefined;

        // vCard
        if (mimeType === 'text/vcard' || mimeType === 'text/x-vcard' || filename?.endsWith('.vcf')) {
            return { type: 'contact', url, filename, mimeType, size };
        }
        // Calendar
        if (mimeType === 'text/calendar' || filename?.endsWith('.ics')) {
            return { type: 'document', url, filename, mimeType, size, caption: '[Calendar invite]' };
        }

        return { type: mimeToType(mimeType), url, filename, mimeType, size };
    }

    private parseMulterFile(file: Express.Multer.File): ParsedAttachment | null {
        if (!file) return null;
        const mimeType = file.mimetype ?? 'application/octet-stream';
        return {
            type: mimeToType(mimeType),
            mimeType,
            filename: file.originalname,
            size: file.size,
            url: file.path ? `file://${file.path}` : undefined,
        };
    }

    // ─── downloadMedia ───────────────────────────────────────────────────────

    async downloadMedia(channel: any, mediaId: string): Promise<DownloadResult> {
        // mediaId = the attachment URL from Mailgun
        const apiKey: string | undefined = channel.credentials?.apiKey;

        const { data, headers } = await axios.get<ArrayBuffer>(mediaId, {
            auth: apiKey ? { username: 'api', password: apiKey } : undefined,
            responseType: 'arraybuffer',
        });

        const mimeType = (headers['content-type'] as string)?.split(';')[0].trim() ?? 'application/octet-stream';
        return { buffer: data, mimeType };
    }

    // ─── getContactProfile ───────────────────────────────────────────────────

    async getContactProfile(identifier: string): Promise<ContactProfile> {
        // Email has no live profile API — name comes from the From header
        return {};
    }

    // ─── sendMessage ─────────────────────────────────────────────────────────

    //   async sendMessage(channel: any, payload: any): Promise<{ externalId: string }> {
    //     const apiKey: string = channel.credentials?.apiKey;
    //     const domain: string = channel.credentials?.domain;

    //     const form = new FormData();
    //     form.append('from', payload.from);
    //     form.append('to', payload.to);
    //     form.append('subject', payload.subject ?? '(no subject)');
    //     if (payload.text) form.append('text', payload.text);
    //     if (payload.html)  form.append('html', payload.html);

    //     for (const att of payload.attachments ?? []) {
    //       const { data } = await axios.get<ArrayBuffer>(att.url, { responseType: 'arraybuffer' });
    //       const blob = new Blob([data], { type: att.mimeType });
    //       form.append('attachment', blob, att.filename ?? 'file');
    //     }

    //     const { data } = await axios.post(
    //       `https://api.mailgun.net/v3/${domain}/messages`,
    //       form,
    //       { auth: { username: 'api', password: apiKey } },
    //     );

    //     return { externalId: data?.id ?? '' };
    //   }

    async sendMessage(channel: any, payload: any): Promise<{ externalId: string }> {


        console.log( `EmailMailgunProvider sending message to ${payload} with text: ${payload.text} and subject: ${payload.subject}` );
        
        if (!channel) throw new Error('Channel not found');

        const config = channel.config as any;

        const transporter = nodemailer.createTransport({
            host: config.smtpserver,
            port: config.smtpport,
            secure: config.encryption === 'SSL/TLS', // true for 465 usually
            auth: {
                user: config.userId || config.emailaddress,
                pass: config.password,
            },
        });

        const info = await transporter.sendMail({
            from: `"${config.displayname}" <${config.emailaddress}>`,
            to: payload.to,
            subject: payload.text?.slice(0, 100) || 'Message',
            text: payload.text,
            replyTo: config.emailaddress,
        });

        return { externalId: info.messageId };
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

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