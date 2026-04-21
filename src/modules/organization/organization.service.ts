import { Injectable } from '@nestjs/common';
import { SetupOrganizationDto } from './dto/setup-organization.dto';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { AuthService } from '../auth/auth.service';
import { seedDefaultLifecycleStages } from '../lifecycle/default-lifecycle-stages';

@Injectable()
export class OrganizationService {
    constructor(private prisma: PrismaService,
        private authService: AuthService,



    ) { }

    async setup(dto: SetupOrganizationDto, user: User, sessionId?: string | null) {
        const onboardingData = dto.onboardingData
            ? (dto.onboardingData as unknown as Prisma.InputJsonValue)
            : undefined;

        const organization = await this.prisma.$transaction(async (tx) => {
            const createdOrganization = await tx.organization.create({
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

            const primaryWorkspace = createdOrganization.workspaces[0] ?? null;
            if (primaryWorkspace) {
                await seedDefaultLifecycleStages(tx, primaryWorkspace.id);
            }

            return createdOrganization;
        });

        const primaryWorkspace = organization.workspaces[0] ?? null;
        if (sessionId && primaryWorkspace) {
            await this.authService.selectWorkspace(user.id, sessionId, {
                organizationId: organization.id,
                workspaceId: primaryWorkspace.id,
            });
        }

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
        const email = dto.email.trim().toLowerCase();

        const user = await this.prisma.$transaction(async (tx) => {
            const existing = await tx.user.findUnique({
                where: { email },
            });

            const targetUser = existing ?? await tx.user.create({
                data: {
                    email,
                    status: 'INVITED',
                },
            });

            await tx.organizationMember.upsert({
                where: {
                    organizationId_userId: {
                        organizationId,
                        userId: targetUser.id,
                    },
                },
                update: {
                    role: dto.role,
                    status: 'invited',
                },
                create: {
                    organizationId,
                    userId: targetUser.id,
                    role: dto.role,
                    status: 'invited',
                    joinedAt: new Date(),
                },
            });

            for (const workspace of dto.workspaceAccess) {
                await tx.workspaceMember.upsert({
                    where: {
                        workspaceId_userId: {
                            workspaceId: workspace.workspaceId,
                            userId: targetUser.id,
                        },
                    },
                    update: {
                        role: workspace.role,
                        status: 'invited',
                    },
                    create: {
                        workspaceId: workspace.workspaceId,
                        userId: targetUser.id,
                        role: workspace.role,
                        status: 'invited',
                        joinedAt: new Date(),
                    },
                });
            }

            return targetUser;
        });

        await this.authService.inviteUser({
            email,
            organizationId,
            roleSnapshot: {
                organizationRole: dto.role,
                workspaceAccess: dto.workspaceAccess,
            },
        });

        return this.prisma.user.findUnique({
            where: { id: user.id },
            include: {
                organizationMemberships: true,
                workspaceMemberships: true,
            },
        });
    }
    async updateUser(
        dto: any,
        organizationId: string,
    ) {


        const email = dto.email.trim().toLowerCase();
        const user = await this.prisma.user.findUnique({
            where: { email },
        });

        if (!user) {
            throw new Error('User not found');
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.organizationMember.upsert({
                where: {
                    organizationId_userId: {
                        organizationId,
                        userId: user.id,
                    },
                },
                update: {
                    role: dto.role,
                },
                create: {
                    organizationId,
                    userId: user.id,
                    role: dto.role,
                    joinedAt: new Date(),
                },
            });

            const workspaceIds = dto.workspaceAccess.map((workspace) => workspace.workspaceId);

            await tx.workspaceMember.deleteMany({
                where: {
                    userId: user.id,
                    workspace: {
                        organizationId,
                    },
                    workspaceId: {
                        notIn: workspaceIds,
                    },
                },
            });

            for (const workspace of dto.workspaceAccess) {
                await tx.workspaceMember.upsert({
                    where: {
                        workspaceId_userId: {
                            workspaceId: workspace.workspaceId,
                            userId: user.id,
                        },
                    },
                    update: {
                        role: workspace.role,
                    },
                    create: {
                        workspaceId: workspace.workspaceId,
                        userId: user.id,
                        role: workspace.role,
                        joinedAt: new Date(),
                    },
                });
            }
        });

        return this.prisma.user.findUnique({
            where: { id: user.id },
            include: {
                workspaceMemberships: true,
                organizationMemberships: true,
            },
        });
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
