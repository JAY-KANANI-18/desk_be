import { Injectable, BadRequestException } from '@nestjs/common';
import { SetupOrganizationDto } from './dto/setup-organization.dto';
import { User } from '@prisma/client';
import slugify from 'slugify';
import { PrismaService } from 'prisma/prisma.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { SupabaseService } from 'src/supdabse/supabase.service';

@Injectable()
export class OrganizationService {
    constructor(private prisma: PrismaService,
        private supabase: SupabaseService,



    ) { }

    async setup(dto: SetupOrganizationDto, user: User) {



        
        const organization = await this.prisma.organization.create({
            data: {
                name: dto.organizationName,
                members: {
                    create: {
                        userId: user.id,
                        role: 'org_owner',
                        joinedAt: new Date(),
                    },
                },
                workspaces: {
                    create: {
                        name: dto.workspaceName,
                        members: {
                            create: {
                                userId: user.id,
                                role: 'owner',
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
    async  getusersInOrganization(organizationId: string) {
        let users = await this.prisma.organizationMember.findMany({
            where: { organizationId },
            include: {
                user: true,
            },
        });
        return (users?.map((membership) => ({ role: membership.role, ...membership.user })));
    }
    async inviteUser(
        dto: InviteUserDto,
        organizationId: string,
    ) {
     let supaUser =    await this.supabase.inviteUser(dto.email);
     console.log({supaUser});
     
        // create pending user in prisma
        const user = await this.prisma.user.create({
            data: {
                id: supaUser.user.id,
                email: dto.email,
                status: "PENDING",

                organizationMemberships: {
                    create: {
                        organizationId ,
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