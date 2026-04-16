import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChannelOAuthEventsService } from 'src/modules/channels/oauth/channel-oauth-events.service';
import { ChannelOAuthStateService } from 'src/modules/channels/oauth/channel-oauth-state.service';
import { buildOAuthCallbackPage } from 'src/modules/channels/oauth/oauth-callback-page.util';
import { resolveCallbackUrl } from 'src/modules/channels/oauth/oauth-url.util';

const FB_API = 'https://graph.facebook.com';
const FB_API_VERSION = 'v22.0';
const FB_BASE = `${FB_API}/${FB_API_VERSION}`;

export const MESSENGER_OAUTH_SCOPES = [
  'pages_manage_metadata',//
  'pages_read_engagement',
  'business_management',
  'pages_messaging',
  'public_profile',
  'email',
  // 'pages_messaging_phone_number',
  'pages_utility_messaging',
];

export const MESSENGER_WEBHOOK_FIELDS = [
  'messages',
  'message_echoes',
  'messaging_postbacks',
  'messaging_optins',
  'message_deliveries',
  'message_reads',
  'messaging_referrals',
  'feed',
];

@Injectable()
export class MessengerOAuthService {
  private readonly logger = new Logger(MessengerOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ChannelOAuthStateService,
    private readonly events: ChannelOAuthEventsService,
  ) {}

  buildAuthUrl(input: {
    workspaceId: string;
    userId: string;
   
  }) {
    const callbackUri = process.env.MESSENGER_REDIRECT_URI
    const oauthState = this.state.createState({
      provider: 'messenger',
      userId: input.userId,
      workspaceId: input.workspaceId,
      redirectUri: callbackUri,

    });

    const params = new URLSearchParams({
      client_id: process.env.MESSENGER_APP_ID!,
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: MESSENGER_OAUTH_SCOPES.join(','),
      state: oauthState,
    });

    return `https://www.facebook.com/dialog/oauth?${params.toString()}`;
  }

  async handleBrowserCallback(input: {
    code?: string;
    error?: string;
    errorDescription?: string;
    state?: string;
    requestOrigin?: string;
  }) {
    const fallbackRedirectUri = this.state.getDefaultRedirectUri(
    );

    let oauthState:
      | ReturnType<ChannelOAuthStateService['parseState']>
      | null = null;

    try {
      oauthState = this.state.parseState(input.state, 'messenger');
    } catch {
      return {
        html: buildOAuthCallbackPage({
          provider: 'Facebook Messenger',
          status: 'error',
          message: 'This authorization link is invalid or has expired.',
          redirectUri: fallbackRedirectUri,
        }),
      };
    }

    if (input.error || !input.code) {
      const message =
        input.errorDescription ??
        input.error ??
        'Facebook authorization was cancelled.';

      await this.events.emitError({
        provider: 'messenger',
        userId: oauthState.userId,
        workspaceId: oauthState.workspaceId,
        error: message,
      });

      return {
        html: buildOAuthCallbackPage({
          provider: 'Facebook Messenger',
          status: 'error',
          message,
          redirectUri: fallbackRedirectUri,
        }),
      };
    }

    try {
      await this.ensureWorkspaceMembership(
        oauthState.workspaceId,
        oauthState.userId,
      );

      const channels = await this.connectWithCode({
        code: input.code,
        redirectUri:oauthState.redirectUri ,
        workspaceId: oauthState.workspaceId,
      });

      if (!channels.length) {
        throw new BadRequestException('No Facebook Pages were connected.');
      }

      for (const channel of channels) {
        await this.events.emitConnected({
          provider: 'messenger',
          userId: oauthState.userId,
          workspaceId: oauthState.workspaceId,
          channel,
        });
      }

      return {
        html: buildOAuthCallbackPage({
          provider: 'Facebook Messenger',
          status: 'success',
          message: `Connected ${channels.length} Facebook Page${channels.length > 1 ? 's' : ''}.`,
          redirectUri: fallbackRedirectUri,
        }),
      };
    } catch (error: any) {
      const message = this.getErrorMessage(
        error,
        'Facebook Messenger connection failed.',
      );

      await this.events.emitError({
        provider: 'messenger',
        userId: oauthState.userId,
        workspaceId: oauthState.workspaceId,
        error: message,
      });

      return {
        html: buildOAuthCallbackPage({
          provider: 'Facebook Messenger',
          status: 'error',
          message,
          redirectUri: fallbackRedirectUri,
        }),
      };
    }
  }

