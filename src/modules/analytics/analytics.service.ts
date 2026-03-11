import { Injectable } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class AnalyticsService {
    constructor(private prisma: PrismaService, private redis: RedisService) { }

    async overview(workspaceId: string) {
        const total = await this.prisma.conversation.count({
            where: { workspaceId },
        });

        const open = await this.prisma.contact.count({
            where: { workspaceId, status: 'open' },
        });

        const resolved = await this.prisma.contact.count({
            where: { workspaceId, status: 'resolved' },
        });

        const slaBreached = await this.prisma.conversation.count({
            where: { workspaceId, slaBreached: true },
        });

        return {
            total,
            open,
            resolved,
            slaBreached,
        };
    }

    async agentWorkload(workspaceId: string) {
        const agents = await this.prisma.workspaceMember.findMany({
            where: {
                workspaceId,
                role: 'agent',
                status: 'active',
            },
        });

        const result = await Promise.all(
            agents.map(async agent => {
                const openCount = await this.prisma.contact.count({
                    where: {
                        workspaceId,
                        assigneeId: agent.userId,
                        // status: 'open',
                    },
                });

                return {
                    userId: agent.userId,
                    openConversations: openCount,
                };
            }),
        );

        return result;
    }

    async conversationVolume(workspaceId: string, days = 7) {
        const from = new Date();
        from.setDate(from.getDate() - days);

        const data = await this.prisma.conversation.groupBy({
            by: ['createdAt'],
            where: {
                workspaceId,
                createdAt: { gte: from },
            },
            _count: true,
        });

        return data;
    }
    async responseMetrics(workspaceId: string) {
        const conversations = await this.prisma.conversation.findMany({
            where: {
                workspaceId,
                firstResponseAt: { not: null },
                resolvedAt: { not: null },
            },
        });

        let totalFRT = 0;
        let totalART = 0;

        for (const convo of conversations) {
            const frt =
                new Date(convo.firstResponseAt!).getTime() -
                new Date(convo.createdAt).getTime();

            const art =
                new Date(convo.resolvedAt!).getTime() -
                new Date(convo.createdAt).getTime();

            totalFRT += frt;
            totalART += art;
        }

        const count = conversations.length || 1;

        return {
            averageFirstResponseMinutes:
                Math.round((totalFRT / count) / 60000),
            averageResolutionMinutes:
                Math.round((totalART / count) / 60000),
        };
    }
    async rebuildDashboard(workspaceId: string) {
        const overview = await this.overview(workspaceId);
        const response = await this.responseMetrics(workspaceId);

        const dashboard = {
            ...overview,
            ...response,
        };

        await this.redis.setJSON(
            `dashboard:${workspaceId}`,
            dashboard,
        );

        return dashboard;
    }
}