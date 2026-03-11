import {
    CanActivate,
    ExecutionContext,
    Injectable,
    ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WORKSPACE_PERMISSIONS } from '../constants/permissions';

@Injectable()
export class PermissionGuard implements CanActivate {
    constructor(private reflector: Reflector) { }

    canActivate(context: ExecutionContext): boolean {
        const requiredPermission = this.reflector.get<string>(
            'permission',
            context.getHandler(),
        );

        if (!requiredPermission) {
            return true; // No permission required
        }

        const req = context.switchToHttp().getRequest();
        const workspaceRole = req.workspaceMember.role;

        const allowedPermissions =
            WORKSPACE_PERMISSIONS[workspaceRole] || [];

        if (!allowedPermissions.includes(requiredPermission)) {
            throw new ForbiddenException(
                'You do not have permission to perform this action',
            );
        }

        return true;
    }
}