  async connectWithCode(input: {
    code: string;
    redirectUri: string;
    workspaceId: string;
  }) {
    const shortLivedUserToken = await this.exchangeCodeForUserToken(
      input.code,
      input.redirectUri,
    );
    const longLivedUserToken = await this.exchangeLongLivedUserToken(
      shortLivedUserToken,
    );
    const pages = await this.fetchProfile(longLivedUserToken);

    if (!pages.length) {
      throw new BadRequestException('No Facebook Pages found.');
    }

    const connectedChannels: any[] = [];

    for (const page of pages) {
      const pageToken = page.access_token;
      const pageInfo = await this.getPageInfo(page.id, pageToken);
      await this.subscribePageToWebhook(page.id, pageToken);

      const existingChannel = await this.prisma.channel.findFirst({
        where: {
          type: 'messenger',
          identifier: page.id,
        },
      });

      const channelData = {
        workspaceId: input.workspaceId,
        type: 'messenger',
        identifier: page.id,
        name: page.name,
        credentials: {
          accessToken: pageToken,
          tokenLastValidatedAt: new Date(),
        },
        status: 'connected',
        config: {
          pageName: page.name,
          pageCategory: page.category,
          pagePicture: pageInfo?.picture?.data?.url,
          tokenNeverExpires: true,
          subscribedFields: MESSENGER_WEBHOOK_FIELDS,
        },
      };

      const channel = existingChannel
        ? await this.prisma.channel.update({
            where: { id: existingChannel.id },
            data: channelData,
          })
        : await this.prisma.channel.create({ data: channelData });

      connectedChannels.push(channel);
      this.logger.log(`Messenger page connected: ${page.name} (${page.id})`);
    }

    return connectedChannels;
  }

  async exchangeCodeForUserToken(code: string, redirectUri: string) {
    const { data } = await axios.get(`${FB_BASE}/oauth/access_token`, {
      params: {
        client_id: process.env.MESSENGER_APP_ID!,
        client_secret: process.env.MESSENGER_APP_SECRET!,
        redirect_uri: redirectUri,
        code,
      },
    });

    return data.access_token as string;
  }

  async fetchProfile(userToken: string) {
    const { data } = await axios.get(`${FB_BASE}/me/accounts`, {
      params: {
        fields: 'id,name,access_token,category,tasks',
        access_token: userToken,
      },
    });

    return (data.data ?? []) as Array<{
      id: string;
      name: string;
      category: string;
      access_token: string;
    }>;
  }

  private async ensureWorkspaceMembership(workspaceId: string, userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
        status: 'active',
      },
      select: { id: true },
    });

    if (!membership) {
      throw new BadRequestException(
        'You no longer have access to this workspace.',
      );
    }
  }

  private async exchangeLongLivedUserToken(shortLivedToken: string) {
    const { data } = await axios.get(`${FB_BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.MESSENGER_APP_ID!,
        client_secret: process.env.MESSENGER_APP_SECRET!,
        fb_exchange_token: shortLivedToken,
      },
    });

    return data.access_token as string;
  }

  private async getPageInfo(pageId: string, pageToken: string) {
    try {
      const { data } = await axios.get(`${FB_BASE}/${pageId}`, {
        params: {
          fields: 'id,name,picture,category',
          access_token: pageToken,
        },
      });

      return data;
    } catch {
      return null;
    }
  }

  private async subscribePageToWebhook(pageId: string, pageToken: string) {
    await axios.post(
      `${FB_BASE}/${pageId}/subscribed_apps`,
      {
        subscribed_fields: [
          'messages',
          'message_echoes',
          'messaging_postbacks',
          'messaging_optins',
          'message_deliveries',
          'message_reads',
          'messaging_referrals',
  'feed',       // 👈 ADD THIS ALSO (important)
        ],
      },
      { params: { access_token: pageToken } },
    );
    this.logger.log(
      `Messenger page ${pageId} subscribed fields=${MESSENGER_WEBHOOK_FIELDS.join(',')}`,
    );
  }

  private getErrorMessage(error: any, fallback: string) {
    return (
      error?.response?.data?.error?.message ??
      error?.response?.data?.error_message ??
      error?.response?.data?.message ??
      error?.message ??
      fallback
    );
  }
}
