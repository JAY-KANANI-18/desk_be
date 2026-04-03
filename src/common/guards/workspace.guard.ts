import {
    CanActivate,
    ExecutionContext,
    Injectable,
    ForbiddenException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WorkspaceGuard implements CanActivate {
    constructor(private prisma: PrismaService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();

        const workspaceId = req.headers['x-workspace-id'];

        if (!workspaceId) {
            throw new BadRequestException('X-Workspace-Id header is required');
        }

        // Check membership
        const membership = await this.prisma.workspaceMember.findFirst({
            where: {
                workspaceId: workspaceId,
                userId: req.user.id,
                status: 'active',
            },
            include: {
                workspace: true,
            },
        });

        if (!membership) {
            throw new ForbiddenException(
                'You do not have access to this workspace',
            );
        }

        // Attach workspace context
        req.workspaceId = workspaceId;
        req.workspaceMember = membership;
        req.organizationId = membership.workspace.organizationId;

        return true;
    }
}