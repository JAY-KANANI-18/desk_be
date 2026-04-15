import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChannelOAuthEventsService } from 'src/modules/channels/oauth/channel-oauth-events.service';
import { ChannelOAuthStateService } from 'src/modules/channels/oauth/channel-oauth-state.service';
import { buildOAuthCallbackPage } from 'src/modules/channels/oauth/oauth-callback-page.util';
import { resolveCallbackUrl } from 'src/modules/channels/oauth/oauth-url.util';

const FB_BASE = 'https://graph.facebook.com/v22.0';

@Injectable()
export class WhatsAppOAuthService {
  private readonly logger = new Logger(WhatsAppOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ChannelOAuthStateService,
    private readonly events: ChannelOAuthEventsService,
  ) {}

  buildAuthUrl(input: {
    workspaceId: string;
    userId: string;
 
  }) {
    const callbackUri = process.env.WHATSAPP_REDIRECT_URI
    const oauthState = this.state.createState({
      provider: 'whatsapp',
      userId: input.userId,
      workspaceId: input.workspaceId,
            redirectUri: callbackUri,


    });

    const params = new URLSearchParams({
      client_id: process.env.WHATSAPP_APP_ID!,
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: [
        'whatsapp_business_management',
        'whatsapp_business_messaging',
        'business_management',
      ].join(','),
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
      oauthState = this.state.parseState(input.state, 'whatsapp');
    } catch {
      return {
        html: buildOAuthCallbackPage({
          provider: 'WhatsApp',
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
        'WhatsApp authorization was cancelled.';

      await this.events.emitError({
        provider: 'whatsapp',
        userId: oauthState.userId,
        workspaceId: oauthState.workspaceId,
        error: message,
      });

      return {
        html: buildOAuthCallbackPage({
          provider: 'WhatsApp',
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
        throw new BadRequestException(
          'No WhatsApp phone numbers were connected.',
        );
      }

      for (const channel of channels) {
        await this.events.emitConnected({
          provider: 'whatsapp',
          userId: oauthState.userId,
          workspaceId: oauthState.workspaceId,
          channel,
        });
      }

      return {
        html: buildOAuthCallbackPage({
          provider: 'WhatsApp',
          status: 'success',
          message: `Connected ${channels.length} WhatsApp number${channels.length > 1 ? 's' : ''}.`,
          redirectUri: fallbackRedirectUri,
        }),
      };
    } catch (error: any) {
      const message = this.getErrorMessage(
        error,
        'WhatsApp connection failed.',
      );

      await this.events.emitError({
        provider: 'whatsapp',
        userId: oauthState.userId,
        workspaceId: oauthState.workspaceId,
        error: message,
      });

      return {
        html: buildOAuthCallbackPage({
          provider: 'WhatsApp',
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
    const shortLivedUserToken = await this.exchangeCodeForToken(
      input.code,
      input.redirectUri,
    );
    const { accessToken, expiresIn } =
      await this.exchangeLongLivedUserToken(shortLivedUserToken);
    const wabas = await this.fetchProfile(accessToken);

    if (!wabas.length) {
      throw new BadRequestException('No WhatsApp Business Accounts found.');
    }

    const connectedChannels: any[] = [];

    for (const waba of wabas) {
      const phoneNumbers = await this.getPhoneNumbers(waba.id, accessToken);
      if (!phoneNumbers.length) {
        continue;
      }

      await this.subscribeWABAToWebhook(waba.id, accessToken);

      for (const phone of phoneNumbers) {
        const existingChannel = await this.prisma.channel.findFirst({
          where: {
            type: 'whatsapp',
            identifier: phone.id,
          },
        });

        const channelData = {
          workspaceId: input.workspaceId,
          type: 'whatsapp',
          identifier: phone.id,
          name: phone.display_phone_number ?? phone.verified_name,
          credentials: {
            accessToken,
            tokenExpiresAt: expiresIn
              ? new Date(Date.now() + expiresIn * 1000)
              : null,
            tokenLastValidatedAt: new Date(),
          },
          status: 'connected',
          config: {
            wabaId: waba.id,
            wabaName: waba.name,
            phoneNumber: phone.display_phone_number,
            phoneNumberId: phone.id,
            verifiedName: phone.verified_name,
            qualityRating: phone.quality_rating,
            codeVerificationStatus: phone.code_verification_status,
          },
        };

        const channel = existingChannel
          ? await this.prisma.channel.update({
              where: { id: existingChannel.id },
              data: channelData,
            })
          : await this.prisma.channel.create({ data: channelData });

        connectedChannels.push(channel);
        this.logger.log(
          `WhatsApp channel connected: ${phone.display_phone_number} (${phone.id})`,
        );
      }
    }

    return connectedChannels;
  }

  async exchangeCodeForToken(code: string, redirectUri: string) {
    const { data } = await axios.get(`${FB_BASE}/oauth/access_token`, {
      params: {
        client_id: process.env.WHATSAPP_APP_ID!,
        client_secret: process.env.WHATSAPP_APP_SECRET!,
        redirect_uri: redirectUri,
        code,
      },
    });

    return data.access_token as string;
  }

  async fetchProfile(userToken: string) {
    const { data: businessesData } = await axios.get(`${FB_BASE}/me/businesses`, {
      params: { access_token: userToken },
    });

    const businesses = businessesData.data ?? [];
    const wabas: any[] = [];

    for (const business of businesses) {
      try {
        const { data } = await axios.get(
          `${FB_BASE}/${business.id}/owned_whatsapp_business_accounts`,
          { params: { access_token: userToken } },
        );
        wabas.push(...(data.data ?? []));
      } catch {}

      try {
        const { data } = await axios.get(
          `${FB_BASE}/${business.id}/client_whatsapp_business_accounts`,
          { params: { access_token: userToken } },
        );
        wabas.push(...(data.data ?? []));
      } catch {}
    }

    return wabas;
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
        client_id: process.env.WHATSAPP_APP_ID!,
        client_secret: process.env.WHATSAPP_APP_SECRET!,
        fb_exchange_token: shortLivedToken,
      },
    });

    return {
      accessToken: data.access_token as string,
      expiresIn: data.expires_in as number | undefined,
    };
  }

  private async getPhoneNumbers(wabaId: string, token: string) {
    const { data } = await axios.get(`${FB_BASE}/${wabaId}/phone_numbers`, {
      params: {
        fields:
          'id,display_phone_number,verified_name,quality_rating,code_verification_status,phone_number_id',
        access_token: token,
      },
    });

    return data.data ?? [];
  }

  private async subscribeWABAToWebhook(wabaId: string, token: string) {
    await axios.post(
      `${FB_BASE}/${wabaId}/subscribed_apps`,
      {},
      { params: { access_token: token } },
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
