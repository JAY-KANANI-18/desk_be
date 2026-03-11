import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { SetupWorkspaceDto } from './dto/add-workspace.dto';
import { User } from '@prisma/client';
import slugify from 'slugify';
import { PrismaService } from 'prisma/prisma.service';

@Injectable()
export class WorkspaceService {
    constructor(private prisma: PrismaService) { }

    async create(dto: SetupWorkspaceDto, user: User) {


        const existing = await this.prisma.workspace.findFirst({
            where: {
                name: dto.name,
                organizationId: dto.organizationId
            }
        })

        if (existing) {
            throw new ConflictException('Workspace already exists');
        }

        const workspace = await this.prisma.workspace.create({
            data: {
                name: dto.name,
                organizationId: dto.organizationId,
                members: {
                    create: {
                        userId: user.id,
                        role: 'owner',
                        joinedAt: new Date(),
                    },
                },

            },
            include: {
                members: true,
            },
        });

        return workspace;
    }

    async getMyWorkspaces(userId: string) {
        const memberships = await this.prisma.workspaceMember.findMany({
            where: { userId },
            include: {
                workspace: {
                    include: {
                        members: true,
                    },
                },
            },
        });

        return memberships.map((membership) => ({
            role: membership.role,
            ...membership.workspace,
        }));

    }

    async getWorkspaceusers(workspaceId: string) {
        let users = await this.prisma.workspaceMember.findMany({
            where: { workspaceId },
            include: {
                user: true,
            },
        });
        return (users?.map((membership) => ({ role: membership.role, ...membership.user })));
    }

    async updateWorkspace(id: string, dto: SetupWorkspaceDto) {
        const workspace = await this.prisma.workspace.update({
            where: { id },
            data: dto,
        });

        return workspace;
    }

    async deleteWorkspace(id: string) {
        const workspace = await this.prisma.workspace.delete({
            where: { id },
        });

        return workspace;
    }

    async  getusersInWorkspace(workspaceId: string) {
        let users = await this.prisma.workspaceMember.findMany({
            where: { workspaceId },
            include: {
                user: true,
            },
        });
        return (users?.map((membership) => ({ role: membership.role, ...membership.user })));
    }
}