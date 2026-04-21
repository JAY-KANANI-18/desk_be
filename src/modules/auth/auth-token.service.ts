import { Injectable, UnauthorizedException } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants';
import { SessionContext, SessionEnvelope } from './auth.types';
import { buildDisplayName, highestRole } from './auth.utils';

@Injectable()
export class AuthTokenService {
  private readonly issuer = process.env.AUTH_JWT_ISSUER ?? 'axodesk-auth';
  private readonly audience = process.env.AUTH_JWT_AUDIENCE ?? 'axodesk-api';
  private readonly secret = new TextEncoder().encode(process.env.AUTH_JWT_SECRET ?? 'change-me-in-production');

  async signAccessToken(context: SessionContext) {
    const expiresIn = Number(process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS ?? ACCESS_TOKEN_TTL_SECONDS);
    const nowSeconds = Math.floor(Date.now() / 1000);

    return new SignJWT({
      type: 'access',
      sid: context.sessionId,
      ver: context.sessionVersion,
      email: context.user.email,
      workspaceId: context.currentWorkspaceId ?? null,
      orgId: context.currentOrganizationId ?? null,
      provider: context.authProvider,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(context.userId)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + expiresIn)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience,
      });

      if (payload.type !== 'access' || typeof payload.sid !== 'string') {
        throw new UnauthorizedException('Invalid access token');
      }

      return payload as any;
    } catch (error) {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  buildSessionEnvelope(context: SessionContext, accessToken: string): SessionEnvelope {
    const expiresAtSeconds = Math.floor(new Date(context.expiresAt).getTime() / 1000);
    const role = highestRole(context.workspaceRoles, context.orgRoles);
    const displayName = buildDisplayName(context.user);

    return {
      accessToken,
      refreshToken: '',
      csrfToken: context.csrfToken,
      session: {
        access_token: accessToken,
        expires_at: expiresAtSeconds,
        expires_in: Math.max(0, expiresAtSeconds - Math.floor(Date.now() / 1000)),
        token_type: 'Bearer',
        user: {
          id: context.user.id,
          email: context.user.email,
          user_metadata: {
            full_name: displayName,
            name: displayName,
            firstName: context.user.firstName ?? null,
            lastName: context.user.lastName ?? null,
            avatarUrl: context.user.avatarUrl ?? null,
            language: context.user.language ?? null,
            role,
            emailVerified: Boolean(context.user.emailVerifiedAt),
            passwordSet: context.passwordSet,
            currentOrganizationId: context.currentOrganizationId ?? null,
            currentWorkspaceId: context.currentWorkspaceId ?? null,
          },
        },
      },
      user: {
        id: context.user.id,
        email: context.user.email,
        name: displayName,
        role,
      },
    };
  }
}
