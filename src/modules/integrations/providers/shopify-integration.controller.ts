import {
  Body,
  Controller,
  Get,
  Headers,
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
import { ShopifyOAuthExchangeDto } from '../dto/oauth-exchange.dto';
import { IntegrationsService } from '../integrations.service';
import { log } from 'node:console';

type WorkspaceRequest = {
  workspaceId: string;
  user?: {
    id?: string;
  };
};

type WebhookRequest = {
  rawBody?: Buffer | string;
};

@Controller('api/integrations/shopify')
export class ShopifyIntegrationController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('oauth/url')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  oauthUrl(@Req() req: WorkspaceRequest, @Query('shop') shop?: string) {
    return this.integrations.buildProviderOAuthUrl('shopify', req.workspaceId, { shop });
  }

  @Get('oauth/callback')
  @Public()
  async oauthBrowserCallback(
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const appRedirectUri = this.appRedirectUri();
    const state = this.readState(query.state);
    const shop = query.shop ?? state?.shop;
    const workspaceId = state?.workspaceId;

    let page: string;

    if (!workspaceId) {
      page = buildOAuthCallbackPage({
        provider: 'Shopify',
        providerKey: 'shopify',
        status: 'error',
        message: 'Shopify authorization state is missing or invalid.',
        redirectUri: appRedirectUri,
        redirectPayload: {
          oauthProvider: 'shopify',
          oauthStatus: 'error',
          error: 'Shopify authorization state is missing or invalid.',
        },
      });
    } else if (query.error || !query.code) {
      const message =
        query.error_description ??
        query.error ??
        'Shopify authorization was cancelled.';
      page = buildOAuthCallbackPage({
        provider: 'Shopify',
        providerKey: 'shopify',
        status: 'error',
        message,
        redirectUri: appRedirectUri,
        redirectPayload: {
          oauthProvider: 'shopify',
          oauthStatus: 'error',
          error: message,
        },
      });
    } else {
      try {
        const result = await this.integrations.connectProviderOAuth('shopify', {
          workspaceId,
          code: query.code,
          query: {
            ...query,
            shop,
            code: query.code,
          },
        });

        page = buildOAuthCallbackPage({
          provider: 'Shopify',
          providerKey: 'shopify',
          status: 'success',
          title: 'Shopify connected',
          message: 'Shopify authorization is complete. AxoDesk has saved the integration.',
          redirectUri: appRedirectUri,
          payload: {
            integrationId: result.integrationId,
            workspaceId,
            shop,
          },
          redirectPayload: {
            oauthProvider: 'shopify',
            oauthStatus: 'success',
            integrationId: this.readString(result.integrationId),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Shopify connection failed.';
        page = buildOAuthCallbackPage({
          provider: 'Shopify',
          providerKey: 'shopify',
          status: 'error',
          message,
          redirectUri: appRedirectUri,
          redirectPayload: {
            oauthProvider: 'shopify',
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
  oauthExchange(
    @Req() req: WorkspaceRequest,
    @Body() body: ShopifyOAuthExchangeDto,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.integrations.connectProviderOAuth('shopify', {
      workspaceId: req.workspaceId,
      code: body.code,
      createdById: req.user?.id,
      query: {
        ...query,
        code: body.code ?? query.code,
        shop: body.shop ?? query.shop,
        hmac: body.hmac ?? query.hmac,
        timestamp: body.timestamp ?? query.timestamp,
        host: body.host ?? query.host,
        state: body.state ?? query.state,
      },
    });
  }

  @Post('webhook/:integrationId')
  @Public()
  @HttpCode(200)
  webhook(
    @Param('integrationId') integrationId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: WebhookRequest,
  ) {
    console.dir({ integrationId, body, headers, rawBody: req.rawBody }, { depth: null });
    return this.integrations.ingestProviderWebhook('shopify', {
      integrationId,
      payload: body,
      headers,
      rawBody: req.rawBody,
    });
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
      const state = parsed as { workspaceId?: unknown; shop?: unknown; provider?: unknown };
      return {
        workspaceId: typeof state.workspaceId === 'string' ? state.workspaceId : null,
        shop: typeof state.shop === 'string' ? state.shop : null,
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
