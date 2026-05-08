// modules/channels/providers/mailgun/mailgun.controller.ts

import { Controller, Post, Req, UseInterceptors, UploadedFiles } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import * as crypto from 'crypto';
import { PrismaService } from '../../../../prisma/prisma.service';
import { InboundService } from '../../../inbound/inbound.service';
import { ChannelAdaptersRegistry } from 'src/modules/channel-adapters/channel-adapters.registry';
import { MessageProcessingQueueService } from 'src/modules/outbound/message-processing-queue.service';
import { Public } from 'src/common/auth/route-access.decorator';

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
    @Req() req: any,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    const body = req.body;

    if (!this.verifySignature(body)) {
      return { status: 'invalid_signature' };
    }

    const deliveryEvent = this.extractDeliveryEvent(body);
    if (deliveryEvent) {
      await this.processingQueue.enqueueEmailStatusUpdate(deliveryEvent);
      return { status: 'ok', kind: 'delivery_event' };
    }

    const recipient: string = body.recipient ?? body.To ?? '';
    if (!recipient) return { status: 'ignored' };

    // Channel identified by local part of recipient address
    // e.g. support@inbound.yourdomain.com → identifier = 'support'
    const identifier = recipient.split('@')[0];

    const channel = await this.prisma.channel.findFirst({
      where: { type: 'email', identifier },
    });
    if (!channel) return { status: 'channel_not_found' };

    const provider   = this.registry.getProviderByType('email');
    const parsedList = await provider.parseWebhook({ ...body, files });

    for (const parsed of parsedList) {
      await this.processingQueue.enqueueInboundProcess({
        channelId:         channel.id,
        workspaceId:       channel.workspaceId,
        channelType:       channel.type,
        contactIdentifier: parsed.contactIdentifier,
        direction:         parsed.direction,
        messageType:       parsed.messageType,
        text:              parsed.text,
        subject:           parsed.subject,
        attachments:       parsed.attachments,
        metadata:          parsed.metadata,
        raw:               parsed.raw,
      });
    }

    return { status: 'ok' };
  }

  private verifySignature(body: any): boolean {
    const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    if (!key) return true; // skip if not configured

    const signatureInput = body?.signature ?? body ?? {};
    const { timestamp, token, signature } = signatureInput;
    if (!timestamp || !token || !signature) return false;

    const hash = crypto
      .createHmac('sha256', key)
      .update(timestamp + token)
      .digest('hex');

    return hash === signature;
  }

  private extractDeliveryEvent(body: any):
    | {
        externalId: string;
        status: 'delivered' | 'read' | 'failed' | 'bounced' | 'unsubscribed';
        recipient?: string;
      }
    | null {
    const rawEventData = body?.['event-data'] ?? body?.eventData ?? body;
    const eventData =
      typeof rawEventData === 'string' ? this.safeJson(rawEventData) : rawEventData;
    const rawEvent = String(eventData?.event ?? body?.event ?? '').toLowerCase();
    const externalId =
      eventData?.message?.headers?.['message-id'] ??
      eventData?.message?.headers?.['Message-Id'] ??
      body?.['message-id'] ??
      body?.MessageID ??
      body?.['Message-Id'];

    if (!rawEvent || !externalId) return null;

    const status = this.mapDeliveryStatus(rawEvent, eventData);
    if (!status) return null;

    return {
      externalId: String(externalId),
      status,
      recipient: eventData?.recipient ?? body?.recipient,
    };
  }

  private mapDeliveryStatus(
    event: string,
    eventData: any,
  ): 'delivered' | 'read' | 'failed' | 'bounced' | 'unsubscribed' | null {
    if (event === 'delivered') return 'delivered';
    if (event === 'opened' || event === 'clicked') return 'read';
    if (event === 'unsubscribed') return 'unsubscribed';
    if (event === 'complained' || event === 'rejected') return 'failed';
    if (event === 'failed') {
      const reason = String(eventData?.reason ?? eventData?.severity ?? '').toLowerCase();
      return reason.includes('bounce') || reason.includes('permanent') ? 'bounced' : 'failed';
    }
    return null;
  }

  private safeJson(value: string): any {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
}
