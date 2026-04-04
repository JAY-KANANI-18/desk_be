// modules/channels/providers/meta/instagram/instagram.controller.ts

import {
  Controller, Get, Post, Put, Delete,
  Query, Req, Res, Body, Param, Headers,
  BadRequestException, NotFoundException, UnauthorizedException,
  Logger, HttpCode
} from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../../../../prisma/prisma.service';
import { InboundService } from '../../../../inbound/inbound.service';
import { OutboundService } from '../../../../outbound/outbound.service';
import { verifyMetaSignature } from '../meta-signature.util';
import axios from 'axios';
import { IsString } from 'class-validator';
import { ChannelAdaptersRegistry } from 'src/modules/channel-adapters/channel-adapters.registry';

// ─── Constants ───────────────────────────────────────────────────────────────

const IG_API = 'https://graph.instagram.com';
const IG_API_VERSION = 'v21.0';
const IG_BASE = `${IG_API}/${IG_API_VERSION}`;

// ─── DTOs ────────────────────────────────────────────────────────────────────

class ConnectInstagramDto {

  @IsString()
  code: string;

  @IsString()
  workspaceId: string;
  @IsString()
  redirectUri: string;
}
class SendMessageDto {
  channelId: string;
  recipientIgsid: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  fileUrl?: string;
  quickReplies?: { title: string; payload: string }[];
  stickerId?: string;
}

class IcebreakerDto {
  channelId: string;
  icebreakers: { question: string; payload: string }[];
}

// ─── Controller ──────────────────────────────────────────────────────────────

