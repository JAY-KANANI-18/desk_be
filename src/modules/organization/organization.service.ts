import { Injectable } from '@nestjs/common';
import { SetupOrganizationDto } from './dto/setup-organization.dto';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { SupabaseService } from 'src/supdabse/supabase.service';

@Injectable()
export class OrganizationService {
    constructor(private prisma: PrismaService,
        private supabase: SupabaseService,



    ) { }

    async setup(dto: SetupOrganizationDto, user: User) {
        const onboardingData = dto.onboardingData
            ? (dto.onboardingData as unknown as Prisma.InputJsonValue)
            : undefined;

        const organization = await this.prisma.organization.create({
            data: {
                name: dto.organizationName,
                onboardingData,
                onboardingCompletedAt: onboardingData ? new Date() : undefined,
                members: {
                    create: {
                        userId: user.id,
                        role: 'ORG_ADMIN',
                        joinedAt: new Date(),
                    },
                },
                workspaces: {
                    create: {
                        name: dto.workspaceName,
                        onboardingCompleted: Boolean(onboardingData),
                        members: {
                            create: {
                                userId: user.id,
                                role: 'WS_OWNER',
                                joinedAt: new Date(),
                            },
                        },
                    },
                },
            },
            include: {
                workspaces: true,
                members: true,
            },
        });

        return organization;
    }
    async update(dto: any, organizationId: string){
        return await this.prisma.organization.update({
            where:{id: organizationId},
            data:{
                name:dto.name,
                website:dto.website
            }
        })
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
    async getUsersInOrganization(organizationId: string) {
        const users = await this.prisma.organizationMember.findMany({
            where: { organizationId },
            include: {
                user: {
                    include: {
                        workspaceMemberships: {
                            include: {
                                workspace: true,
                            },
                        },
                    },
                },
            },
        });

        return users.map((membership) => ({
            id: membership.user.id,
            email: membership.user.email,
            firstName: membership.user.firstName,
            lastName: membership.user.lastName,
            avatarUrl: membership.user.avatarUrl,
            role: membership.role, // organization role
            status: membership.status,

            workspaces: membership.user.workspaceMemberships.map((wm) => ({
                id: wm.workspace.id,
                name: wm.workspace.name,
                organizationId: wm.workspace.organizationId,
                role: wm.role,          // ✅ workspace role
                status: wm.status,
                availability: wm.availability,
                joinedAt: wm.joinedAt,
            })),
        }));
    }
    async getUsersInOrganizationPaginated(
        organizationId: string,
        opts?: { search?: string; page?: number; limit?: number },
    ) {
        const where: any = {
            organizationId,
            ...(opts?.search?.trim()
                ? {
                    OR: [
                        { role: { contains: opts.search.trim(), mode: 'insensitive' } },
                        { status: { contains: opts.search.trim(), mode: 'insensitive' } },
                        { user: { email: { contains: opts.search.trim(), mode: 'insensitive' } } },
                        { user: { firstName: { contains: opts.search.trim(), mode: 'insensitive' } } },
                        { user: { lastName: { contains: opts.search.trim(), mode: 'insensitive' } } },
                        {
                            user: {
                                workspaceMemberships: {
                                    some: {
                                        workspace: {
                                            organizationId,
                                            name: { contains: opts.search.trim(), mode: 'insensitive' },
                                        },
                                    },
                                },
                            },
                        },
                    ],
                }
                : {}),
        };

        const page = Math.max(1, opts?.page ?? 1);
        const limit = Math.min(Math.max(1, opts?.limit ?? 10), 100);
        const [users, total] = await this.prisma.$transaction([
            this.prisma.organizationMember.findMany({
                where,
                include: {
                    user: {
                        include: {
                            workspaceMemberships: {
                                where: {
                                    workspace: {
                                        organizationId,
                                    },
                                },
                                include: {
                                    workspace: true,
                                },
                            },
                        },
                    },
                },
                orderBy: [
                    { user: { firstName: 'asc' } },
                    { user: { email: 'asc' } },
                ],
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.organizationMember.count({ where }),
        ]);

        return {
            items: users.map((membership) => ({
                id: membership.user.id,
                email: membership.user.email,
                firstName: membership.user.firstName,
                lastName: membership.user.lastName,
                avatarUrl: membership.user.avatarUrl,
                role: membership.role,
                status: membership.status,
                workspaces: membership.user.workspaceMemberships.map((wm) => ({
                    id: wm.workspace.id,
                    name: wm.workspace.name,
                    organizationId: wm.workspace.organizationId,
                    role: wm.role,
                    status: wm.status,
                    availability: wm.availability,
                    joinedAt: wm.joinedAt,
                })),
            })),
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                hasNextPage: page * limit < total,
                hasPrevPage: page > 1,
            },
        };
    }
    async inviteUser(
        dto: InviteUserDto,
        organizationId: string,
    ) {
        let supaUser = await this.supabase.inviteUser(dto.email);
        console.log({ supaUser });

        // create pending user in prisma
        const user = await this.prisma.user.create({
            data: {
                id: supaUser.user.id,
                email: dto.email,
                status: "PENDING",

                organizationMemberships: {
                    create: {
                        organizationId,
                        role: dto.role,
                        joinedAt: new Date(),
                    },
                },

                workspaceMemberships: {
                    create: dto.workspaceAccess.map(ws => ({
                        workspaceId: ws.workspaceId,
                        role: ws.role,
                        joinedAt: new Date(),
                    })),
                },
            },
        });

        // send supabase invite email

        return user;
    }
    async updateUser(
        dto: any,
        organizationId: string,
    ) {


        // create pending user in prisma
        const user = await this.prisma.user.update({
            where: { email: dto.email },
            data: {
                organizationMemberships: {
                    deleteMany: {

                    },
                    create: {
                        organizationId,
                        role: dto.role,
                        joinedAt: new Date(),
                    },
                },

                workspaceMemberships: {
                    deleteMany: {

                    },
                    create: dto.workspaceAccess.map(ws => ({
                        workspaceId: ws.workspaceId,
                        role: ws.role,
                        joinedAt: new Date(),
                    })),
                },
            },
            include: {
                workspaceMemberships: true,
                organizationMemberships: true
            }
        });

        // send supabase invite email

        return user;
    }
    async removeUserFromOrganization(organizationId: string, userId: string) {
        // remove user from organization in prisma
        await this.prisma.organizationMember.deleteMany({
            where: {
                organizationId,
                userId,
            },
        });

        // remove user from all workspaces in the organization
        const workspaces = await this.prisma.workspace.findMany({
            where: { organizationId },
        });
        const workspaceIds = workspaces.map(ws => ws.id);
        await this.prisma.workspaceMember.deleteMany({
            where: {
                workspaceId: { in: workspaceIds },
                userId,
            },
        });

        // Optionally, you can also delete the user from the users table if they are not part of any other organization
        const otherMemberships = await this.prisma.organizationMember.findMany({
            where: {
                userId,
            },
        });

        if (otherMemberships.length === 0) {
            await this.prisma.user.delete({
                where: {
                    id: userId,
                },
            });
        }

    }
}
