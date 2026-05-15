import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { Public, WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import {
  buildOAuthCallbackPage,
  OAUTH_CALLBACK_RESPONSE_HEADERS,
} from 'src/modules/channels/oauth/oauth-callback-page.util';
import { OAuthExchangeDto } from '../dto/oauth-exchange.dto';
import { IntegrationsService } from '../integrations.service';

type WorkspaceRequest = {
  workspaceId: string;
  user?: {
    id?: string;
  };
};

@Controller('api/integrations/meta-ads')
export class MetaAdsIntegrationController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('oauth/url')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  oauthUrl(@Req() req: WorkspaceRequest) {
    return this.integrations.buildMetaAdsOAuthUrl(req.workspaceId);
  }

  @Get('oauth/callback')
  @Public()
  async oauthBrowserCallback(
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const appRedirectUri = this.appRedirectUri();
    const state = this.readState(query.state);
    const workspaceId = state?.workspaceId;
    const hasProviderMismatch = Boolean(state?.provider && state.provider !== 'meta_ads');

    let page: string;

    if (!workspaceId || hasProviderMismatch) {
      page = buildOAuthCallbackPage({
        provider: 'Meta Ads',
        providerKey: 'meta_ads',
        status: 'error',
        message: 'Meta Ads authorization state is missing or invalid.',
        redirectUri: appRedirectUri,
        redirectPayload: {
          oauthProvider: 'meta_ads',
          oauthStatus: 'error',
          error: 'Meta Ads authorization state is missing or invalid.',
        },
      });
    } else if (query.error || !query.code) {
      const message =
        query.error_description ??
        query.error_reason ??
        query.error ??
        'Meta Ads authorization was cancelled.';
      page = buildOAuthCallbackPage({
        provider: 'Meta Ads',
        providerKey: 'meta_ads',
        status: 'error',
        message,
        redirectUri: appRedirectUri,
        redirectPayload: {
          oauthProvider: 'meta_ads',
          oauthStatus: 'error',
          error: message,
        },
      });
    } else {
      try {
        const result = await this.integrations.connectProviderOAuth('meta_ads', {
          workspaceId,
          code: query.code,
          query: {
            ...query,
            code: query.code,
          },
        });

        page = buildOAuthCallbackPage({
          provider: 'Meta Ads',
          providerKey: 'meta_ads',
          status: 'success',
          title: 'Meta Ads connected',
          message: 'Meta Ads authorization is complete. AxoDesk has saved the integration.',
          redirectUri: appRedirectUri,
          payload: {
            integrationId: this.readString(result.integrationId),
            workspaceId,
          },
          redirectPayload: {
            oauthProvider: 'meta_ads',
            oauthStatus: 'success',
            integrationId: this.readString(result.integrationId),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Meta Ads connection failed.';
        page = buildOAuthCallbackPage({
          provider: 'Meta Ads',
          providerKey: 'meta_ads',
          status: 'error',
          message,
          redirectUri: appRedirectUri,
          redirectPayload: {
            oauthProvider: 'meta_ads',
            oauthStatus: 'error',
            error: message,
          },
        });
      }
    }

    Object.entries(OAUTH_CALLBACK_RESPONSE_HEADERS).forEach(([header, value]) => {
      res.setHeader(header, value);
    });
    res.type('html').send(page);
  }

  @Post('oauth/exchange')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  oauthExchange(@Req() req: WorkspaceRequest, @Body() body: OAuthExchangeDto) {
    return this.integrations.connectMetaAdsOAuthCode(body.code, req.workspaceId, req.user?.id);
  }

  @Get('status')
  @WorkspaceRoute()
  status(@Req() req: WorkspaceRequest) {
    return this.integrations.getMetaAdsStatus(req.workspaceId);
  }

  @Delete()
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  disconnect(@Req() req: WorkspaceRequest) {
    return this.integrations.disconnectProvider(req.workspaceId, 'meta_ads');
  }

  @Post('webhook/:integrationId')
  @Public()
  @HttpCode(200)
  webhook(@Param('integrationId') integrationId: string, @Body() body: unknown) {
    return this.integrations.ingestMetaAdsWebhook(integrationId, body);
  }

  @Post('webhook')
  @Public()
  @HttpCode(200)
  webhookWithoutId(@Body() body: unknown) {
    return this.integrations.ingestMetaAdsWebhook(undefined, body);
  }

  private appRedirectUri() {
    const root =
      process.env.AUTH_FRONTEND_BASE_URL ??
      process.env.APP_URL ??
      'http://localhost:5173';
    return `${root.replace(/\/$/, '')}/workspace/settings/integrations`;
  }

  private readState(value?: string) {
    if (!value) return null;
    const parse = (candidate: string) => {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const state = parsed as { workspaceId?: unknown; provider?: unknown };
      return {
        workspaceId: typeof state.workspaceId === 'string' ? state.workspaceId : null,
        provider: typeof state.provider === 'string' ? state.provider : null,
      };
    };

    try {
      return parse(value);
    } catch {
      try {
        return parse(decodeURIComponent(value));
      } catch {
        return null;
      }
    }
  }

  private readString(value: unknown) {
    return typeof value === 'string' ? value : undefined;
  }
}
