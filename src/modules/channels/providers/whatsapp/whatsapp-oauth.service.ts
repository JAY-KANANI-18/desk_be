import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ChannelOAuthEventsService } from 'src/modules/channels/oauth/channel-oauth-events.service';
import { ChannelOAuthStateService } from 'src/modules/channels/oauth/channel-oauth-state.service';
import { buildOAuthCallbackPage } from 'src/modules/channels/oauth/oauth-callback-page.util';
import { PrismaService } from 'src/prisma/prisma.service';

const FB_BASE = 'https://graph.facebook.com/v22.0';

type ParsedOAuthState = ReturnType<ChannelOAuthStateService['parseState']>;
type WhatsAppOAuthProvider = 'whatsapp' | 'whatsapp_coexist';

@Injectable()
export class WhatsAppOAuthService {
  private readonly logger = new Logger(WhatsAppOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ChannelOAuthStateService,
    private readonly events: ChannelOAuthEventsService,
  ) {}

  buildAuthUrl(input: { workspaceId: string; userId: string }) {
    const callbackUri = this.getBrowserCallbackUri();
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

  buildCoexistState(input: { workspaceId: string; userId: string }) {
    return this.state.createState({
      provider: 'whatsapp_coexist',
      userId: input.userId,
      workspaceId: input.workspaceId,
      redirectUri: this.getEmbeddedSignupRedirectUri(),
    });
  }

  async handleBrowserCallback(input: {
    code?: string;
    error?: string;
    errorDescription?: string;
    state?: string;
    requestOrigin?: string;
  }) {
    const fallbackRedirectUri = this.state.getDefaultRedirectUri();

    let oauthState: ParsedOAuthState | null = null;

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
        redirectUri: oauthState.redirectUri,
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

  async handleCoexistFrontendCallback(input: {
    code: string;
    state: string;
    wabaId: string;
    phoneNumberId: string;
    businessId?: string;
    userId: string;
    workspaceId: string;
  }) {
    const oauthState = this.state.parseState(input.state, 'whatsapp_coexist');
    this.assertStateMatchesSession(oauthState, input.userId, input.workspaceId);

    try {
      await this.ensureWorkspaceMembership(
        oauthState.workspaceId,
        oauthState.userId,
      );

      const channels = await this.connectWithCoexistCode({
        code: input.code,
        redirectUri: oauthState.redirectUri,
        workspaceId: oauthState.workspaceId,
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        businessId: input.businessId,
      });

      if (!channels.length) {
        throw new BadRequestException(
          'No WhatsApp Business App number was connected.',
        );
      }

      for (const channel of channels) {
        await this.events.emitConnected({
          provider: 'whatsapp_coexist',
          userId: oauthState.userId,
          workspaceId: oauthState.workspaceId,
          channel,
        });
      }

      return channels;
    } catch (error: any) {
      const message = this.getErrorMessage(
        error,
        'WhatsApp Business App connection failed.',
      );

      await this.events.emitError({
        provider: 'whatsapp_coexist',
        userId: oauthState.userId,
        workspaceId: oauthState.workspaceId,
        error: message,
      });

      throw new BadRequestException(message);
    }
  }

  async connectWithCode(input: {
    code: string;
    redirectUri: string;
    workspaceId: string;
  }) {
    const token = await this.exchangeCodeForToken({
      code: input.code,
      redirectUri: input.redirectUri,
    });
    const { accessToken, expiresIn } =
      await this.exchangeLongLivedUserToken(token.accessToken);

    return this.connectDiscoveredChannels({
      accessToken,
      expiresIn,
      workspaceId: input.workspaceId,
      provider: 'whatsapp',
    });
  }

  async connectWithCoexistCode(input: {
    code: string;
    redirectUri?: string;
    workspaceId: string;
    wabaId: string;
    phoneNumberId: string;
    businessId?: string;
  }) {
    const token = await this.exchangeCodeForToken({
      code: input.code,
      redirectUri: input.redirectUri,
    });
    const { accessToken, expiresIn } = await this.exchangeEmbeddedSignupToken(
      token.accessToken,
      token.expiresIn,
    );

    const waba = await this.getWabaById(input.wabaId, accessToken);
    const phone = await this.getPhoneNumberById(
      input.wabaId,
      input.phoneNumberId,
      accessToken,
    );

    await this.subscribeWABAToWebhook(input.wabaId, accessToken);

    const channel = await this.upsertWhatsAppChannel({
      workspaceId: input.workspaceId,
      accessToken,
      expiresIn,
      provider: 'whatsapp_coexist',
      businessId: input.businessId,
      phone,
      waba,
    });

    return [channel];
  }

  async exchangeCodeForToken(input: { code: string; redirectUri?: string }) {
    const params: Record<string, string> = {
      client_id: process.env.WHATSAPP_APP_ID!,
      client_secret: process.env.WHATSAPP_APP_SECRET!,
      code: input.code,
    };

    if (input.redirectUri) {
      params.redirect_uri = input.redirectUri;
    }

    const { data } = await axios.get(`${FB_BASE}/oauth/access_token`, {
      params,
    });

    return {
      accessToken: data.access_token as string,
      expiresIn: data.expires_in as number | undefined,
    };
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

  private async connectDiscoveredChannels(input: {
    accessToken: string;
    expiresIn?: number;
    workspaceId: string;
    provider: WhatsAppOAuthProvider;
  }) {
    const wabas = await this.fetchProfile(input.accessToken);

    if (!wabas.length) {
      throw new BadRequestException('No WhatsApp Business Accounts found.');
    }

    const connectedChannels: any[] = [];

    for (const waba of wabas) {
      const phoneNumbers = await this.getPhoneNumbers(waba.id, input.accessToken);
      if (!phoneNumbers.length) {
        continue;
      }

      await this.subscribeWABAToWebhook(waba.id, input.accessToken);

      for (const phone of phoneNumbers) {
        connectedChannels.push(
          await this.upsertWhatsAppChannel({
            workspaceId: input.workspaceId,
            accessToken: input.accessToken,
            expiresIn: input.expiresIn,
            provider: input.provider,
            phone,
            waba,
          }),
        );
      }
    }

    return connectedChannels;
  }

  private async upsertWhatsAppChannel(input: {
    workspaceId: string;
    accessToken: string;
    expiresIn?: number;
    provider: WhatsAppOAuthProvider;
    businessId?: string;
    phone: any;
    waba: any;
  }) {
    const existingChannel = await this.prisma.channel.findFirst({
      where: {
        type: 'whatsapp',
        identifier: input.phone.id,
      },
    });

    const channelData = {
      workspaceId: input.workspaceId,
      type: 'whatsapp',
      identifier: input.phone.id,
      name: input.phone.display_phone_number ?? input.phone.verified_name,
      credentials: {
        accessToken: input.accessToken,
        tokenExpiresAt: input.expiresIn
          ? new Date(Date.now() + input.expiresIn * 1000)
          : null,
        tokenLastValidatedAt: new Date(),
      },
      status: 'connected',
      config: {
        provider: input.provider,
        coexistence: input.provider === 'whatsapp_coexist',
        businessId: input.businessId ?? null,
        wabaId: input.waba.id,
        wabaName: input.waba.name,
        phoneNumber: input.phone.display_phone_number,
        phoneNumberId: input.phone.id,
        verifiedName: input.phone.verified_name,
        qualityRating: input.phone.quality_rating,
        codeVerificationStatus: input.phone.code_verification_status,
      },
    };

    const channel = existingChannel
      ? await this.prisma.channel.update({
          where: { id: existingChannel.id },
          data: channelData,
        })
      : await this.prisma.channel.create({ data: channelData });

    this.logger.log(
      `WhatsApp channel connected: ${input.phone.display_phone_number} (${input.phone.id})`,
    );

    return channel;
  }

  private assertStateMatchesSession(
    oauthState: ParsedOAuthState,
    userId: string,
    workspaceId: string,
  ) {
    if (oauthState.userId !== userId || oauthState.workspaceId !== workspaceId) {
      throw new BadRequestException(
        'OAuth state does not match the current workspace session.',
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

  private async exchangeEmbeddedSignupToken(
    accessToken: string,
    expiresIn?: number,
  ) {
    try {
      return await this.exchangeLongLivedUserToken(accessToken);
    } catch (error: any) {
      this.logger.warn(
        `Using embedded signup token without additional exchange: ${this.getErrorMessage(error, 'embedded_signup_token_exchange_failed')}`,
      );

      return {
        accessToken,
        expiresIn,
      };
    }
  }

  private async getWabaById(wabaId: string, token: string) {
    const { data } = await axios.get(`${FB_BASE}/${wabaId}`, {
      params: {
        fields: 'id,name',
        access_token: token,
      },
    });

    return data;
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

  private async getPhoneNumberById(
    wabaId: string,
    phoneNumberId: string,
    token: string,
  ) {
    const phoneNumbers = await this.getPhoneNumbers(wabaId, token);
    const phone = phoneNumbers.find(
      (entry: any) =>
        entry.id === phoneNumberId || entry.phone_number_id === phoneNumberId,
    );

    if (!phone) {
      throw new BadRequestException(
        'The selected WhatsApp Business App number is unavailable.',
      );
    }

    return phone;
  }

  private async subscribeWABAToWebhook(wabaId: string, token: string) {
    await axios.post(
      `${FB_BASE}/${wabaId}/subscribed_apps`,
      {},
      { params: { access_token: token } },
    );
  }

  private getBrowserCallbackUri() {
    return process.env.WHATSAPP_REDIRECT_URI!;
  }

  private getEmbeddedSignupRedirectUri() {
    return (
      process.env.WHATSAPP_EMBEDDED_SIGNUP_REDIRECT_URI ??
      process.env.WHATSAPP_REDIRECT_URI!
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
