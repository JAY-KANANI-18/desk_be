import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Public, WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { InboundService } from 'src/modules/inbound/inbound.service';
import { MessageProcessingQueueService } from 'src/modules/outbound/message-processing-queue.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChannelService } from '../../channel.service';

@Controller('api/integrations/meta-ads')
export class MetaAdsController {
  private readonly logger = new Logger(MetaAdsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbound: InboundService,
    private readonly events: EventEmitter2,
    private readonly channelService: ChannelService,
    private readonly processingQueue: MessageProcessingQueueService,
  ) {}

  @Get('oauth/url')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  oauthUrl(@Req() req: any) {
    const workspaceId = req.workspaceId as string;
    const state = encodeURIComponent(JSON.stringify({ workspaceId }));
    const redirectUri =
      process.env.META_ADS_REDIRECT_URI || process.env.META_REDIRECT_URI || '';
    const url =
      `https://www.facebook.com/v19.0/dialog/oauth` +
      `?client_id=${process.env.META_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent('ads_management,business_management')}` +
      `&state=${state}`;

    return { url, redirectUri };
  }

  @Post('oauth/exchange')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  async oauthExchange(@Req() req: any, @Body() body: { code: string }) {
    const workspaceId = req.workspaceId as string;
    if (!body?.code) {
      throw new BadRequestException('code is required');
    }
    const channel = await this.channelService.connectMetaAdsOAuthCode(body.code, workspaceId);
    return {
      channelId: channel.id,
      name: channel.name,
      config: channel.config,
    };
  }

  @Get('status')
  @WorkspaceRoute()
  async status(@Req() req: any) {
    const workspaceId = req.workspaceId as string;
    const row = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'meta_ads' },
    });
    if (!row) {
      return { connected: false };
    }
    const cfg = (row.config || {}) as Record<string, unknown>;
    let campaignCount = cfg.campaignCount as number | undefined;
    const token = (row.credentials as { accessToken?: string })?.accessToken;
    const accountId = cfg.accountId as string;
    if (token && accountId) {
      try {
        const cRes = await fetch(
          `https://graph.facebook.com/v19.0/${accountId}/campaigns?fields=id&limit=1&summary=true&access_token=${token}`,
        );
        const cJson = await cRes.json();
        if (cJson.summary?.total_count != null) {
          campaignCount = cJson.summary.total_count;
          await this.prisma.channel.update({
            where: { id: row.id },
            data: { config: { ...cfg, campaignCount } },
          });
        }
      } catch {
        /* keep cached */
      }
    }
    return {
      connected: true,
      channelId: row.id,
      name: row.name,
      accountName: cfg.accountName,
      accountId: cfg.accountId,
      accountStatus: cfg.accountStatus,
      currency: cfg.currency,
      campaignCount,
    };
  }

  @Delete()
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  async disconnect(@Req() req: any) {
    const workspaceId = req.workspaceId as string;
    await this.prisma.channel.deleteMany({
      where: { workspaceId, type: 'meta_ads' },
    });
    return { disconnected: true };
  }

  @Post('webhook')
  @Public()
  @HttpCode(200)
  async webhook( @Req() req: any) {
    console.dir({body:req.body},{depth:null});
    
    const  channelId =""
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.type !== 'meta_ads') return { status: 'channel_not_found' };

    const body = req.body || {};
    const leadId = String(body?.leadgen_id || body?.leadId || body?.id || `lead-${Date.now()}`);
    const email = body?.email || body?.customer_email || null;
    const phone = body?.phone || body?.customer_phone || null;
    const identifier = phone || email || leadId;
    const adId = String(body?.ad_id || body?.adId || '');
    const campaignId = String(body?.campaign_id || body?.campaignId || '');

    await this.processingQueue.enqueueInboundProcess({
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      channelType: 'meta_ads',
      contactIdentifier: identifier,
      direction: 'incoming',
      messageType: 'lead_event',
      text: body?.message || 'Meta ad lead/click event',
      attachments: [],
      metadata: {
        provider: 'meta_ads',
        leadId,
        adId,
        campaignId,
        eventName: body?.event_name || body?.eventName || 'meta_ad_click',
      },
      raw: body,
    });

    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: { workspaceId: channel.workspaceId, channelId: channel.id, identifier },
      include: { contact: true },
    });

    if (contactChannel?.contactId) {
      this.events.emit('meta_ads.click', {
        workspaceId: channel.workspaceId,
        contactId: contactChannel.contactId,
        conversationId: null,
        triggerData: { leadId, adId, campaignId, identifier, raw: body },
      });
    }

    this.logger.debug(`Meta ads webhook handled channel=${channelId} lead=${leadId}`);
    return { status: 'ok' };
  }
}
