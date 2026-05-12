import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_ADMIN_ACCESS_KEY } from './platform-admin-access.decorator';
import {
  getPlatformPermissions,
  resolvePlatformRoleForEmail,
  type PlatformPermission,
  type PlatformRole,
} from './platform-admin.permissions';

export interface PlatformAdminUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: PlatformRole;
  permissions: PlatformPermission[];
}

export interface PlatformAdminRequest {
  user?: {
    id?: string;
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
  };
  platformAdmin?: PlatformAdminUser;
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<PlatformAdminRequest>();
    const role = resolvePlatformRoleForEmail(request.user?.email);

    if (!role || !request.user?.id || !request.user?.email) {
      throw new ForbiddenException('Platform admin access is not configured for this account');
    }

    const permissions = getPlatformPermissions(role);
    const requiredPermissions =
      this.reflector.getAllAndOverride<PlatformPermission[]>(
        PLATFORM_ADMIN_ACCESS_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];
    const missingPermissions = requiredPermissions.filter(
      (permission) => !permissions.includes(permission),
    );

    if (missingPermissions.length) {
      throw new ForbiddenException(
        `Missing platform permissions: ${missingPermissions.join(', ')}`,
      );
    }

    request.platformAdmin = {
      id: request.user.id,
      email: request.user.email,
      firstName: request.user.firstName,
      lastName: request.user.lastName,
      role,
      permissions,
    };

    return true;
  }
}
