// modules/channels/providers/meta/messenger/messenger.controller.ts

import { Controller, Get, Post, Query, Req, Headers, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from 'prisma/prisma.service';
import { ChannelRegistry } from '../../../channel-registry.service';
import { InboundService } from '../../../../inbound/inbound.service';
import { verifyMetaSignature } from '../meta-signature.util';

@Controller('webhooks/messenger')
export class MessengerController {
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
    if (mode === 'subscribe' && token === process.env.MESSENGER_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  @Post()
  async handle(
    @Req() req: any,
    @Headers('x-hub-signature-256') signature: string,
  ) {
    if (!verifyMetaSignature(req.rawBody, signature, process.env.MESSENGER_APP_SECRET!)) {
      return { status: 'invalid_signature' };
    }

    const body   = req.body;
    const pageId = body?.entry?.[0]?.id;
    if (!pageId) return { status: 'ignored' };

    const channel = await this.prisma.channel.findFirst({
      where: { type: 'messenger', identifier: pageId },
    });
    if (!channel) return { status: 'channel_not_found' };

    const provider   = this.registry.getProviderByType('messenger');
    const parsedList = await provider.parseWebhook(body);

    for (const parsed of parsedList) {
      let profile = null;

      const hasProfile = await this.prisma.contactChannel.findFirst({
        where: { identifier: parsed.contactIdentifier, channelId: channel.id },
        select: { id: true, avatarUrl: true },
      });

      if (!hasProfile?.avatarUrl && provider.getContactProfile) {
        try { profile = await provider.getContactProfile(parsed.contactIdentifier, channel); }
        catch { /* non-fatal */ }
      }

      await this.inbound.process({
        channelId:         channel.id,
        workspaceId:       channel.workspaceId,
        channelType:       'messenger',
        contactIdentifier: parsed.contactIdentifier,
        direction:         parsed.direction,
        messageType:       parsed.messageType,
        text:              parsed.text,
        attachments:       parsed.attachments,
        metadata:          parsed.metadata,
        raw:               parsed.raw,
        profile,
      });
    }

    return { status: 'ok' };
  }
}