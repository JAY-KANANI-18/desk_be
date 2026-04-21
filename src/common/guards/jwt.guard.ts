import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from 'src/modules/auth/auth.service';
import { AuthTokenService } from 'src/modules/auth/auth-token.service';
import { RouteAccessConfig, ROUTE_ACCESS_KEY } from '../auth/route-access.decorator';
import { verifySupabaseToken } from './supabase-jwt';

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly authTokenService: AuthTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<RouteAccessConfig>(
      ROUTE_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (access?.type === 'public') {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing token');
    }

    const token = authHeader.replace('Bearer ', '');

    try {
      const payload = await this.authTokenService.verifyAccessToken(token);
      const contextData = await this.authService.getSessionContext(payload.sid as string);

      req.user = {
        ...contextData.user,
        id: contextData.userId,
        sessionId: contextData.sessionId,
        currentWorkspaceId: contextData.currentWorkspaceId,
        currentOrganizationId: contextData.currentOrganizationId,
        workspaceRoles: contextData.workspaceRoles,
        orgRoles: contextData.orgRoles,
        authProvider: contextData.authProvider,
      };
    } catch {
      if ((process.env.AUTH_ACCEPT_SUPABASE_TOKENS ?? 'false') !== 'true') {
        throw new UnauthorizedException('Invalid token');
      }

      let payload: any;
      try {
        payload = await verifySupabaseToken(token);
      } catch {
        throw new UnauthorizedException('Invalid token');
      }

      const email = payload.email;
      const userId = payload.sub;

      const dbUser = await this.prisma.user.upsert({
        where: { email },
        update: {
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
        create: {
          id: userId,
          email,
          firstName: email?.split('@')[0] ?? 'User',
          status: 'ACTIVE',
          avatarUrl: payload?.user_metadata?.avatar_url ?? '',
          emailVerifiedAt: new Date(),
        },
        include: {
          organizationMemberships: true,
          workspaceMemberships: true,
        },
      });

      req.user = {
        ...dbUser,
        sessionId: null,
        workspaceRoles: Object.fromEntries(dbUser.workspaceMemberships.map((wm) => [wm.workspaceId, wm.role])),
        orgRoles: Object.fromEntries(dbUser.organizationMemberships.map((membership) => [membership.organizationId, membership.role])),
        authProvider: 'legacy_supabase',
      };
    }

    if (req.user.status !== 'ACTIVE') {
      throw new ForbiddenException('Account not activated. Please set your password.');
    }

    return true;
  }
}

