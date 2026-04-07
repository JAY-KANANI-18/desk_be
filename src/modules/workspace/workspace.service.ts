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
            }
        });

        return members;
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

    async getusersInWorkspace(workspaceId: string) {
        let users = await this.prisma.workspaceMember.findMany({
            where: { workspaceId },
            include: {
                user: true,
            },
        });
        return (users?.map((membership) => ({ role: membership.role, ...membership.user })));
    }
}