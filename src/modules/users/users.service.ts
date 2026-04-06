import { Injectable, BadRequestException } from '@nestjs/common';
import { User } from '@prisma/client';
import slugify from 'slugify';
import { PrismaService } from '../../prisma/prisma.service';


// interface User{
//     id: string;
//     email: string;
//     firstName: string;
//     lastName: string;
//     avatarUrl: string;
//     createdAt: Date;
// }

@Injectable()
export class UsersService {

    constructor(private prisma: PrismaService) { }

    async getMe(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                avatarUrl: true,
                createdAt: true,

                organizationMemberships: {
                    select: {
                        role: true,
                        organization: {
                            select: {
                                id: true,
                                name: true,

                                workspaces: {
                                    select: {
                                        id: true,
                                        name: true,

                                        members: {
                                            where: {
                                                userId: userId,
                                            },
                                            select: {
                                                role: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!user) {
            throw new Error("User not found");
        }

        const organizations = user.organizationMemberships.map((orgMember) => ({
            id: orgMember.organization.id,
            name: orgMember.organization.name,
            role: orgMember.role,

            workspaces: orgMember.organization.workspaces
                .filter((ws) => ws.members.length > 0)
                .map((ws) => ({
                    id: ws.id,
                    name: ws.name,
                    role: ws.members[0].role,
                })),
        }));

        return {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            avatarUrl: user.avatarUrl,
            createdAt: user.createdAt,
            organizations,
        };
    }

    async updateProfile(userId: string, dto: any) {

        return this.prisma.user.update({
            where: { id: userId },
            data: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                avatarUrl: dto.avatarUrl,
            },
        });
    }
async getMyOrganizations(userId: string) {
        const memberships = await this.prisma.organizationMember.findMany({
            where: { userId },
            include: {
                organization: {
                    include: {
                        workspaces: {
                            include: {
                                members: {
                                    where: { userId },
                                },
                            },
                        },
                    },
                },
            },
        });

        return memberships.map((membership) => ({
            role: membership.role,
            ...membership.organization,
        }));

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
    async updateAvailability(userId: string, available: string) {

        return this.prisma.userActivity.update({
            where: { userId: userId },
            data: {
                activityStatus: available,
            },
        });
    }
  

    async inviteUser(workspaceId: string, email: string, role: string) {

        const user = await this.prisma.user.findUnique({
            where: { email },
        });

        if (!user) {
            throw new Error('User must sign up first');
        }

        return this.prisma.workspaceMember.create({
            data: {
                workspaceId,
                userId: user.id,
                role,
            },
        });
    }



}