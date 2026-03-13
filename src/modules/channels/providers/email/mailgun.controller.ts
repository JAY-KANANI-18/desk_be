// modules/channels/providers/mailgun/mailgun.controller.ts

import { Controller, Post, Req, UseInterceptors, UploadedFiles } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import * as crypto from 'crypto';
import { PrismaService } from 'prisma/prisma.service';
import { ChannelRegistry } from '../../channel-registry.service';
import { InboundService } from '../../../inbound/inbound.service';

@Controller('webhooks/mailgun')
export class MailgunController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelRegistry,
    private readonly inbound: InboundService,
  ) {}

  @Post()
  @UseInterceptors(AnyFilesInterceptor())
  async handle(
    @Req() req: any,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    const body = req.body;

    if (!this.verifySignature(body)) {
      return { status: 'invalid_signature' };
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
      await this.inbound.process({
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

    const { timestamp, token, signature } = body ?? {};
    if (!timestamp || !token || !signature) return false;

    const hash = crypto
      .createHmac('sha256', key)
      .update(timestamp + token)
      .digest('hex');

    return hash === signature;
  }
}