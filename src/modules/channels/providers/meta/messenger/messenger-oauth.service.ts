import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Channel } from '@prisma/client';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChannelOAuthEventsService } from 'src/modules/channels/oauth/channel-oauth-events.service';
import { ChannelOAuthStateService } from 'src/modules/channels/oauth/channel-oauth-state.service';
import { buildOAuthCallbackPage } from 'src/modules/channels/oauth/oauth-callback-page.util';
import { RedisService } from 'src/redis/redis.service';

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

interface MessengerOAuthPage {
  id: string;
  name: string;
  category?: string | null;
  access_token: string;
  tasks?: string[];
  pictureUrl?: string | null;
}

interface MessengerPageSelection {
  workspaceId: string;
  userId: string;
  pages: MessengerOAuthPage[];
  createdAt: string;
}

@Injectable()
export class MessengerOAuthService {
  private readonly logger = new Logger(MessengerOAuthService.name);
  private readonly pageSelectionTtlSeconds = 10 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ChannelOAuthStateService,
    private readonly events: ChannelOAuthEventsService,
    private readonly redis: RedisService,
  ) {}

  buildAuthUrl(input: {
    workspaceId: string;
    userId: string;
   
  }) {
    const callbackUri = process.env.MESSENGER_REDIRECT_URI;
    if (!callbackUri) {
      throw new BadRequestException('Messenger redirect URI is not configured.');
    }

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
    const fallbackRedirectUri = this.getMessengerConnectRedirectUri(
      input.requestOrigin,
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
          providerKey: 'messenger',
          status: 'error',
          message: 'This authorization link is invalid or has expired.',
          redirectUri: fallbackRedirectUri,
          redirectPayload: {
            oauthProvider: 'messenger',
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
          providerKey: 'messenger',
          status: 'error',
          message,
          redirectUri: fallbackRedirectUri,
          redirectPayload: {
            oauthProvider: 'messenger',
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

      return {
        html: buildOAuthCallbackPage({
          provider: 'Facebook Messenger',
          providerKey: 'messenger',
          status: 'success',
          title: 'Facebook Messenger authorized',
          message: 'Facebook authorization is complete. Choose the Pages to connect in AxoDesk.',
          redirectUri: fallbackRedirectUri,
          payload: {
            code: input.code,
            state: input.state,
            workspaceId: oauthState.workspaceId,
          },
          redirectPayload: {
            oauthProvider: 'messenger',
            oauthStatus: 'success',
            code: input.code,
            state: input.state,
          },
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
          providerKey: 'messenger',
          status: 'error',
          message,
          redirectUri: fallbackRedirectUri,
          redirectPayload: {
            oauthProvider: 'messenger',
            oauthStatus: 'error',
            error: message,
          },
        }),
      };
    }
  }

  async preparePageSelection(input: {
    code: string;
    workspaceId: string;
    userId: string;
    state: string;
  }) {
    const oauthState = this.state.parseState(input.state, 'messenger');

    if (
      oauthState.workspaceId !== input.workspaceId ||
      oauthState.userId !== input.userId
    ) {
      throw new BadRequestException('OAuth state does not match the current workspace.');
    }

    await this.ensureWorkspaceMembership(input.workspaceId, input.userId);

    const shortLivedUserToken = await this.exchangeCodeForUserToken(
      input.code,
      oauthState.redirectUri,
    );
    const longLivedUserToken = await this.exchangeLongLivedUserToken(
      shortLivedUserToken,
    );
    const pages = await this.fetchProfile(longLivedUserToken);

    if (!pages.length) {
      throw new BadRequestException('No Facebook Pages found.');
    }

    const pagesWithPictures = await Promise.all(
      pages.map(async (page) => {
        const pageInfo = await this.getPageInfo(page.id, page.access_token);

        return {
          ...page,
          pictureUrl: pageInfo?.picture?.data?.url ?? null,
        };
      }),
    );

    const selectionId = randomUUID();
    const selection: MessengerPageSelection = {
      workspaceId: input.workspaceId,
      userId: input.userId,
      pages: pagesWithPictures,
      createdAt: new Date().toISOString(),
    };

    await this.redis.client.set(
      this.getPageSelectionKey(selectionId),
      JSON.stringify(selection),
      'EX',
      this.pageSelectionTtlSeconds,
    );

    return {
      selectionId,
      expiresInSeconds: this.pageSelectionTtlSeconds,
      pages: pagesWithPictures.map((page) => ({
        id: page.id,
        name: page.name,
        category: page.category ?? null,
        tasks: page.tasks ?? [],
        pictureUrl: page.pictureUrl ?? null,
      })),
    };
  }

  async connectSelectedPages(input: {
    selectionId: string;
    selectedPageIds: string[];
    workspaceId: string;
    userId: string;
  }) {
    if (!input.selectedPageIds.length) {
      throw new BadRequestException('Select at least one Facebook Page.');
    }

    await this.ensureWorkspaceMembership(input.workspaceId, input.userId);

    const selection = await this.getPageSelection(input.selectionId);
    if (
      !selection ||
      selection.workspaceId !== input.workspaceId ||
      selection.userId !== input.userId
    ) {
      throw new BadRequestException('Messenger Page selection has expired. Please reconnect with Facebook.');
    }

    const selectedIds = [...new Set(input.selectedPageIds)];
    const selectedPages = selectedIds
      .map((pageId) => selection.pages.find((page) => page.id === pageId))
      .filter((page): page is MessengerOAuthPage => Boolean(page));

    if (selectedPages.length !== selectedIds.length) {
      throw new BadRequestException('One or more selected Facebook Pages are not available.');
    }

    const connectedChannels: Channel[] = [];

    for (const page of selectedPages) {
      const pageToken = page.access_token;
      const pageInfo = await this.getPageInfo(page.id, pageToken);
      await this.subscribePageToWebhook(page.id, pageToken);

      const existingChannel = await this.prisma.channel.findUnique({
        where: { identifier: page.id },
      });

      if (
        existingChannel &&
        (existingChannel.workspaceId !== input.workspaceId ||
          existingChannel.type !== 'messenger')
      ) {
        throw new BadRequestException(
          `${page.name} is already connected to another channel.`,
        );
      }

      const credentials = {
        accessToken: pageToken,
        tokenLastValidatedAt: new Date().toISOString(),
      };
      const config = {
        pageName: page.name,
        pageCategory: page.category ?? null,
        pagePicture: pageInfo?.picture?.data?.url ?? null,
        tokenNeverExpires: true,
        subscribedFields: MESSENGER_WEBHOOK_FIELDS,
      };

      const channel = existingChannel
        ? await this.prisma.channel.update({
            where: { id: existingChannel.id },
            data: {
              credentials,
              name: page.name,
              status: 'connected',
              config,
            },
          })
        : await this.prisma.channel.create({
            data: {
              workspaceId: input.workspaceId,
              type: 'messenger',
              identifier: page.id,
              name: page.name,
              credentials,
              status: 'connected',
              config,
            },
          });

      connectedChannels.push(channel);
      this.logger.log(`Messenger page connected: ${page.name} (${page.id})`);
    }

    await this.redis.client.del(this.getPageSelectionKey(input.selectionId));

    return connectedChannels;
  }

  private async getPageSelection(selectionId: string) {
    const raw = await this.redis.client.get(this.getPageSelectionKey(selectionId));
    return raw ? (JSON.parse(raw) as MessengerPageSelection) : null;
  }

  private getPageSelectionKey(selectionId: string) {
    return `channel_oauth:messenger:page_selection:${selectionId}`;
  }

  private getMessengerConnectRedirectUri(requestOrigin?: string) {
    const base =
      process.env.APP_URL ??
      requestOrigin ??
      'http://localhost:3000';

    return `${base.replace(/\/api\/?$/, '').replace(/\/$/, '')}/channels/connect/messenger`;
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

    return (data.data ?? []) as MessengerOAuthPage[];
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