@Controller('api/channels/instagram')
export class InstagramController {
  private readonly logger = new Logger(InstagramController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdaptersRegistry,
    private readonly inbound: InboundService,
    private readonly outbound: OutboundService,
  ) { }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. WEBHOOK VERIFICATION (Meta calls this when you set up the webhook)
  // GET /webhooks/instagram?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
  // ─────────────────────────────────────────────────────────────────────────

  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
      this.logger.log('Instagram webhook verified');
      return res.status(200).send(challenge);
    }
    this.logger.warn('Instagram webhook verification failed');
    return res.sendStatus(403);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. WEBHOOK RECEIVER (Meta sends all events here)
  // POST /webhooks/instagram
  // ─────────────────────────────────────────────────────────────────────────

  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Req() req: any,
    @Headers('x-hub-signature-256') signature: string,
  ) {
    if (!verifyMetaSignature(req.rawBody, signature, process.env.INSTAGRAM_APP_SECRET!)) {
      return { status: 'invalid_signature' };
    }

    const body = req.body;
    console.dir({ body }, { depth: null });

    const pageId = body?.entry?.[0]?.id;
    if (!pageId) return { status: 'ignored' };

    const channel = await this.prisma.channel.findFirst({
      where: { type: 'instagram', identifier: pageId },
    });
    if (!channel) return { status: 'channel_not_found' };

    const provider = this.registry.getProviderByType('instagram');
    const parsedList: any = await provider.parseWebhook(body);

    for (const parsed of parsedList) {


      console.log({ parsed });

      if (parsed.contactIdentifier === channel.identifier) {
        let m = await this.outbound.processExternalOutbound({
          workspaceId: channel.workspaceId,

          channelId: channel.id,
          channelType: 'instagram',
          channelMsgId: parsed.externalId,
          recipientIdentifier: parsed.recipientIdentifier!,
          text: parsed.text,
          attachments: parsed.attachments,
          timestamp: parsed.timestamp,
          metadata: parsed.metadata,
          profile: parsed.profile,
        });
        continue;
      }

      if (parsed.direction === 'outgoing') {
        if (parsed.messageType === "status") {
          await this.outbound.processMessengerDelivery({
            channelId: channel.id,
            externalId: parsed.externalId,
          })
        }
        if (parsed.messageType === "status_read") {
          await this.outbound.processMessengerRead({
            channelId: channel.id,
            contactIdentifier: parsed.contactIdentifier,
            watermark: parsed.watermark || parsed.timestamp, // Instagram doesn't have watermark but we can use timestamp to mark as read
          })
        }

        continue; // For now we only process incoming messages in the webhook.
      }
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
        channelId: channel.id,
        workspaceId: channel.workspaceId,
        channelType: 'instagram',
        contactIdentifier: parsed.contactIdentifier,
        direction: parsed.direction,
        messageType: parsed.messageType,
        text: parsed.text,
        attachments: parsed.attachments,
        metadata: parsed.metadata,
        raw: parsed.raw,
        profile,
      });
    }

    return { status: 'ok' };
  }

  // Resolve channel by calling /me for each instagram channel
  // and matching the one that receives this webhookEntryId
  private async resolveChannelByWebhookId(webhookEntryId: string): Promise<any | null> {
    this.logger.debug(`Resolving Instagram channel for webhookEntryId: ${webhookEntryId}`); // Add debug log
    const allChannels = await this.prisma.channel.findMany({
      where: { type: 'instagram', status: 'connected' },
    });

    for (const ch of allChannels) {
      const igUserId = (ch.credentials as any)?.igUserId ?? ch.identifier;

      // Check if this channel's subscribed app matches the webhookEntryId
      try {
        const { data } = await axios.get(
          `https://graph.instagram.com/v21.0/${igUserId}/subscribed_apps`,
          { params: { access_token: (ch.credentials as any)?.accessToken } },
        );
        this.logger.debug(`Channel ${ch.id} subscribed apps: ${JSON.stringify(data)}`); // Add debug log
        // subscribed_apps data[0].id = the app ID, not what we need
        // But if this channel's igUserId appears in messaging as recipient — it's a match
        // We verify by checking if webhookEntryId is linked to this igUserId
        const { data: meData } = await axios.get(
          `https://graph.instagram.com/v21.0/${webhookEntryId}`,
          { params: { fields: 'id', access_token: (ch.credentials as any)?.accessToken } },
        );
        this.logger.debug(`Channel ${ch.id} /me response: ${JSON.stringify(meData)}`); // Add debug log
        if (meData?.id === webhookEntryId) {
          return ch; // ✅ this channel owns this webhookEntryId
        }
      } catch { /* not this channel */ }
    }

    return null;
  }


  // ─────────────────────────────────────────────────────────────────────────
  // 3. OAUTH — Generate login URL
  // GET /webhooks/instagram/auth/url?workspaceId=xxx&redirectUri=xxx
  // ─────────────────────────────────────────────────────────────────────────

  @Get('auth/url')
  getAuthUrl(
    @Query('workspaceId') workspaceId: string,
    @Query('redirectUri') redirectUri: string,
  ) {
    if (!workspaceId || !redirectUri) {
      throw new BadRequestException('workspaceId and redirectUri are required');
    }

    // State encodes workspaceId so we recover it in callback
    const state = Buffer.from(JSON.stringify({ workspaceId })).toString('base64');

    const params = new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: [
        'instagram_business_basic',
        'instagram_business_manage_messages',
        'instagram_business_manage_comments',
        // 'instagram_business_content_publish',
      ].join(','),
      state,
    });

    const url = `https://www.instagram.com/oauth/authorize?${params.toString()}`;
    return { url };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. OAUTH — Callback: exchange code → tokens → save channel
  // POST /webhooks/instagram/auth/callback
  // ─────────────────────────────────────────────────────────────────────────

  @Post('auth/callback')
  async handleCallback(@Body() dto: ConnectInstagramDto) {
    const { code, workspaceId, redirectUri } = dto;
    if (!code || !workspaceId || !redirectUri) {
      throw new BadRequestException('code, workspaceId, redirectUri are required');
    }

    // Step 1: Exchange code for short-lived token
    const shortLivedToken = await this.exchangeCodeForToken(code, redirectUri);
this.logger.log(`Short-lived token: ${shortLivedToken}`);



    // Step 2: Exchange short-lived for long-lived token (60 days)
    const { access_token: longLivedToken, expires_in } = await this.exchangeLongLivedToken(shortLivedToken);

    // Step 3: Get Instagram profile info
    // igUser.id = 25930098660015623 → used for sending messages via API
    const igUser = await this.getIGUserInfo(longLivedToken);

    await this.subscribeToWebhook(igUser.id, longLivedToken);
    // Step 4: Get Business Account ID
    // businessAccountId = 17841473852821256 → what webhook entry.id sends
    // These are TWO DIFFERENT IDs for the same account
    // const businessAccountId = await this.getIGBusinessAccountId(longLivedToken);

    // Step 5: Upsert channel — store businessAccountId as identifier (for webhook matching)
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    const channel = await this.prisma.channel.upsert({
      where: {
        workspaceId:workspaceId,
        type: 'instagram',
        identifier: igUser.user_id,  // ← webhook entry.id matches this
      },
      update: {
        credentials: {
          accessToken: longLivedToken,
          tokenExpiresAt: expiresAt,
          igUserId: igUser.id,          // ← used when calling /messages API
        },
        name: igUser.username,
        config: {
          userName: igUser.username,
          accountType: igUser.account_type,
          mediaCount: igUser.media_count,
          igUserId: igUser.id,          // store here too for easy access
          // businessAccountId,
        },
        status: 'connected',
      },
      create: {
        workspaceId,
        type: 'instagram',
        identifier: igUser.user_id,  // ← webhook entry.id matches this
        name: igUser.username,
        credentials: {
          accessToken: longLivedToken,
          tokenExpiresAt: expiresAt,
          igUserId: igUser.id,          // ← used when calling /messages API
        },
        config: {
                    userName: igUser.username,

          accountType: igUser.account_type,
          mediaCount: igUser.media_count,
          igUserId: igUser.id,
          // businessAccountId,
        },
        status: 'connected',
      },
    });

    this.logger.log(`Instagram channel connected: ${igUser.username} | webhookId: ${"efe"} | apiId: ${igUser.id}`);
    return { success: true, channel };
  }

  private async subscribeToWebhook(igUserId: string, accessToken: string): Promise<void> {
    try {
      const { data } = await axios.post(
        `${IG_BASE}/${igUserId}/subscribed_apps`,
        {},
        {
          params: {
            access_token: accessToken,
            subscribed_fields: [
              'messages',
              'messaging_postbacks',
              'messaging_optins',
              'messaging_seen',        // replaces message_reads
              'message_reactions',
              'messaging_referral',
              'messaging_handover',
              'standby',
              'comments',
              'mentions',
            ].join(','),
          },
        },
      );
      this.logger.log(`Instagram webhook subscribed for ${igUserId}: ${JSON.stringify(data)}`);
    } catch (e: any) {
      // Non-fatal — log but don't break the connect flow
      this.logger.warn(`Failed to subscribe Instagram webhook: ${e?.response?.data?.error?.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. REFRESH TOKEN (call before 60 days expiry)
  // POST /webhooks/instagram/auth/refresh/:channelId
  // ─────────────────────────────────────────────────────────────────────────

  @Post('auth/refresh/:channelId')
  async refreshToken(@Param('channelId') channelId: string) {
    const channel: any = await this.findChannelOrThrow(channelId);

    const { data } = await axios.get(`${IG_BASE}/refresh_access_token`, {
      params: {
        grant_type: 'ig_refresh_token',
        access_token: channel.credentials.accessToken,
      },
    });

    const expiresAt = new Date(Date.now() + data.expires_in * 1000);
    await this.prisma.channel.update({
      where: { id: channelId },
      data: { credentials: { accessToken: data.access_token, tokenExpiresAt: expiresAt } },
    });

    this.logger.log(`Instagram token refreshed for channel ${channelId}`);
    return { success: true, expiresAt };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. DISCONNECT channel
  // DELETE /webhooks/instagram/channel/:channelId
  // ─────────────────────────────────────────────────────────────────────────

  @Delete('channel/:channelId')
  async disconnectChannel(@Param('channelId') channelId: string) {
    await this.findChannelOrThrow(channelId);
    await this.prisma.channel.update({
      where: { id: channelId },
      data: { status: 'inactive', credentials: { accessToken: null, tokenExpiresAt: null } },
    });
    this.logger.log(`Instagram channel disconnected: ${channelId}`);
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7. GET CHANNEL INFO (account details from Instagram)
  // GET /webhooks/instagram/channel/:channelId/info
  // ─────────────────────────────────────────────────────────────────────────

  @Get('channel/:channelId/info')
  async getChannelInfo(@Param('channelId') channelId: string) {
    const channel: any = await this.findChannelOrThrow(channelId);
    const igUser = await this.getIGUserInfo(channel.credentials.accessToken);
    return { success: true, data: igUser };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 8. SEND MESSAGE (text, image, video, audio, file, quick replies)
  // POST /webhooks/instagram/send
  // ─────────────────────────────────────────────────────────────────────────

  @Post('send')
  async sendMessage(@Body() dto: SendMessageDto) {
    const channel: any = await this.findChannelOrThrow(dto.channelId);

    const messagePayload = this.buildMessagePayload(dto);

    const { data } = await axios.post(
      `${IG_BASE}/${channel.identifier}/messages`,
      {
        recipient: { id: dto.recipientIgsid },
        message: messagePayload,
      },
      { params: { access_token: channel.credentials.accessToken } },
    );

    this.logger.log(`Message sent to ${dto.recipientIgsid}: ${data.message_id}`);
    return { success: true, messageId: data.message_id };
  }




  // ─────────────────────────────────────────────────────────────────────────
  // 12. GET CONTACT PROFILE (by IGSID)
  // GET /webhooks/instagram/channel/:channelId/contact/:igsid
  // ─────────────────────────────────────────────────────────────────────────

  @Get('channel/:channelId/contact/:igsid')
  async getContactProfile(
    @Param('channelId') channelId: string,
    @Param('igsid') igsid: string,
  ) {
    const channel: any = await this.findChannelOrThrow(channelId);

    const { data } = await axios.get(`${IG_BASE}/${igsid}`, {
      params: {
        fields: 'name,username,profile_pic',
        access_token: channel.credentials.accessToken,
      },
    });

    return { success: true, data };
  }


  // ─────────────────────────────────────────────────────────────────────────
  // 16. MARK MESSAGE AS READ
  // POST /webhooks/instagram/channel/:channelId/mark-read
  // ─────────────────────────────────────────────────────────────────────────

  @Post('channel/:channelId/mark-read')
  async markAsRead(
    @Param('channelId') channelId: string,
    @Body('recipientIgsid') recipientIgsid: string,
  ) {
    const channel: any = await this.findChannelOrThrow(channelId);

    const { data } = await axios.post(
      `${IG_BASE}/${channel.identifier}/messages`,
      {
        recipient: { id: recipientIgsid },
        sender_action: 'mark_seen',
      },
      { params: { access_token: channel.accessToken } },
    );

    return { success: true, data };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 17. TYPING INDICATOR
  // POST /webhooks/instagram/channel/:channelId/typing
  // ─────────────────────────────────────────────────────────────────────────

  @Post('channel/:channelId/typing')
  async sendTyping(
    @Param('channelId') channelId: string,
    @Body('recipientIgsid') recipientIgsid: string,
    @Body('action') action: 'typing_on' | 'typing_off' = 'typing_on',
  ) {
    const channel: any = await this.findChannelOrThrow(channelId);

    const { data } = await axios.post(
      `${IG_BASE}/${channel.identifier}/messages`,
      {
        recipient: { id: recipientIgsid },
        sender_action: action,
      },
      { params: { access_token: channel.credentials.accessToken } },
    );

    return { success: true, data };
  }


  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  private async findChannelOrThrow(channelId: string) {
    const channel: any = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);
    if (!channel.credentials.accessToken) throw new UnauthorizedException(`Channel ${channelId} has no access token`);
    return channel;
  }

  private async exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID!,
      client_secret: process.env.INSTAGRAM_APP_SECRET!,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });

    const { data } = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    this.logger.log(`Exchanged code for token: ${JSON.stringify(data)}`);
    return data.access_token;
  }

  private async exchangeLongLivedToken(shortLivedToken: string) {
    const { data } = await axios.get(`${IG_BASE}/access_token`, {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: process.env.INSTAGRAM_APP_SECRET!,
        access_token: shortLivedToken,
      },
    });
    this.logger.log(`Exchanged for long-lived token: expires_in=${JSON.stringify(data)}`);
    return data; // { access_token, token_type, expires_in }
  }

  private async getIGUserInfo(accessToken: string) {
    const { data } = await axios.get(`${IG_BASE}/me`, {
      params: {
        fields: 'id,username,account_type,media_count,user_id',
        access_token: accessToken,
      },
    });
    return data;
  }
  private async getIGBusinessAccountId(accessToken: string): Promise<string> {
    const { data } = await axios.get(`${IG_BASE}/me/accounts`, {
      params: { access_token: accessToken },
    });
    // Returns the page/business account ID = 17841473852821256
    return data?.data?.[0]?.instagram_business_account?.id ?? data?.data?.[0]?.id;
  }

  private buildMessagePayload(dto: SendMessageDto): any {
    // Quick replies
    if (dto.quickReplies?.length) {
      return {
        text: dto.text,
        quick_replies: dto.quickReplies.map((qr) => ({
          content_type: 'text',
          title: qr.title,
          payload: qr.payload,
        })),
      };
    }

    // Sticker
    if (dto.stickerId) {
      return { attachment: { type: 'like_heart' } };
    }

    // Image
    if (dto.imageUrl) {
      return {
        attachment: {
          type: 'image',
          payload: { url: dto.imageUrl, is_reusable: true },
        },
      };
    }

    // Video
    if (dto.videoUrl) {
      return {
        attachment: {
          type: 'video',
          payload: { url: dto.videoUrl, is_reusable: true },
        },
      };
    }

    // Audio
    if (dto.audioUrl) {
      return {
        attachment: {
          type: 'audio',
          payload: { url: dto.audioUrl, is_reusable: true },
        },
      };
    }

    // File
    if (dto.fileUrl) {
      return {
        attachment: {
          type: 'file',
          payload: { url: dto.fileUrl, is_reusable: true },
        },
      };
    }

    // Default: plain text
    return { text: dto.text };
  }
}