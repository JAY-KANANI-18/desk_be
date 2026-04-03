import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TeamsService {
    constructor(private prisma: PrismaService) { }

    async create(workspaceId: string, dto: any) {
        return this.prisma.team.create({
            data: {
                ...dto,
                workspaceId,
            },
        });
    }

    async findAll(workspaceId: string) {
        return this.prisma.team.findMany({
            where: { workspaceId },
            include: {
                members: {
                    include: { user: true },
                },
            },
        });
    }

    async addMember(teamId: string, userId: string) {
        return this.prisma.teamMember.create({
            data: {
                teamId,
                userId,
            },
        });
    }

    async removeMember(teamId: string, userId: string) {
        return this.prisma.teamMember.delete({
            where: {
                teamId_userId: {
                    teamId,
                    userId,
                },
            },
        });
    }
}