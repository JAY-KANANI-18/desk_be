import { BadRequestException, Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';
import { ChannelOAuthProvider } from './channel-oauth-events.shared';

interface OAuthStatePayload {
  v: 1;
  provider: ChannelOAuthProvider;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  iat: number;
  exp: number;
  nonce: string;
}

interface CreateStateInput {
  provider: ChannelOAuthProvider;
  userId: string;
  workspaceId: string;
  redirectUri?: string;
  requestOrigin?: string;
}

@Injectable()
export class ChannelOAuthStateService {
  private readonly ttlMs = 10 * 60 * 1000;

  createState(input: CreateStateInput) {
    const redirectUri = input.redirectUri
    // this.normalizeRedirectUri(
    //   input.redirectUri,
    //   input.requestOrigin,
    // );

    const now = Date.now();
    const payload: OAuthStatePayload = {
      v: 1,
      provider: input.provider,
      userId: input.userId,
      workspaceId: input.workspaceId,
      redirectUri,
      iat: now,
      exp: now + this.ttlMs,
      nonce: randomUUID(),
    };
    console.log({payload});
    
    
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    console.log({encoded});
    const signature = this.sign(encoded);
    console.log({encoded,signature});
    
    return `${encoded}.${signature}`;
  }

  parseState(state: string | undefined, provider: ChannelOAuthProvider) {
    if (!state) {
      throw new BadRequestException('Missing OAuth state');
    }

    const [encoded, signature] = state.split('.');
    console.log({encoded,signature});
    
    if (!encoded || !signature || this.sign(encoded) !== signature) {
      throw new BadRequestException('Invalid OAuth state');
    }

    let payload: OAuthStatePayload;
    try {
      payload = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as OAuthStatePayload;
    } catch {
      throw new BadRequestException('Malformed OAuth state');
    }

    if (payload.v !== 1 || payload.provider !== provider) {
      throw new BadRequestException('OAuth state provider mismatch');
    }

    if (!payload.userId || !payload.workspaceId || !payload.redirectUri) {
      throw new BadRequestException('OAuth state is incomplete');
    }

    if (payload.exp < Date.now()) {
      throw new BadRequestException('OAuth state has expired');
    }
    console.log({payload});
    
    return payload;
  }

  getDefaultRedirectUri() {
    const appUrl = this.getAppUrl(process.env.APP_URL);
    return `${appUrl}/channels`;
  }

  private normalizeRedirectUri(redirectUri?: string, requestOrigin?: string) {
    const appUrl = this.getAppUrl(requestOrigin);
    const fallback = `${appUrl}/channels/connect`;

    if (!redirectUri) {
      return fallback;
    }

    if (redirectUri.startsWith('/')) {
      return `${appUrl}${redirectUri}`;
    }

    try {
      const target = new URL(redirectUri);
      const allowedOrigin = new URL(appUrl).origin;
      return target.origin === allowedOrigin ? target.toString() : fallback;
    } catch {
      return fallback;
    }
  }

  private getAppUrl(requestOrigin?: string) {
    const base =
      process.env.APP_URL ??
      requestOrigin ??
      'http://localhost:3000';

    return base.replace(/\/api\/?$/, '').replace(/\/$/, '');
  }

  private sign(value: string) {
    return createHmac('sha256', this.getSecret())
      .update(value)
      .digest('base64url');
  }

  private getSecret() {
    return (
      process.env.OAUTH_STATE_SECRET ??
      process.env.INSTAGRAM_APP_SECRET ??
      process.env.MESSENGER_APP_SECRET ??
      process.env.WHATSAPP_APP_SECRET ??
      'local-channel-oauth-state-secret'
    );
  }
}
