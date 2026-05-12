import { Controller, Post, Req, UseInterceptors, UploadedFiles } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import * as crypto from 'crypto';
import { PrismaService } from '../../../../prisma/prisma.service';
import { InboundService } from '../../../inbound/inbound.service';
import { ChannelAdaptersRegistry } from 'src/modules/channel-adapters/channel-adapters.registry';
import { MessageProcessingQueueService } from 'src/modules/outbound/message-processing-queue.service';
import { Public } from 'src/common/auth/route-access.decorator';

type MailgunBody = Record<string, unknown>;
type HeaderPair = [string, string];

@Controller('webhooks/mailgun')
export class MailgunController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdaptersRegistry,
    private readonly inbound: InboundService,
    private readonly processingQueue: MessageProcessingQueueService,
  ) {}

  @Post()
  @Public()
  @UseInterceptors(AnyFilesInterceptor())
  async handle(
    @Req() req: { body: MailgunBody },
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    const body = req.body;
    console.dir({ body }, { depth: null });


    if (!this.verifySignature(body)) {
      return { status: 'invalid_signature' };
    }

    const deliveryEvent = this.extractDeliveryEvent(body);
    if (deliveryEvent) {
      await this.processingQueue.enqueueEmailStatusUpdate(deliveryEvent);
      return { status: 'ok', kind: 'delivery_event' };
    }

    const channel = await this.resolveInboundChannel(body);
    if (!channel) return { status: 'channel_not_found' };

    const provider = this.registry.getProviderByType('email');
    const parsedList = await provider.parseWebhook({ ...body, files });

    for (const parsed of parsedList) {
      await this.processingQueue.enqueueInboundProcess({
        channelId: channel.id,
        workspaceId: channel.workspaceId,
        channelType: channel.type,
        contactIdentifier: parsed.contactIdentifier,
        direction: parsed.direction,
        messageType: parsed.messageType,
        text: parsed.text,
        subject: parsed.subject,
        attachments: parsed.attachments,
        metadata: parsed.metadata,
        raw: parsed.raw,
      });
    }

    return { status: 'ok' };
  }

  private async resolveInboundChannel(body: MailgunBody) {
    const addressCandidates = this.getInboundAddressCandidates(body);
    if (!addressCandidates.length) return null;

    const identifierCandidates = this.unique([
      ...addressCandidates,
      ...addressCandidates.map((address) => address.split('@')[0]).filter(Boolean),
    ]);

    const channel = await this.prisma.channel.findFirst({
      where: {
        type: 'email',
        identifier: { in: identifierCandidates },
      },
    });
    if (channel) return channel;

    return this.prisma.channel.findFirst({
      where: {
        type: 'email',
        OR: addressCandidates.flatMap((address) => [
          { config: { path: ['forwardingEmail'], equals: address } },
          { config: { path: ['fromEmail'], equals: address } },
          { config: { path: ['emailaddress'], equals: address } },
          { config: { path: ['userId'], equals: address } },
        ]),
      },
    });
  }

  private getInboundAddressCandidates(body: MailgunBody): string[] {
    const originalRecipients = [
      body.To,
      body.to,
      body['Delivered-To'],
      body['X-Original-To'],
      ...this.extractHeaderValues(body['message-headers'], [
        'To',
        'Delivered-To',
        'X-Original-To',
      ]),
    ];

    const mailgunRecipients = [
      body.recipient,
      body.Recipient,
      body['X-Envelope-To'],
      body['Envelope-To'],
    ];

    return this.unique(
      [...originalRecipients, ...mailgunRecipients]
        .map((value) => this.extractEmail(String(value ?? '')))
        .filter((value): value is string => Boolean(value)),
    );
  }

  private extractHeaderValues(rawHeaders: unknown, names: string[]): string[] {
    const parsedHeaders =
      typeof rawHeaders === 'string' ? this.safeJson(rawHeaders) : rawHeaders;
    if (!Array.isArray(parsedHeaders)) return [];

    const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
    return parsedHeaders
      .filter((header): header is HeaderPair => {
        return (
          Array.isArray(header) &&
          header.length >= 2 &&
          typeof header[0] === 'string' &&
          typeof header[1] === 'string' &&
          normalizedNames.has(header[0].toLowerCase())
        );
      })
      .map(([, value]) => value);
  }

  private extractEmail(value: string): string | null {
    const matchedAddress = value.match(/<([^<>@\s]+@[^<>@\s]+)>/)?.[1];
    const plainAddress = value.match(/[^\s<>,;:"]+@[^\s<>,;:"]+/)?.[0];
    return (matchedAddress ?? plainAddress)?.trim().toLowerCase() ?? null;
  }

  private unique(values: string[]): string[] {
    return [...new Set(values)];
  }

  private verifySignature(body: MailgunBody): boolean {
    const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    if (!key) return true; // skip if not configured

    const signatureInput = this.isRecord(body.signature) ? body.signature : body;
    const timestamp = String(signatureInput.timestamp ?? '');
    const token = String(signatureInput.token ?? '');
    const signature = String(signatureInput.signature ?? '');
    if (!timestamp || !token || !signature) return false;

    const hash = crypto
      .createHmac('sha256', key)
      .update(timestamp + token)
      .digest('hex');

    return hash === signature;
  }

  private extractDeliveryEvent(body: MailgunBody):
    | {
        externalId: string;
        status: 'delivered' | 'read' | 'failed' | 'bounced' | 'unsubscribed';
        recipient?: string;
      }
    | null {
    const rawEventData = body['event-data'] ?? body.eventData ?? body;
    const eventData = this.normalizeRecord(rawEventData);
    const rawEvent = String(eventData.event ?? body.event ?? '').toLowerCase();
    const message = this.normalizeRecord(eventData.message);
    const headers = this.normalizeRecord(message.headers);
    const externalId =
      headers['message-id'] ??
      headers['Message-Id'] ??
      body['message-id'] ??
      body.MessageID ??
      body['Message-Id'];

    if (!rawEvent || !externalId) return null;

    const status = this.mapDeliveryStatus(rawEvent, eventData);
    if (!status) return null;

    return {
      externalId: String(externalId),
      status,
      recipient: String(eventData.recipient ?? body.recipient ?? ''),
    };
  }

  private mapDeliveryStatus(
    event: string,
    eventData: Record<string, unknown>,
  ): 'delivered' | 'read' | 'failed' | 'bounced' | 'unsubscribed' | null {
    if (event === 'delivered') return 'delivered';
    if (event === 'opened' || event === 'clicked') return 'read';
    if (event === 'unsubscribed') return 'unsubscribed';
    if (event === 'complained' || event === 'rejected') return 'failed';
    if (event === 'failed') {
      const reason = String(eventData.reason ?? eventData.severity ?? '').toLowerCase();
      return reason.includes('bounce') || reason.includes('permanent') ? 'bounced' : 'failed';
    }
    return null;
  }

  private safeJson(value: string): unknown {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }

  private normalizeRecord(value: unknown): Record<string, unknown> {
    const parsed = typeof value === 'string' ? this.safeJson(value) : value;
    return this.isRecord(parsed) ? parsed : {};
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
}
