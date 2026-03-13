// modules/channels/providers/whatsapp/whatsapp.controller.ts

import { Controller, Get, Post, Query, Req, Headers, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from 'prisma/prisma.service';
import { ChannelRegistry } from '../../channel-registry.service';
import { InboundService } from '../../../inbound/inbound.service';
import { verifyMetaSignature } from '../meta/meta-signature.util';

@Controller('webhooks/whatsapp')
export class WhatsAppController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelRegistry,
    private readonly inbound: InboundService,
  ) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  @Post()
  async handle(
    @Req() req: any,
    @Headers('x-hub-signature-256') signature: string,
  ) {
    if (!verifyMetaSignature(req.rawBody, signature, process.env.WHATSAPP_APP_SECRET!)) {
      return { status: 'invalid_signature' };
    }

    const body = req.body;

    // WhatsApp sends phoneNumberId in metadata — use to find channel
    const phoneNumberId: string =
      body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

    if (!phoneNumberId) return { status: 'ignored' };

    const channel = await this.prisma.channel.findFirst({
      where: { type: 'whatsapp', identifier: phoneNumberId },
    });
    if (!channel) return { status: 'channel_not_found' };

    const provider   = this.registry.getProviderByType('whatsapp');
    const parsedList = await provider.parseWebhook(body);

    for (const parsed of parsedList) {
      await this.inbound.process({
        channelId:         channel.id,
        workspaceId:       channel.workspaceId,
        channelType:       'whatsapp',
        contactIdentifier: parsed.contactIdentifier,
        direction:         parsed.direction,
        messageType:       parsed.messageType,
        text:              parsed.text,
        attachments:       parsed.attachments,
        replyToChannelMsgId: parsed.replyToChannelMsgId,
        metadata:          parsed.metadata,
        raw:               parsed.raw,
      });
    }

    // WhatsApp requires 200 OK immediately
    return { status: 'ok' };
  }
}