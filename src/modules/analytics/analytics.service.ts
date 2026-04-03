import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { AnalyticsFilterDto } from './dto/analytics-filter.dto';

@Injectable()
export class AnalyticsService {
    constructor(private prisma: PrismaService, private redis: RedisService) { }


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


    async getDashboardContacts(
        workspaceId: string,
        tab: 'open' | 'assigned' | 'unassigned',
        cursor?: string,
        limit = 10,
    ) {
        const take = Math.min(limit, 50);

        // Tab counts
        const [openCount, assignedCount, unassignedCount] = await Promise.all([
            this.prisma.contact.count({ where: { workspaceId, status: 'open' } }),
            this.prisma.contact.count({ where: { workspaceId, assigneeId: { not: null } } }),
            this.prisma.contact.count({ where: { workspaceId, assigneeId: null, status: 'open' } }),
        ]);

        // Build where for selected tab
        const where: any = { workspaceId };
        if (tab === 'open') where.status = 'open';
        if (tab === 'assigned') where.assigneeId = { not: null };
        if (tab === 'unassigned') { where.assigneeId = null; where.status = 'open'; }

        const rows = await this.prisma.conversation.findMany({
            where,
            orderBy: { updatedAt: 'desc' },
            take: take + 1,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            include: {
                contact: {
                    include: {
                        contactChannels: {
                            select: { channelType: true, identifier: true },
                            take: 3,
                        },
                        assignee: {
                            select: { id: true, firstName: true, lastName: true, avatarUrl: true },
                        },
                        lifecycle: {
                            select: { id: true, name: true, emoji: true },
                        },
                    }
                },
                lastMessage:true

            },
        });

        const hasMore = rows.length > take;
        const data = hasMore ? rows.slice(0, take) : rows;
        const nextCursor = hasMore ? data[data.length - 1].id : undefined;

        return {
            data: data.map(c => ({
                ...c,
                conversation: c.contact[0] ?? null,
                conversations: undefined,
            })),
            nextCursor,
            counts: { open: openCount, assigned: assignedCount, unassigned: unassignedCount },
        };
    }

    async getDashboardMembers(
        workspaceId: string,
        page = 1,
        limit = 10,
        statusFilter?: string,
    ) {
        const take = Math.min(limit, 50);
        const skip = (page - 1) * take;

        const where: any = { workspaceId, status: 'active' };

        const [total, members] = await Promise.all([
            this.prisma.workspaceMember.count({ where }),
            this.prisma.workspaceMember.findMany({
                where,
                skip,
                take,
                orderBy: { joinedAt: 'desc' },
                include: {
                    user: { include: { userActivity: true } },
                },
            }),
        ]);

        let data = members.map(m => ({
            id: m.id,
            userId: m.userId,
            role: m.role,
            availability: m.availability,
            joinedAt: m.joinedAt,
            assignedCount: 0, // filled below
            user: {
                id: m.user.id,
                firstName: m.user.firstName,
                lastName: m.user.lastName,
                avatarUrl: m.user.avatarUrl,
                email: m.user.email,
                activityStatus: m.user.userActivity?.activityStatus ?? 'offline',
                lastSeenAt: m.user.userActivity?.lastSeenAt ?? null,
            },
        }));

        // Get assigned contact counts
        const counts = await Promise.all(
            data.map(m =>
                this.prisma.contact.count({ where: { workspaceId, assigneeId: m.userId } }),
            ),
        );
        data = data.map((m, i) => ({ ...m, assignedCount: counts[i] }));

        // Filter by status after fetching (activity status is in userActivity)
        if (statusFilter && statusFilter !== 'all') {
            data = data.filter(m => m.user.activityStatus === statusFilter);
        }

        return {
            data,
            total,
            page,
            totalPages: Math.ceil(total / take),
            hasMore: page * take < total,
        };
    }

