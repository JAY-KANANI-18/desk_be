import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';

// Routes that don't need an org context at all
const ORG_EXEMPT = [
  '/webhooks/',
  '/webchat/',
  '/api/channels/whatsapp/webhook',
  '/api/channels/instagram/webhook',
  '/api/channels/messenger/webhook',
  '/api/organizations/me',
  '/api/users/me'
];

@Injectable()
export class OrgMemberGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest();
    const path: string = request.path ?? '';

    if (ORG_EXEMPT.some(p => path.startsWith(p))) return true;

    const organizationId =
      request.headers['x-organization-id'] ??
      request.params?.organizationId;

    if (!organizationId) {
      throw new BadRequestException('X-Organization-Id header is required');
    }

    // orgRoles was built in JwtGuard: { [orgId]: OrgRole }
    const orgRole = request.user?.orgRoles?.[organizationId];

    if (!orgRole) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    // Stamp for downstream guards and controllers
    request.organizationId = organizationId;
    request.orgRole = orgRole;             // e.g. 'ORG_ADMIN'

    return true;
  }
}