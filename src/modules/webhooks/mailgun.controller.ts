
import {
  Controller, Post, Req, Headers,
  UseInterceptors, UploadedFiles,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import * as crypto from 'crypto';
import { PrismaService } from 'prisma/prisma.service';
import { ChannelRegistry } from '../channels/channel-registry.service';
import { InboundService } from '../inbound/inbound.service';

@Controller('webhooks/mailgun')
export class WebhookMailgunController {
  constructor(
    private registry: ChannelRegistry,
    private inbound: InboundService,
    private prisma: PrismaService,
  ) {}

  @Post()
  @UseInterceptors(AnyFilesInterceptor())   // handles multipart attachments
  async handle(
    @Req() req: any,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    const body = req.body;

    // Verify Mailgun webhook signature
    if (!this.verifyMailgun(body)) {
      return { status: 'invalid_signature' };
    }

    const recipient: string = body.recipient ?? body.To ?? '';
    if (!recipient) return { status: 'ignored' };

    // Channel identified by the local part of the recipient address
    // e.g. support@inbound.yourdomain.com → identifier = 'support'
    const identifier = recipient.split('@')[0];

    const channel = await this.prisma.channel.findFirst({
      where: { type: 'email', identifier },
    });
    if (!channel) return { status: 'channel_not_found' };

    const provider = this.registry.getProviderByType('email');

    // Inject Multer files so provider can process them
    const parsedList = await provider.parseWebhook({ ...body, files });

    for (const parsed of parsedList) {
      await this.inbound.process({
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

  private verifyMailgun(body: any): boolean {
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