    // Make findMergeSuggestions public
    async findMergeSuggestions(workspaceId: string) {
        const emailDupes = await this.prisma.$queryRaw<any[]>`
    SELECT email, array_agg(id::text) as ids
    FROM "Contact"
    WHERE "workspaceId" = ${workspaceId}::uuid
      AND email IS NOT NULL AND email != ''
    GROUP BY email HAVING count(*) > 1
    LIMIT 10
  `;

        const phoneDupes = await this.prisma.$queryRaw<any[]>`
    SELECT phone, array_agg(id::text) as ids
    FROM "Contact"
    WHERE "workspaceId" = ${workspaceId}::uuid
      AND phone IS NOT NULL AND phone != ''
    GROUP BY phone HAVING count(*) > 1
    LIMIT 10
  `;

        const suggestions: any[] = [];
        const seen = new Set<string>();

        for (const dupe of [...emailDupes, ...phoneDupes]) {
            const [id1, id2] = dupe.ids;
            const key = [id1, id2].sort().join('-');
            if (seen.has(key)) continue;
            seen.add(key);

            const [c1, c2] = await Promise.all([
                this.prisma.contact.findUnique({
                    where: { id: id1 },
                    include: { contactChannels: { select: { channelType: true }, take: 3 } },
                }),
                this.prisma.contact.findUnique({
                    where: { id: id2 },
                    include: { contactChannels: { select: { channelType: true }, take: 3 } },
                }),
            ]);

            if (c1 && c2) suggestions.push({ contact1: c1, contact2: c2 });
        }

        return suggestions.slice(0, 5);
    }

    private buildDateRange(filter: AnalyticsFilterDto) {
        const from = filter.from
            ? new Date(filter.from)
            : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const to = filter.to ? new Date(filter.to) : new Date();

        return { from, to };
    }

    private buildMessageWhere(workspaceId: string, filter: AnalyticsFilterDto) {
        const { from, to } = this.buildDateRange(filter);

        return {
            workspaceId,
            createdAt: {
                gte: from,
                lte: to,
            },
            ...(filter.channelId ? { channelId: filter.channelId } : {}),
            ...(filter.channelType ? { channelType: filter.channelType } : {}),
        };
    }

    private buildContactWhere(workspaceId: string, filter: AnalyticsFilterDto) {
        const { from, to } = this.buildDateRange(filter);

        return {
            workspaceId,
            createdAt: {
                gte: from,
                lte: to,
            },
            ...(filter.agentId ? { assigneeId: filter.agentId } : {}),
            ...(filter.teamId ? { teamId: filter.teamId } : {}),
        };
    }

    private buildConversationWhere(workspaceId: string, filter: AnalyticsFilterDto) {
        const { from, to } = this.buildDateRange(filter);

        return {
            workspaceId,
            createdAt: {
                gte: from,
                lte: to,
            },
        };
    }

    private getChannelColor(channel: string) {
        const map: Record<string, string> = {
            whatsapp: '#25D366',
            instagram: '#E1306C',
            messenger: '#0084FF',
            facebook: '#1877F2',
            email: '#7C3AED',
            gmail: '#EA4335',
            unknown: '#94A3B8',
        };

        return map[(channel || 'unknown').toLowerCase()] || '#93C5FD';
    }

    private mapBarDonut(rows: { label: string; value: number }[]) {
        const total = rows.reduce((sum, r) => sum + r.value, 0);

        return {
            total,
            bar: rows.map(r => ({
                label: r.label,
                value: r.value,
                color: this.getChannelColor(r.label),
            })),
            donut: rows.map(r => ({
                label: r.label,
                value: r.value,
                color: this.getChannelColor(r.label),
            })),
        };
    }

    // ─────────────────────────────────────────────────────────────
    // OVERVIEW
    // ─────────────────────────────────────────────────────────────

