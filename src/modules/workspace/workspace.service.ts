import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SetupWorkspaceDto } from './dto/add-workspace.dto';
import { User } from '@prisma/client';
import slugify from 'slugify';
import { PrismaService } from '../../prisma/prisma.service';
import { InviteUserDto } from './workspace.controller';
import { SupabaseService } from 'src/supdabse/supabase.service';
import { OrgPermission, OrgRole } from 'src/common/constants/permissions';

@Injectable()
export class WorkspaceService {
    constructor(private prisma: PrismaService,

        private supabase: SupabaseService,

    ) { }

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
    // workspace.service.ts
    async getOnboardingStatus(workspaceId: string) {
        const [workspace, channels, teamMembers, lifeCycleStages] = await Promise.all([
            this.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: {
                    name: true,
                    onboardingDismissed: true,
                    onboardingCompleted: true,
                },
            }),
            this.prisma.channel.findMany({
                where: { workspaceId },
                select: { id: true },
            }),
            this.prisma.workspaceMember.findMany({
                where: { workspaceId },
                select: { id: true },
            }),
            this.prisma.lifecycleStage.findMany({
                where: { workspaceId },
                select: { id: true },
            }),
        ]);

        if (!workspace) throw new NotFoundException('Workspace not found');

        const steps = {
            // setupWorkspace: workspace.name !== 'Default Workspace' && workspace.name !== '',
            connectChannel: channels.length > 0,
            inviteTeam: teamMembers.length > 1,  // > 1 because owner counts as 1
            setupLifecycle: lifeCycleStages.length > 1,                   // track separately later
        };

        const allDone = Object.values(steps).every(Boolean);

        // Auto-mark completed if all steps done
        if (allDone && !workspace.onboardingCompleted) {
            await this.prisma.workspace.update({
                where: { id: workspaceId },
                data: { onboardingCompleted: true },
            });
        }

        return {
            dismissed: workspace.onboardingDismissed,
            completed: workspace.onboardingCompleted,//|| allDone,
            steps,
        };
    }

    async dismissOnboarding(workspaceId: string) {
        return this.prisma.workspace.update({
            where: { id: workspaceId },
            data: { onboardingDismissed: true },
        });
    }
    async completeOnboarding(workspaceId: string) {
        return this.prisma.workspace.update({
            where: { id: workspaceId },
            data: { onboardingCompleted: true },
        });
    }
    async getWorkspacesUserAvailability(workspaceId: string) {
        const workspace = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: { notificationInactivityTimeoutSec: true },
        });
        const timeoutSec = workspace?.notificationInactivityTimeoutSec ?? 300;
        const now = Date.now();

        const members = await this.prisma.userActivity.findMany({
            where: {
                user: {
                    workspaceMemberships: {
                        some: {
                            workspaceId: workspaceId,
                            status: 'active',
                        },
                    },
                },
            },
            select: {
                userId: true,
                activityStatus: true,
                lastActivityAt: true,
            }
        });

        return members.map((member) => {
            const explicit = member.activityStatus;
            const lastActivityAt = member.lastActivityAt?.getTime() ?? 0;
            const isManual =
                explicit === 'AWAY' ||
                explicit === 'BUSY' ||
                explicit === 'DND';
            const isOffline = !lastActivityAt || now - lastActivityAt > timeoutSec * 1000;

            const effective = isManual
                ? explicit
                : isOffline
                    ? 'OFFLINE'
                    : explicit === 'ACTIVE'
                        ? 'ACTIVE'
                        : 'OFFLINE';

            return {
                userId: member.userId,
                activityStatus: effective.toLowerCase() === 'active' ? 'online' : effective.toLowerCase(),
            };
        });
    }
    async inviteUser(
        dto: any,
        workspaceId: string,
        organizationId: string
    ) {
        // 1. Find user by email
        let user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });

        // 2. If user doesn't exist -> invite + create
        if (!user) {
            const supaUser = await this.supabase.inviteUser(dto.email);
            console.log({ supaUser });

            user = await this.prisma.user.create({
                data: {
                    id: supaUser.user.id,
                    email: dto.email,
                    status: "PENDING",
                },
            });
        }

        return await this.prisma.$transaction(async (tx) => {
            // 3. Check org membership
            const existingOrgMembership = await tx.organizationMember.findUnique({
                where: {
                    organizationId_userId: {
                        userId: user.id,
                        organizationId,
                    },
                },
            });

            // 4. Create org membership ONLY if not found
            if (!existingOrgMembership) {
                await tx.organizationMember.create({
                    data: {
                        userId: user.id,
                        organizationId,
                        role: OrgRole.MEMBER,
                    },
                });
            }

            // 5. Check workspace membership
            const existingWorkspaceMembership = await tx.workspaceMember.findUnique({
                where: {
                    workspaceId_userId: {
                        userId: user.id,
                        workspaceId,
                    },
                },
            });

            // 6. If not in workspace -> create
            if (!existingWorkspaceMembership) {
                await tx.workspaceMember.create({
                    data: {
                        userId: user.id,
                        workspaceId,
                        role: dto.role,
                        joinedAt: new Date(),
                    },
                });
            } else {
                // 7. If already in workspace -> update workspace role only
                await tx.workspaceMember.update({
                    where: {
                        workspaceId_userId: {
                            userId: user.id,
                            workspaceId,
                        },
                    },
                    data: {
                        role: dto.role,
                    },
                });
            }

            // 8. Return final user with memberships
            return tx.user.findUnique({
                where: { id: user.id },
                include: {
                    organizationMemberships: true,
                    workspaceMemberships: true,
                },
            });
        });
    }
    async updateUser(
        dto: any,
        workspaceId: string,
    ) {


        // create pending user in prisma
        const user = await this.prisma.workspaceMember.update({
            where: { workspaceId_userId: { userId: dto.id, workspaceId } },
            data: {
                role: dto.role


            },
        });

        // send supabase invite email

        return user;
    }

    async getWorkspaceusers(
        workspaceId: string,
        opts?: { search?: string; page?: number; limit?: number },
    ) {
        const where: any = {
            workspaceId,
            ...(opts?.search?.trim()
                ? {
                    OR: [
                        { role: { contains: opts.search.trim(), mode: 'insensitive' } },
                        { status: { contains: opts.search.trim(), mode: 'insensitive' } },
                        { user: { email: { contains: opts.search.trim(), mode: 'insensitive' } } },
                        { user: { firstName: { contains: opts.search.trim(), mode: 'insensitive' } } },
                        { user: { lastName: { contains: opts.search.trim(), mode: 'insensitive' } } },
                    ],
                }
                : {}),
        };

        const mapUser = (membership: any) => ({
            role: membership.role,
            status: membership.status,
            ...membership.user,
        });

        const hasPagination =
            typeof opts?.page === 'number' || typeof opts?.limit === 'number';

        if (!hasPagination) {
            const users = await this.prisma.workspaceMember.findMany({
                where,
                include: {
                    user: true,
                },
                orderBy: [
                    { user: { firstName: 'asc' } },
                    { user: { email: 'asc' } },
                ],
            });
            return users.map(mapUser);
        }

        const page = Math.max(1, opts?.page ?? 1);
        const limit = Math.min(Math.max(1, opts?.limit ?? 10), 100);
        const [users, total] = await this.prisma.$transaction([
            this.prisma.workspaceMember.findMany({
                where,
                include: {
                    user: true,
                },
                orderBy: [
                    { user: { firstName: 'asc' } },
                    { user: { email: 'asc' } },
                ],
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.workspaceMember.count({ where }),
        ]);

        return {
            items: users.map(mapUser),
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

    async getusersInWorkspace(workspaceId: string) {
        let users = await this.prisma.workspaceMember.findMany({
            where: { workspaceId },
            include: {
                user: true,
            },
        });
        return (users?.map((membership) => ({ role: membership.role, ...membership.user })));
    }

    async getIntegrationsCatalog(workspaceId: string) {
        const metaRow = await this.prisma.channel.findFirst({
            where: { workspaceId, type: 'meta_ads' },
        });
        const cfg = (metaRow?.config || {}) as Record<string, unknown>;

        return {
            integrations: [
                {
                    id: 'meta_ads',
                    name: 'Meta Ads',
                    desc: 'Connect a Facebook ad account to capture leads/clicks into the inbox, trigger workflows, and see account health in one place.',
                    icon: '📣',
                    category: 'Advertising',
                    connected: !!metaRow,
                    routingChannelId: metaRow?.id ?? null,
                    summary: metaRow
                        ? {
                              accountName: cfg.accountName as string,
                              accountId: cfg.accountId as string,
                              accountStatus: cfg.accountStatus as string,
                              currency: cfg.currency as string,
                              campaignCount: cfg.campaignCount as number,
                          }
                        : null,
                },
            ],
        };
    }

    async disconnectIntegration(workspaceId: string, integrationId: string) {
        if (integrationId === 'meta_ads') {
            await this.prisma.channel.deleteMany({
                where: { workspaceId, type: 'meta_ads' },
            });
            return { disconnected: true };
        }
        throw new NotFoundException('Unknown integration');
    }
}
