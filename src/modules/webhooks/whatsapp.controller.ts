
import { Controller, Post, Get, Query, Headers, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { ChannelRegistry } from '../channels/channel-registry.service';
import { InboundService } from '../inbound/inbound.service';
import { PrismaService } from 'prisma/prisma.service';
import { verifyMetaSignature } from '../channels/utils/meta-signature.util';

@Controller('webhooks/whatsapp')
export class WebhookWhatsAppController {
  constructor(
    private registry: ChannelRegistry,
    private inbound: InboundService,
    private prisma: PrismaService,
  ) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') token: string,
    @Res() res: Response,
  ) {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  @Post()
  async handle(@Req() req: any, @Headers('x-hub-signature-256') signature: string) {
    const isValid = verifyMetaSignature(req.rawBody, signature, process.env.WHATSAPP_APP_SECRET!);
    if (!isValid) return { status: 'invalid_signature' };

    const body = req.body;
    const phoneNumberId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (!phoneNumberId) return { status: 'ignored' };

    const channel = await this.prisma.channel.findFirst({
      where: { type: 'whatsapp', identifier: phoneNumberId },
    });
    if (!channel) return { status: 'channel_not_found' };

    const provider = this.registry.getProviderByType(channel.type);
    const parsedList = await provider.parseWebhook(body);

    for (const parsed of parsedList) {
      await this.inbound.process({
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
      });
    }

    return { status: 'ok' };
  }
}