    async overview(workspaceId: string) {
        const [totalContacts, openContacts, resolvedContacts, slaBreached, totalConversations, totalMessages] =
            await Promise.all([
                this.prisma.contact.count({
                    where: { workspaceId },
                }),
                this.prisma.contact.count({
                    where: { workspaceId, status: 'open' },
                }),
                this.prisma.contact.count({
                    where: { workspaceId, status: 'resolved' },
                }),
                this.prisma.conversation.count({
                    where: { workspaceId, slaBreached: true },
                }),
                this.prisma.conversation.count({
                    where: { workspaceId },
                }),
                this.prisma.message.count({
                    where: { workspaceId },
                }),
            ]);

        return {
            totalContacts,
            openContacts,
            resolvedContacts,
            slaBreached,
            totalConversations,
            totalMessages,
        };
    }

    // ─────────────────────────────────────────────────────────────
    // RESPONSE METRICS
    // ─────────────────────────────────────────────────────────────

    async responseMetrics(workspaceId: string, filter?: AnalyticsFilterDto) {
        const where = {
            workspaceId,
            ...(filter?.from || filter?.to
                ? {
                    createdAt: {
                        ...(filter?.from ? { gte: new Date(filter.from) } : {}),
                        ...(filter?.to ? { lte: new Date(filter.to) } : {}),
                    },
                }
                : {}),
            firstResponseAt: { not: null },
            resolvedAt: { not: null },
        };

        const conversations = await this.prisma.conversation.findMany({
            where,
            select: {
                createdAt: true,
                firstResponseAt: true,
                resolvedAt: true,
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
            averageFirstResponseMinutes: Math.round(totalFRT / count / 60000),
            averageResolutionMinutes: Math.round(totalART / count / 60000),
        };
    }

    // ─────────────────────────────────────────────────────────────
    // LIFECYCLE
    // ─────────────────────────────────────────────────────────────

    async getLifecycleStats(workspaceId: string) {
        const stages = await this.prisma.lifecycleStage.findMany({
            where: { workspaceId },
            orderBy: { order: 'asc' },
            include: { _count: { select: { contacts: true } } },
        });

        const total = await this.prisma.contact.count({ where: { workspaceId } });

        return {
            total,
            stages: stages.map(s => ({
                id: s.id,
                name: s.name,
                emoji: s.emoji,
                count: s._count.contacts,
                percent: total > 0 ? Math.round((s._count.contacts / total) * 100) : 0,
            })),
            chart: this.mapBarDonut(
                stages.map(s => ({
                    label: s.name,
                    value: s._count.contacts,
                })),
            ),
        };
    }

    // ─────────────────────────────────────────────────────────────
    // MESSAGES
    // ─────────────────────────────────────────────────────────────

    async getIncomingMessagesByChannel(workspaceId: string, filter: AnalyticsFilterDto) {
        const rows = await this.prisma.message.groupBy({
            by: ['channelType'],
            where: {
                ...this.buildMessageWhere(workspaceId, filter),
                direction: 'incoming',
            },
            _count: { _all: true },
        });

        return this.mapBarDonut(
            rows.map(r => ({
                label: r.channelType || 'unknown',
                value: r._count._all,
            })),
        );
    }

    async getOutgoingMessagesByChannel(workspaceId: string, filter: AnalyticsFilterDto) {
        const rows = await this.prisma.message.groupBy({
            by: ['channelType'],
            where: {
                ...this.buildMessageWhere(workspaceId, filter),
                direction: 'outgoing',
            },
            _count: { _all: true },
        });

        return this.mapBarDonut(
            rows.map(r => ({
                label: r.channelType || 'unknown',
                value: r._count._all,
            })),
        );
    }

    async getOutgoingDeliveryFunnel(workspaceId: string, filter: AnalyticsFilterDto) {
        const baseWhere = {
            ...this.buildMessageWhere(workspaceId, filter),
            direction: 'outgoing',
        };

        const [pending, sent, delivered, read, failed] = await Promise.all([
            this.prisma.message.count({ where: { ...baseWhere, status: 'pending' } }),
            this.prisma.message.count({ where: { ...baseWhere, status: 'sent' } }),
            this.prisma.message.count({ where: { ...baseWhere, status: 'delivered' } }),
            this.prisma.message.count({ where: { ...baseWhere, status: 'read' } }),
            this.prisma.message.count({ where: { ...baseWhere, status: 'failed' } }),
        ]);

        const rows = [
            { label: 'pending', value: pending },
            { label: 'sent', value: sent },
            { label: 'delivered', value: delivered },
            { label: 'read', value: read },
            { label: 'failed', value: failed },
        ];

        return {
            total: rows.reduce((sum, r) => sum + r.value, 0),
            bar: rows.map(r => ({
                ...r,
                color:
                    r.label === 'failed'
                        ? '#EF4444'
                        : r.label === 'read'
                            ? '#10B981'
                            : r.label === 'delivered'
                                ? '#3B82F6'
                                : r.label === 'sent'
                                    ? '#8B5CF6'
                                    : '#F59E0B',
            })),
            donut: rows.map(r => ({
                ...r,
                color:
                    r.label === 'failed'
                        ? '#EF4444'
                        : r.label === 'read'
                            ? '#10B981'
                            : r.label === 'delivered'
                                ? '#3B82F6'
                                : r.label === 'sent'
                                    ? '#8B5CF6'
                                    : '#F59E0B',
            })),
        };
    }

    async getFailedMessageLogs(
        workspaceId: string,
        filter: AnalyticsFilterDto,
        page = 1,
        limit = 20,
    ) {
        const take = Math.min(limit, 100);
        const skip = (page - 1) * take;
        const { from, to } = this.buildDateRange(filter);

        const where = {
            workspaceId,
            status: 'failed',
            createdAt: {
                gte: from,
                lte: to,
            },
            ...(filter.channelId ? { channelId: filter.channelId } : {}),
        };

        const [total, rows] = await Promise.all([
            this.prisma.outboundQueue.count({ where }),
            this.prisma.outboundQueue.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                include: {
                    channel: {
                        select: {
                            id: true,
                            name: true,
                            type: true,
                        },
                    },
                    message: {
                        select: {
                            id: true,
                            text: true,
                            type: true,
                            status: true,
                            conversationId: true,
                        },
                    },
                },
            }),
        ]);

        return {
            total,
            page,
            totalPages: Math.ceil(total / take),
            data: rows,
        };
    }

