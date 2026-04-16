import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChannelOAuthEventsService } from 'src/modules/channels/oauth/channel-oauth-events.service';
import { ChannelOAuthStateService } from 'src/modules/channels/oauth/channel-oauth-state.service';
import { buildOAuthCallbackPage } from 'src/modules/channels/oauth/oauth-callback-page.util';
import { resolveCallbackUrl } from 'src/modules/channels/oauth/oauth-url.util';

const IG_API = 'https://graph.instagram.com';
const IG_API_VERSION = 'v21.0';
const IG_BASE = `${IG_API}/${IG_API_VERSION}`;

@Injectable()
export class InstagramOAuthService {
  private readonly logger = new Logger(InstagramOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ChannelOAuthStateService,
    private readonly events: ChannelOAuthEventsService,
  ) {}

  buildAuthUrl(input: {
    workspaceId: string;
    userId: string;
  }) {
    const callbackUri = process.env.INSTAGRAM_REDIRECT_URI
    const oauthState = this.state.createState({
      provider: 'instagram',
      userId: input.userId,
      workspaceId: input.workspaceId,
      redirectUri: callbackUri,
    });

    const params = new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID!,
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: [
        'instagram_business_basic',
        'instagram_business_manage_messages',
        'instagram_business_manage_comments',
          'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging'

      ].join(','),
      state: oauthState,
    });

    return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
  }

  async handleBrowserCallback(input: {
    code?: string;
    error?: string;
    errorDescription?: string;
    state?: string;
    requestOrigin?: string;
  }) {
    const redirectUri = this.getFallbackRedirectUri();

    let oauthState:
      | ReturnType<ChannelOAuthStateService['parseState']>
      | null = null;

    try {
      oauthState = this.state.parseState(input.state, 'instagram');
    } catch (error) {
      console.log({error});
      
      return {
        html: buildOAuthCallbackPage({
          provider: 'Instagram',
          status: 'error',
          message: 'This authorization link is invalid or has expired.',
          redirectUri,
        }),
      };
    }

    if (input.error || !input.code) {
      const message =
        input.errorDescription ??
        input.error ??
        'Instagram authorization was cancelled.';

      await this.events.emitError({
        provider: 'instagram',
        userId: oauthState.userId,
        workspaceId: oauthState.workspaceId,
        error: message,
      });

      return {
        html: buildOAuthCallbackPage({
          provider: 'Instagram',
          status: 'error',
          message,
          redirectUri: redirectUri,
        }),
      };
    }

    try {
      await this.ensureWorkspaceMembership(
        oauthState.workspaceId,
        oauthState.userId,
      );

      const channel = await this.connectWithCode({
        code: input.code,
        redirectUri:oauthState.redirectUri ,
        workspaceId: oauthState.workspaceId,
      });

      await this.events.emitConnected({
        provider: 'instagram',
        userId: oauthState.userId,
        workspaceId: oauthState.workspaceId,
        channel,
      });

      return {
        html: buildOAuthCallbackPage({
          provider: 'Instagram',
          status: 'success',
          message: 'Instagram is now connected to your workspace.',
          redirectUri: redirectUri,
        }),
      };
    } catch (error: any) {
      const message = this.getErrorMessage(
        error,
        'Instagram connection failed.',
      );

      await this.events.emitError({
        provider: 'instagram',
        userId: oauthState.userId,
        workspaceId: oauthState.workspaceId,
        error: message,
      });
      console.log({oauthState});
      
      return {
        html: buildOAuthCallbackPage({
          provider: 'Instagram',
          status: 'error',
          message,
          redirectUri: redirectUri,
        }),
      };
    }
  }

  async connectWithCode(input: {
    code: string;
    redirectUri: string;
    workspaceId: string;
  }) {
    const shortLivedToken = await this.exchangeCodeForToken(
      input.code,
      input.redirectUri,
    );
    const { access_token: longLivedToken, expires_in } =
      await this.exchangeLongLivedToken(shortLivedToken);

    const igUser = await this.fetchProfile(longLivedToken);
    await this.subscribeToWebhook(igUser.id, longLivedToken);

    const identifier = igUser.user_id ?? igUser.id;
    const expiresAt = new Date(Date.now() + expires_in * 1000);
    const existingChannel = await this.prisma.channel.findFirst({
      where: {
        type: 'instagram',
        identifier,
      },
    });

    const channelData = {
      workspaceId: input.workspaceId,
      type: 'instagram',
      identifier,
      name: igUser.username,
      credentials: {
        accessToken: longLivedToken,
        tokenExpiresAt: expiresAt,
        igUserId: igUser.id,
      },
      config: {
        userName: igUser.username,
        accountType: igUser.account_type,
        mediaCount: igUser.media_count,
        igUserId: igUser.id,
      },
      status: 'connected',
    };

    const channel = existingChannel
      ? await this.prisma.channel.update({
          where: { id: existingChannel.id },
          data: channelData,
        })
      : await this.prisma.channel.create({ data: channelData });

    this.logger.log(
      `Instagram channel connected: ${igUser.username} (${identifier})`,
    );

    return channel;
  }

  async exchangeCodeForToken(code: string, redirectUri: string) {
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

    return data.access_token as string;
  }

  async fetchProfile(accessToken: string) {
    const { data } = await axios.get(`${IG_BASE}/me`, {
      params: {
        fields: 'id,username,account_type,media_count,user_id',
        access_token: accessToken,
      },
    });

    return data;
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

  private async exchangeLongLivedToken(shortLivedToken: string) {
    const { data } = await axios.get(`${IG_BASE}/access_token`, {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: process.env.INSTAGRAM_APP_SECRET!,
        access_token: shortLivedToken,
      },
    });

    return data as { access_token: string; expires_in: number };
  }

  private async subscribeToWebhook(igUserId: string, accessToken: string) {
    try {
      await axios.post(
        `${IG_BASE}/${igUserId}/subscribed_apps`,
        {},
        {
          params: {
            access_token: accessToken,
            subscribed_fields: [
              'messages',
              'messaging_postbacks',
              'messaging_optins',
              'messaging_seen',
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
    } catch (error: any) {
      this.logger.warn(
        `Failed to subscribe Instagram webhook: ${this.getErrorMessage(error, 'subscription_failed')}`,
      );
    }
  }

  private getFallbackRedirectUri() {
    return this.state.getDefaultRedirectUri();
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
