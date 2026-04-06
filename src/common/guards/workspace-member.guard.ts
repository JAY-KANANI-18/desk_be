import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';

// Routes that don't need a workspace context
const WS_EXEMPT = [
  '/webhooks/',
  '/webchat/',
  '/api/billing/webhook',
  '/api/organizations',
  '/api/billing',
  '/api/users/invite',
  '/api/channels/whatsapp/webhook',
  '/api/channels/instagram/webhook',
  '/api/channels/messenger/webhook',
];

@Injectable()
export class WorkspaceMemberGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest();
    const path: string = request.path ?? '';

    if (WS_EXEMPT.some(p => path.startsWith(p))) return true;

    const workspaceId =
      request.headers['x-workspace-id'] ??
      request.params?.workspaceId;

    if (!workspaceId) {
      throw new BadRequestException('X-Workspace-Id header is required');
    }

    // workspaceRoles was built in JwtGuard: { [wsId]: WorkspaceRole }
    const wsRole = request.user?.workspaceRoles?.[workspaceId];

    if (!wsRole) {
      throw new ForbiddenException('You do not have access to this workspace');
    }

    // Stamp for downstream guards and controllers
    request.workspaceId   = workspaceId;
    request.workspaceRole = wsRole;        // e.g. 'WS_OWNER'

    return true;
  }
}