    async getMessagesAnalytics(workspaceId: string, filter: AnalyticsFilterDto) {
        const [incoming, outgoing, funnel, totalMessages, incomingCount, outgoingCount] =
            await Promise.all([
                this.getIncomingMessagesByChannel(workspaceId, filter),
                this.getOutgoingMessagesByChannel(workspaceId, filter),
                this.getOutgoingDeliveryFunnel(workspaceId, filter),
                this.prisma.message.count({
                    where: this.buildMessageWhere(workspaceId, filter),
                }),
                this.prisma.message.count({
                    where: {
                        ...this.buildMessageWhere(workspaceId, filter),
                        direction: 'incoming',
                    },
                }),
                this.prisma.message.count({
                    where: {
                        ...this.buildMessageWhere(workspaceId, filter),
                        direction: 'outgoing',
                    },
                }),
            ]);

        const avgPerConversationRaw = await this.prisma.$queryRaw<any[]>`
      SELECT COALESCE(ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT "conversationId"), 0), 2), 0) as avg
      FROM "Message"
      WHERE "workspaceId" = ${workspaceId}::uuid
        AND "createdAt" >= ${this.buildDateRange(filter).from}
        AND "createdAt" <= ${this.buildDateRange(filter).to}
    `;

        return {
            stats: {
                totalMessages,
                incoming: incomingCount,
                outgoing: outgoingCount,
                avgPerConversation: Number(avgPerConversationRaw?.[0]?.avg || 0),
            },
            incoming,
            outgoing,
            funnel,
        };
    }

