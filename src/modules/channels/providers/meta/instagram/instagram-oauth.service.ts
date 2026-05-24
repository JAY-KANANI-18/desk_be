import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChannelOAuthEventsService } from 'src/modules/channels/oauth/channel-oauth-events.service';
import { ChannelOAuthStateService } from 'src/modules/channels/oauth/channel-oauth-state.service';
import { buildOAuthCallbackPage } from 'src/modules/channels/oauth/oauth-callback-page.util';

const IG_API = 'https://graph.instagram.com';
const IG_API_VERSION = 'v21.0';
const IG_BASE = `${IG_API}/${IG_API_VERSION}`;

export const INSTAGRAM_WEBHOOK_FIELDS = [
   'messages',
  'messaging_postbacks',
  'messaging_seen',
  'messaging_optins',
  'messaging_referral',
  'messaging_handover',
  'message_reactions',
  'standby',
  'comments',
  'live_comments',
  'mentions',
];

interface InstagramProfile {
  id: string;
  username: string;
  account_type?: string | null;
  media_count?: number | null;
  user_id?: string | null;
}

type InstagramWebhookSubscribeResponse = Prisma.InputJsonObject & {
  success?: boolean;
};

type InstagramWebhookSubscriptionResult = Prisma.InputJsonObject & {
  status: 'subscribed' | 'failed';
  subscribedAt?: string;
  attemptedAt?: string;
  error?: string;
  response?: InstagramWebhookSubscribeResponse;
};

@Injectable()
export class InstagramOAuthService {
  private readonly logger = new Logger(InstagramOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ChannelOAuthStateService,
    private readonly events: ChannelOAuthEventsService,
  ) { }

  buildAuthUrl(input: {
    workspaceId: string;
    userId: string;
  }) {
    const callbackUri = process.env.INSTAGRAM_REDIRECT_URI;
    if (!callbackUri) {
      throw new BadRequestException('Instagram redirect URI is not configured.');
    }

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
      force_reauth: 'true',
      scope: [
        'instagram_business_basic',
        'instagram_business_manage_messages',
        'instagram_business_manage_comments',
        'instagram_business_content_publish',
        'instagram_business_manage_insights',


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
    const redirectUri = this.getInstagramConnectRedirectUri(input.requestOrigin);

    let oauthState:
      | ReturnType<ChannelOAuthStateService['parseState']>
      | null = null;

    try {
      oauthState = this.state.parseState(input.state, 'instagram');
    } catch {
      return {
        html: buildOAuthCallbackPage({
          provider: 'Instagram',
          providerKey: 'instagram',
          status: 'error',
          message: 'This authorization link is invalid or has expired.',
          redirectUri,
          redirectPayload: {
            oauthProvider: 'instagram',
            oauthStatus: 'error',
            error: 'This authorization link is invalid or has expired.',
          },
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
          providerKey: 'instagram',
          status: 'error',
          message,
          redirectUri: redirectUri,
          redirectPayload: {
            oauthProvider: 'instagram',
            oauthStatus: 'error',
            error: message,
          },
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
        redirectUri: oauthState.redirectUri,
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
          providerKey: 'instagram',
          status: 'success',
          message: 'Instagram is now connected to your workspace.',
          redirectUri: redirectUri,
          redirectPayload: {
            oauthProvider: 'instagram',
            oauthStatus: 'success',
          },
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

      return {
        html: buildOAuthCallbackPage({
          provider: 'Instagram',
          providerKey: 'instagram',
          status: 'error',
          message,
          redirectUri: redirectUri,
          redirectPayload: {
            oauthProvider: 'instagram',
            oauthStatus: 'error',
            error: message,
          },
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
    const webhookSubscription = await this.subscribeToWebhook(
      igUser.id,
      longLivedToken,
    );

    const identifier = igUser.user_id ?? igUser.id;
    const expiresAt = new Date(Date.now() + expires_in * 1000);
    const existingChannel = await this.prisma.channel.findUnique({
      where: { identifier },
      select: { id: true, workspaceId: true, type: true },
    });

    if (
      existingChannel &&
      (existingChannel.workspaceId !== input.workspaceId ||
        existingChannel.type !== 'instagram')
    ) {
      throw new BadRequestException(
        `${igUser.username} is already connected to another channel.`,
      );
    }

    const credentials: Prisma.InputJsonObject = {
      accessToken: longLivedToken,
      tokenExpiresAt: expiresAt.toISOString(),
      igUserId: igUser.id,
    };
    const config: Prisma.InputJsonObject = {
      userName: igUser.username,
      accountType: igUser.account_type ?? null,
      mediaCount: igUser.media_count ?? null,
      igUserId: igUser.id,
      subscribedFields: INSTAGRAM_WEBHOOK_FIELDS,
      webhookSubscription,
    };

    const channel = existingChannel
      ? await this.prisma.channel.update({
          where: { id: existingChannel.id },
          data: {
            credentials,
            name: igUser.username,
            status: 'connected',
            config,
          },
        })
      : await this.prisma.channel.create({
          data: {
            workspaceId: input.workspaceId,
            type: 'instagram',
            identifier,
            name: igUser.username,
            credentials,
            status: 'connected',
            config,
          },
        });

    this.logger.log(
      `Instagram channel connected: ${igUser.username} (${identifier}) subscribedFields=${INSTAGRAM_WEBHOOK_FIELDS.join(',')}`,
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

  async fetchProfile(accessToken: string): Promise<InstagramProfile> {
    const { data } = await axios.get<InstagramProfile>(`${IG_BASE}/me`, {
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

  private async subscribeToWebhook(
    igUserId: string,
    accessToken: string,
  ): Promise<InstagramWebhookSubscriptionResult> {
    try {
      const { data } = await axios.post<InstagramWebhookSubscribeResponse>(
        `${IG_BASE}/${igUserId}/subscribed_apps`,
        {},
        {
          params: {
            access_token: accessToken,
            subscribed_fields: INSTAGRAM_WEBHOOK_FIELDS.join(','),
          },
        },
      );

      if (data.success !== true) {
        const message = `Instagram webhook subscription returned success=${String(data.success)}.`;
        this.logger.warn(
          `Failed to subscribe Instagram webhook for ${igUserId} fields=${INSTAGRAM_WEBHOOK_FIELDS.join(',')}: ${message}`,
        );

        return {
          status: 'failed',
          attemptedAt: new Date().toISOString(),
          error: message,
          response: data,
        };
      }

      this.logger.log(
        `Instagram user ${igUserId} subscribed fields=${INSTAGRAM_WEBHOOK_FIELDS.join(',')}`,
      );

      return {
        status: 'subscribed',
        subscribedAt: new Date().toISOString(),
        response: data,
      };
    } catch (error: any) {
      const message = this.getErrorMessage(error, 'subscription_failed');
      this.logger.warn(
        `Failed to subscribe Instagram webhook for ${igUserId} fields=${INSTAGRAM_WEBHOOK_FIELDS.join(',')}: ${message}`,
      );

      return {
        status: 'failed',
        attemptedAt: new Date().toISOString(),
        error: message,
      };
    }
  }

  private getInstagramConnectRedirectUri(requestOrigin?: string) {
    const base =
      process.env.APP_URL ??
      requestOrigin ??
      'http://localhost:3000';

    return `${base.replace(/\/api\/?$/, '').replace(/\/$/, '')}/channels/connect/instagram`;
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
