import { Controller, Post, Get, Query, Headers, Req, Res, Logger } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { ChannelRegistry } from '../channels/channel-registry.service';
import { InboundService } from '../inbound/inbound.service';
import { verifyMetaSignature } from '../channels/utils/meta-signature.util';
import { Response } from 'express';

@Controller('webhooks/meta')
export class MetaWebhookController {
    readonly 
  constructor(
    private prisma: PrismaService,
    private registry: ChannelRegistry,
    private inboundService: InboundService,
  ) {}
  private readonly logger = new Logger(MetaWebhookController.name);

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      this.logger.log('Meta webhook verified successfully.');
      return res.status(200).send(challenge);
    }
    this.logger.warn('Meta webhook verification failed. Invalid token or mode.');
    return res.sendStatus(403);
  }

  @Post()
  async handle(@Req() req: any, @Headers('x-hub-signature-256') signature: string) {
    const isValid = verifyMetaSignature(req.rawBody, signature, process.env.WHATSAPP_APP_SECRET!);
    if (!isValid) {
      this.logger.warn('Meta webhook received with invalid signature. Possible security threat.');
      return { status: 'invalid_signature' };
    }
    this.logger.log(`Meta webhook received. Signature valid: ${isValid}`);

    const body = req.body;
    const pageId = body.entry?.[0]?.id;
    this.logger.debug(`Extracted pageId: ${pageId} from webhook body.`);
    if (!pageId) return { status: 'ignored' };

    const channel = await this.prisma.channel.findFirst({
      where: { type: { in: ['instagram', 'messenger'] }, identifier: pageId },
    });
    if (!channel) return { status: 'channel_not_found' };

    const provider = this.registry.getProviderByType(channel.type);
    const parsedList = await provider.parseWebhook(body);

    for (const parsed of parsedList) {
      // Fetch profile if contact not cached
      let profile = null;
      const existing = await this.prisma.contactChannel.findFirst({
        where: { identifier: parsed.contactIdentifier, channelId: channel.id },
        include: { contact: true },
      });

      if (!existing?.contact?.avatarUrl && provider.getContactProfile) {
        try {
          profile = await provider.getContactProfile(parsed.contactIdentifier, channel.id);
        } catch (e) {
          // non-fatal
        }
      }

      await this.inboundService.process({
        channelId: channel.id,
        workspaceId: channel.workspaceId,
        channelType: channel.type,
        contactIdentifier: parsed.contactIdentifier,
        direction: parsed.direction,
        messageType: parsed.messageType,
        text: parsed.text,
        attachments: parsed.attachments,
        replyToChannelMsgId: parsed.replyToChannelMsgId,
        metadata: parsed.metadata,
        raw: parsed.raw,
        profile,
      });
    }

    return { status: 'ok' };
  }
}