    // ─────────────────────────────────────────────────────────────
    // CONTACTS
    // ─────────────────────────────────────────────────────────────

    async getContactsAddedByDay(workspaceId: string, filter: AnalyticsFilterDto) {
        const { from, to } = this.buildDateRange(filter);
        console.log({ from, to, workspaceId });

        const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        TO_CHAR(DATE("createdAt"), 'YYYY-MM-DD') as day,
        COUNT(*)::int as count
      FROM "Contact"
      WHERE "workspaceId" = ${workspaceId}::uuid
        AND "createdAt" >= ${from}
        AND "createdAt" <= ${to}
      GROUP BY DATE("createdAt")
      ORDER BY DATE("createdAt") ASC
    `;

        return rows.map(r => ({
            label: r.day,
            value: Number(r.count),
            color: '#3B82F6',
        }));
    }

    async getContactsDeletedByDay(workspaceId: string, filter: AnalyticsFilterDto) {
        try {
            const { from, to } = this.buildDateRange(filter);

            const rows = await this.prisma.$queryRaw<any[]>`
        SELECT
          TO_CHAR(DATE("deletedAt"), 'YYYY-MM-DD') as day,
          COUNT(*)::int as count
        FROM "Contact"
        WHERE "workspaceId" = ${workspaceId}::uuid
          AND "deletedAt" IS NOT NULL
          AND "deletedAt" >= ${from}
          AND "deletedAt" <= ${to}
        GROUP BY DATE("deletedAt")
        ORDER BY DATE("deletedAt") ASC
      `;

            return rows.map(r => ({
                label: r.day,
                value: Number(r.count),
                color: '#EF4444',
            }));
        } catch {
            return [];
        }
    }

    async getContactConnectionsByChannelByDay(workspaceId: string, filter: AnalyticsFilterDto) {
        const { from, to } = this.buildDateRange(filter);

        const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        TO_CHAR(DATE("createdAt"), 'YYYY-MM-DD') as day,
        "channelType",
        COUNT(*)::int as count
      FROM "ContactChannel"
      WHERE "workspaceId" = ${workspaceId}::uuid
        AND "createdAt" >= ${from}
        AND "createdAt" <= ${to}
      GROUP BY DATE("createdAt"), "channelType"
      ORDER BY DATE("createdAt") ASC
    `;

        return rows.map(r => ({
            day: r.day,
            channelType: r.channelType || 'unknown',
            count: Number(r.count),
        }));
    }

    async getNewContactsByChannel(workspaceId: string, filter: AnalyticsFilterDto) {
        const { from, to } = this.buildDateRange(filter);

        const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        cc."channelType",
        COUNT(DISTINCT cc."contactId")::int as count
      FROM "ContactChannel" cc
      INNER JOIN "Contact" c ON c.id = cc."contactId"
      WHERE cc."workspaceId" = ${workspaceId}::uuid
        AND c."createdAt" >= ${from}
        AND c."createdAt" <= ${to}
      GROUP BY cc."channelType"
      ORDER BY count DESC
    `;

        return this.mapBarDonut(
            rows.map(r => ({
                label: r.channelType || 'unknown',
                value: Number(r.count),
            })),
        );
    }

    async getContactsAnalytics(workspaceId: string, filter: AnalyticsFilterDto) {
        const [addedByDay, deletedByDay, byChannel, connectedByDay, totalContacts, newContacts] =
            await Promise.all([
                this.getContactsAddedByDay(workspaceId, filter),
                this.getContactsDeletedByDay(workspaceId, filter),
                this.getNewContactsByChannel(workspaceId, filter),
                this.getContactConnectionsByChannelByDay(workspaceId, filter),
                this.prisma.contact.count({
                    where: { workspaceId },
                }),
                this.prisma.contact.count({
                    where: this.buildContactWhere(workspaceId, filter),
                }),
            ]);

        return {
            stats: {
                totalContacts,
                newContacts,
                deletedContacts: deletedByDay.reduce((sum, d) => sum + d.value, 0),
                activeConnections: connectedByDay.reduce((sum, d) => sum + d.count, 0),
            },
            addedByDay,
            deletedByDay,
            byChannel,
            connectedByDay,
        };
    }

    // ─────────────────────────────────────────────────────────────
    // CONVERSATIONS
    // ─────────────────────────────────────────────────────────────

    async getConversationsOpenedByDay(workspaceId: string, filter: AnalyticsFilterDto) {
        const { from, to } = this.buildDateRange(filter);

        const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        TO_CHAR(DATE("createdAt"), 'YYYY-MM-DD') as day,
        COUNT(*)::int as count
      FROM "Conversation"
      WHERE "workspaceId" = ${workspaceId}::uuid
        AND "createdAt" >= ${from}
        AND "createdAt" <= ${to}
      GROUP BY DATE("createdAt")
      ORDER BY DATE("createdAt") ASC
    `;

        return rows.map(r => ({
            label: r.day,
            value: Number(r.count),
            color: '#3B82F6',
        }));
    }

    async getConversationsClosedByDay(workspaceId: string, filter: AnalyticsFilterDto) {
        const { from, to } = this.buildDateRange(filter);

        const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        TO_CHAR(DATE("resolvedAt"), 'YYYY-MM-DD') as day,
        COUNT(*)::int as count
      FROM "Conversation"
      WHERE "workspaceId" = ${workspaceId}::uuid
        AND "resolvedAt" IS NOT NULL
        AND "resolvedAt" >= ${from}
        AND "resolvedAt" <= ${to}
      GROUP BY DATE("resolvedAt")
      ORDER BY DATE("resolvedAt") ASC
    `;

        return rows.map(r => ({
            label: r.day,
            value: Number(r.count),
            color: '#10B981',
        }));
    }

    async getConversationsByStatus(workspaceId: string, filter: AnalyticsFilterDto) {
        const rows = await this.prisma.conversation.groupBy({
            by: ['status'],
            where: this.buildConversationWhere(workspaceId, filter),
            _count: { _all: true },
        });

        return this.mapBarDonut(
            rows.map(r => ({
                label: r.status || 'unknown',
                value: r._count._all,
            })),
        );
    }

    async getConversationsAnalytics(workspaceId: string, filter: AnalyticsFilterDto) {
        const [openedByDay, closedByDay, byStatus, responseMetrics, total, open, resolved] =
            await Promise.all([
                this.getConversationsOpenedByDay(workspaceId, filter),
                this.getConversationsClosedByDay(workspaceId, filter),
                this.getConversationsByStatus(workspaceId, filter),
                this.responseMetrics(workspaceId, filter),
                this.prisma.conversation.count({
                    where: this.buildConversationWhere(workspaceId, filter),
                }),
                this.prisma.conversation.count({
                    where: {
                        ...this.buildConversationWhere(workspaceId, filter),
                        status: 'open',
                    },
                }),
                this.prisma.conversation.count({
                    where: {
                        ...this.buildConversationWhere(workspaceId, filter),
                        status: 'resolved',
                    },
                }),
            ]);

        return {
            stats: {
                total,
                open,
                resolved,
                avgHandleTimeMinutes: responseMetrics.averageResolutionMinutes,
                averageFirstResponseMinutes: responseMetrics.averageFirstResponseMinutes,
            },
            openedByDay,
            closedByDay,
            byStatus,
            responseMetrics,
        };
    }

    // ─────────────────────────────────────────────────────────────
    // DASHBOARD CACHE
    // ─────────────────────────────────────────────────────────────

    async rebuildDashboard(workspaceId: string) {
        const overview = await this.overview(workspaceId);
        const response = await this.responseMetrics(workspaceId);

        const dashboard = {
            ...overview,
            ...response,
        };

        await this.redis.setJSON(`dashboard:${workspaceId}`, dashboard);

        return dashboard;
    }
}