import { Injectable } from '@nestjs/common';
import { AuthAuditEvent, type Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  PlatformAdminListQueryDto,
} from './dto/platform-admin-list-query.dto';
import type { PlatformAdminUser } from './platform-admin.guard';
import {
  AuditLogRow,
  BillingRow,
  ChannelHealthRow,
  OrganizationRow,
  PlatformDashboard,
  PlatformPaginatedResponse,
  PlatformPagination,
  PlatformUserRow,
  SystemHealthRow,
  UsageRow,
  WorkspaceRow,
} from './platform-admin.types';

type PageInput = {
  page?: number;
  limit?: number;
};

type WorkspaceMessageCount = Map<string, number>;

const platformAdminUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  organizationMemberships: {
    take: 2,
    select: {
      role: true,
      organization: { select: { name: true } },
    },
  },
  workspaceMemberships: {
    select: { role: true, workspaceId: true },
  },
} satisfies Prisma.UserSelect;

type PlatformAdminUserRecord = Prisma.UserGetPayload<{
  select: typeof platformAdminUserSelect;
}>;

@Injectable()
export class PlatformAdminService {
  constructor(private readonly prisma: PrismaService) {}

  getMe(admin: PlatformAdminUser) {
    const name =
      [admin.firstName, admin.lastName].filter(Boolean).join(' ').trim() ||
      admin.email;

    return {
      id: admin.id,
      name,
      email: admin.email,
      role: admin.role,
      permissions: admin.permissions,
    };
  }

  async getDashboard(): Promise<PlatformDashboard> {
    const currentMonth = this.getCurrentMonthStart();
    const [
      organizationCount,
      workspaceCount,
      activeUserCount,
      monthlyMessages,
      aiUsage,
      unhealthyChannels,
      pastDueSubscriptions,
      failedOutbound,
      organizations,
      workspaces,
      users,
      billing,
      usage,
      channels,
      system,
      audit,
    ] = await Promise.all([
      this.prisma.organization.count(),
      this.prisma.workspace.count(),
      this.prisma.user.count({ where: { status: { in: ['ACTIVE', 'active'] } } }),
      this.prisma.message.count({ where: { createdAt: { gte: currentMonth } } }),
      this.prisma.usage.aggregate({
        where: {
          metric: { contains: 'ai', mode: 'insensitive' },
          period: this.getCurrentPeriodKey(),
        },
        _sum: { value: true },
      }),
      this.prisma.channel.count({
        where: { status: { notIn: ['connected', 'active'] } },
      }),
      this.prisma.subscription.count({
        where: { status: { in: ['past_due', 'unpaid', 'paused'] } },
      }),
      this.prisma.outboundQueue.count({
        where: { status: 'failed', updatedAt: { gte: this.hoursAgo(24) } },
      }),
      this.listOrganizations({ page: 1, limit: 5 }),
      this.listWorkspaces({ page: 1, limit: 5 }),
      this.listUsers({ page: 1, limit: 5 }),
      this.listBilling({ page: 1, limit: 5 }),
      this.listUsage({ page: 1, limit: 5 }),
      this.listChannels({ page: 1, limit: 5 }),
      this.listSystemHealth(),
      this.listAuditLogs({ page: 1, limit: 5 }),
    ]);

    return {
      metrics: [
        {
          id: 'orgs',
          label: 'Active organizations',
          value: this.formatNumber(organizationCount),
          delta: `${this.formatNumber(workspaceCount)} workspaces`,
          tone: 'neutral',
        },
        {
          id: 'messages',
          label: 'Messages this month',
          value: this.formatNumber(monthlyMessages),
          delta: 'Current billing period',
          tone: 'success',
        },
        {
          id: 'ai',
          label: 'AI usage',
          value: this.formatNumber(aiUsage._sum.value ?? 0),
          delta: 'Usage metric contains ai',
          tone: 'neutral',
        },
        {
          id: 'risks',
          label: 'Operational risks',
          value: this.formatNumber(unhealthyChannels + pastDueSubscriptions + failedOutbound),
          delta: `${unhealthyChannels} channels need review`,
          tone: unhealthyChannels + pastDueSubscriptions + failedOutbound > 0 ? 'warning' : 'success',
        },
        {
          id: 'users',
          label: 'Active users',
          value: this.formatNumber(activeUserCount),
          delta: 'Activated accounts',
          tone: 'neutral',
        },
      ],
      organizations: organizations.items,
      workspaces: workspaces.items,
      users: users.items,
      billing: billing.items,
      usage: usage.items,
      channels: channels.items,
      system,
      audit: audit.items,
    };
  }

  async listOrganizations(
    query: PlatformAdminListQueryDto,
  ): Promise<PlatformPaginatedResponse<OrganizationRow>> {
    const { page, limit } = this.normalizePage(query);
    const search = query.search?.trim();
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { website: { contains: search, mode: 'insensitive' as const } },
            { plan: { contains: search, mode: 'insensitive' as const } },
            {
              members: {
                some: {
                  user: {
                    email: { contains: search, mode: 'insensitive' as const },
                  },
                },
              },
            },
          ],
        }
      : {};

    const [organizations, total] = await this.prisma.$transaction([
      this.prisma.organization.findMany({
        where,
        select: {
          id: true,
          name: true,
          plan: true,
          createdAt: true,
          members: {
            where: { role: 'ORG_ADMIN' },
            take: 1,
            select: { user: { select: { email: true } } },
          },
          _count: { select: { workspaces: true, members: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.organization.count({ where }),
    ]);

    const messageCounts = await this.getOrganizationMonthlyMessageCounts(
      organizations.map((organization) => organization.id),
    );

    return {
      items: organizations.map((organization) => ({
        id: organization.id,
        name: organization.name,
        ownerEmail: organization.members[0]?.user.email ?? 'Unassigned',
        plan: organization.plan,
        status: 'active',
        workspaces: organization._count.workspaces,
        users: organization._count.members,
        monthlyMessages: messageCounts.get(organization.id) ?? 0,
        lastActivity: this.formatDateTime(organization.createdAt),
      })),
      pagination: this.buildPagination(total, page, limit),
    };
  }

  async getOrganization(organizationId: string): Promise<OrganizationRow | null> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        plan: true,
        createdAt: true,
        members: {
          where: { role: 'ORG_ADMIN' },
          take: 1,
          select: { user: { select: { email: true } } },
        },
        _count: { select: { workspaces: true, members: true } },
      },
    });

    if (!organization) return null;

    const messageCounts = await this.getOrganizationMonthlyMessageCounts([organization.id]);

    return {
      id: organization.id,
      name: organization.name,
      ownerEmail: organization.members[0]?.user.email ?? 'Unassigned',
      plan: organization.plan,
      status: 'active',
      workspaces: organization._count.workspaces,
      users: organization._count.members,
      monthlyMessages: messageCounts.get(organization.id) ?? 0,
      lastActivity: this.formatDateTime(organization.createdAt),
    };
  }

  async listWorkspaces(
    query: PlatformAdminListQueryDto,
  ): Promise<PlatformPaginatedResponse<WorkspaceRow>> {
    const { page, limit } = this.normalizePage(query);
    const search = query.search?.trim();
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            {
              organization: {
                name: { contains: search, mode: 'insensitive' as const },
              },
            },
          ],
        }
      : {};

    const [workspaces, total] = await this.prisma.$transaction([
      this.prisma.workspace.findMany({
        where,
        select: {
          id: true,
          name: true,
          organizationId: true,
          createdAt: true,
          organization: { select: { name: true } },
          aiSettings: { select: { enabled: true } },
          _count: { select: { members: true, channels: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.workspace.count({ where }),
    ]);

    const messageCounts = await this.getWorkspaceMonthlyMessageCounts(
      workspaces.map((workspace) => workspace.id),
    );

    return {
      items: workspaces.map((workspace) =>
        this.toWorkspaceRow(workspace, messageCounts),
      ),
      pagination: this.buildPagination(total, page, limit),
    };
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRow | null> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        organizationId: true,
        createdAt: true,
        organization: { select: { name: true } },
        aiSettings: { select: { enabled: true } },
        _count: { select: { members: true, channels: true } },
      },
    });

    if (!workspace) return null;

    const messageCounts = await this.getWorkspaceMonthlyMessageCounts([workspace.id]);
    return this.toWorkspaceRow(workspace, messageCounts);
  }

  async listUsers(
    query: PlatformAdminListQueryDto,
  ): Promise<PlatformPaginatedResponse<PlatformUserRow>> {
    const { page, limit } = this.normalizePage(query);
    const search = query.search?.trim();
    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
            { status: { contains: search, mode: 'insensitive' as const } },
            {
              organizationMemberships: {
                some: {
                  organization: {
                    name: { contains: search, mode: 'insensitive' as const },
                  },
                },
              },
            },
          ],
        }
      : {};

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: platformAdminUserSelect,
        orderBy: [{ lastLoginAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: users.map((user) => this.toPlatformUserRow(user)),
      pagination: this.buildPagination(total, page, limit),
    };
  }

  async getUser(userId: string): Promise<PlatformUserRow | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: platformAdminUserSelect,
    });

    return user ? this.toPlatformUserRow(user) : null;
  }

  async listBilling(
    query: PlatformAdminListQueryDto,
  ): Promise<PlatformPaginatedResponse<BillingRow>> {
    const { page, limit } = this.normalizePage(query);
    const search = query.search?.trim();
    const workspaceIds = search
      ? await this.findWorkspaceIdsMatchingSearch(search)
      : [];
    const where: Prisma.SubscriptionWhereInput = search
      ? {
          OR: [
            { plan: { contains: search, mode: 'insensitive' as const } },
            { status: { contains: search, mode: 'insensitive' as const } },
            { provider: { contains: search, mode: 'insensitive' as const } },
            ...(workspaceIds.length
              ? [{ workspaceId: { in: workspaceIds } }]
              : []),
          ],
        }
      : {};

    const [subscriptions, total] = await this.prisma.$transaction([
      this.prisma.subscription.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.subscription.count({ where }),
    ]);
    const workspaceMap = await this.getWorkspaceOrganizationMap(
      subscriptions.map((subscription) => subscription.workspaceId),
    );

    return {
      items: subscriptions.map((subscription) => {
        const workspace = workspaceMap.get(subscription.workspaceId);

        return {
          id: subscription.id,
          organizationName: workspace?.organizationName ?? 'Unknown organization',
          plan: subscription.plan,
          seats: subscription.quantity,
          amount: subscription.provider ? subscription.provider : 'Provider not set',
          status: this.normalizeSubscriptionStatus(subscription.status),
          renewsAt: this.formatDateTime(subscription.currentPeriodEnd),
        };
      }),
      pagination: this.buildPagination(total, page, limit),
    };
  }

  async listUsage(
    query: PlatformAdminListQueryDto,
  ): Promise<PlatformPaginatedResponse<UsageRow>> {
    const { page, limit } = this.normalizePage(query);
    const search = query.search?.trim();
    const workspaceIds = search
      ? await this.findWorkspaceIdsMatchingSearch(search)
      : [];
    const where: Prisma.UsageWhereInput = search
      ? {
          OR: [
            { metric: { contains: search, mode: 'insensitive' as const } },
            { period: { contains: search, mode: 'insensitive' as const } },
            ...(workspaceIds.length
              ? [{ workspaceId: { in: workspaceIds } }]
              : []),
          ],
        }
      : {};

    const [usageRows, total] = await this.prisma.$transaction([
      this.prisma.usage.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.usage.count({ where }),
    ]);
    const workspaceMap = await this.getWorkspaceOrganizationMap(
      usageRows.map((usage) => usage.workspaceId),
    );

    return {
      items: usageRows.map((usage) => ({
        id: usage.id,
        organizationName:
          workspaceMap.get(usage.workspaceId)?.organizationName ??
          'Unknown organization',
        metric: usage.metric,
        used: usage.value,
        limit: this.estimateUsageLimit(usage.metric),
        period: usage.period,
      })),
      pagination: this.buildPagination(total, page, limit),
    };
  }

  async listChannels(
    query: PlatformAdminListQueryDto,
  ): Promise<PlatformPaginatedResponse<ChannelHealthRow>> {
    const { page, limit } = this.normalizePage(query);
    const search = query.search?.trim();
    const where: Prisma.ChannelWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { type: { contains: search, mode: 'insensitive' as const } },
            { status: { contains: search, mode: 'insensitive' as const } },
            { identifier: { contains: search, mode: 'insensitive' as const } },
            {
              workspace: {
                name: { contains: search, mode: 'insensitive' as const },
              },
            },
            {
              workspace: {
                organization: {
                  name: { contains: search, mode: 'insensitive' as const },
                },
              },
            },
          ],
        }
      : {};

    const [channels, total] = await this.prisma.$transaction([
      this.prisma.channel.findMany({
        where,
        select: {
          id: true,
          name: true,
          type: true,
          identifier: true,
          status: true,
          createdAt: true,
          workspace: {
            select: {
              name: true,
              organization: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.channel.count({ where }),
    ]);

    const lastInboundMessages = await Promise.all(
      channels.map((channel) =>
        this.prisma.message.findFirst({
          where: { channelId: channel.id, direction: 'incoming' },
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
      ),
    );

    return {
      items: channels.map((channel, index) => ({
        id: channel.id,
        organizationName: channel.workspace.organization.name,
        workspaceName: channel.workspace.name,
        provider: this.formatProvider(channel.type),
        status: this.normalizeChannelStatus(channel.status),
        connectedAccount: channel.identifier,
        lastInboundAt: this.formatDateTime(lastInboundMessages[index]?.createdAt),
        lastError:
          channel.status === 'connected' || channel.status === 'active'
            ? 'None'
            : `Channel status: ${channel.status}`,
      })),
      pagination: this.buildPagination(total, page, limit),
    };
  }

  async listSystemHealth(): Promise<SystemHealthRow[]> {
    const [pendingOutbound, failedOutbound, unhealthyChannels, failedImports] =
      await Promise.all([
        this.prisma.outboundQueue.count({ where: { status: 'pending' } }),
        this.prisma.outboundQueue.count({
          where: { status: 'failed', updatedAt: { gte: this.hoursAgo(24) } },
        }),
        this.prisma.channel.count({
          where: { status: { notIn: ['connected', 'active'] } },
        }),
        this.prisma.importExportJob.count({
          where: { status: 'FAILED', updatedAt: { gte: this.hoursAgo(24) } },
        }),
      ]);

    return [
      {
        id: 'outbound-queue',
        area: 'Outbound queue',
        status: failedOutbound > 0 ? 'warning' : 'healthy',
        signal: `${failedOutbound} failed in 24h`,
        volume: `${pendingOutbound} pending`,
        lastCheckedAt: 'Just now',
      },
      {
        id: 'channel-health',
        area: 'Provider channels',
        status: unhealthyChannels > 0 ? 'warning' : 'healthy',
        signal: `${unhealthyChannels} unhealthy channels`,
        volume: 'All connected channels',
        lastCheckedAt: 'Just now',
      },
      {
        id: 'imports',
        area: 'Import/export jobs',
        status: failedImports > 0 ? 'warning' : 'healthy',
        signal: `${failedImports} failed in 24h`,
        volume: 'Recent jobs',
        lastCheckedAt: 'Just now',
      },
    ];
  }

  async listAuditLogs(
    query: PlatformAdminListQueryDto,
  ): Promise<PlatformPaginatedResponse<AuditLogRow>> {
    const { page, limit } = this.normalizePage(query);
    const search = query.search?.trim();
    const where: Prisma.AuthAuditLogWhereInput = search
      ? { OR: this.buildAuditSearchFilters(search) }
      : {};

    const [logs, total] = await this.prisma.$transaction([
      this.prisma.authAuditLog.findMany({
        where,
        select: {
          id: true,
          event: true,
          metadata: true,
          organizationId: true,
          workspaceId: true,
          createdAt: true,
          user: { select: { email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.authAuditLog.count({ where }),
    ]);

    return {
      items: logs.map((log) => ({
        id: log.id,
        actor: log.user?.email ?? 'System',
        action: String(log.event),
        target: log.workspaceId ?? log.organizationId ?? 'Auth',
        status: 'success',
        reason: this.readMetadataString(log.metadata, 'reason') ?? 'Auth audit event',
        createdAt: this.formatDateTime(log.createdAt),
      })),
      pagination: this.buildPagination(total, page, limit),
    };
  }

  private normalizePage(input: PageInput) {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(Math.max(1, input.limit ?? 25), 100);
    return { page, limit };
  }

  private buildPagination(
    total: number,
    page: number,
    limit: number,
  ): PlatformPagination {
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }

  private getCurrentMonthStart() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  private getCurrentPeriodKey() {
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${now.getUTCFullYear()}-${month}`;
  }

  private hoursAgo(hours: number) {
    return new Date(Date.now() - hours * 60 * 60 * 1000);
  }

  private async getWorkspaceMonthlyMessageCounts(workspaceIds: string[]) {
    const counts: WorkspaceMessageCount = new Map();
    if (!workspaceIds.length) return counts;

    const grouped = await this.prisma.message.groupBy({
      by: ['workspaceId'],
      where: {
        workspaceId: { in: workspaceIds },
        createdAt: { gte: this.getCurrentMonthStart() },
      },
      _count: { _all: true },
    });

    grouped.forEach((row) => counts.set(row.workspaceId, row._count._all));
    return counts;
  }

  private async getOrganizationMonthlyMessageCounts(organizationIds: string[]) {
    const counts = new Map<string, number>();
    if (!organizationIds.length) return counts;

    const workspaces = await this.prisma.workspace.findMany({
      where: { organizationId: { in: organizationIds } },
      select: { id: true, organizationId: true },
    });
    const workspaceCounts = await this.getWorkspaceMonthlyMessageCounts(
      workspaces.map((workspace) => workspace.id),
    );

    workspaces.forEach((workspace) => {
      counts.set(
        workspace.organizationId,
        (counts.get(workspace.organizationId) ?? 0) +
          (workspaceCounts.get(workspace.id) ?? 0),
      );
    });

    return counts;
  }

  private toWorkspaceRow(
    workspace: {
      id: string;
      name: string;
      organizationId: string;
      createdAt: Date;
      organization: { name: string };
      aiSettings: { enabled: boolean } | null;
      _count: { members: number; channels: number };
    },
    messageCounts: WorkspaceMessageCount,
  ): WorkspaceRow {
    return {
      id: workspace.id,
      name: workspace.name,
      organizationId: workspace.organizationId,
      organizationName: workspace.organization.name,
      status: 'active',
      members: workspace._count.members,
      channels: workspace._count.channels,
      monthlyMessages: messageCounts.get(workspace.id) ?? 0,
      featureFlags: [
        ...(workspace.aiSettings?.enabled ? ['aiAgents'] : []),
      ],
      lastActivity: this.formatDateTime(workspace.createdAt),
    };
  }

  private async getWorkspaceOrganizationMap(workspaceIds: string[]) {
    const uniqueIds = [...new Set(workspaceIds.filter(Boolean))];
    const map = new Map<string, { workspaceName: string; organizationName: string }>();
    if (!uniqueIds.length) return map;

    const workspaces = await this.prisma.workspace.findMany({
      where: { id: { in: uniqueIds } },
      select: {
        id: true,
        name: true,
        organization: { select: { name: true } },
      },
    });

    workspaces.forEach((workspace) => {
      map.set(workspace.id, {
        workspaceName: workspace.name,
        organizationName: workspace.organization.name,
      });
    });

    return map;
  }

  private async findWorkspaceIdsMatchingSearch(search: string) {
    const workspaces = await this.prisma.workspace.findMany({
      where: {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          {
            organization: {
              name: { contains: search, mode: 'insensitive' as const },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    return workspaces.map((workspace) => workspace.id);
  }

  private getUserName(
    firstName: string | null,
    lastName: string | null,
    email: string,
  ) {
    const name = [firstName, lastName].filter(Boolean).join(' ').trim();
    return name || email.split('@')[0] || email;
  }

  private toPlatformUserRow(user: PlatformAdminUserRecord): PlatformUserRow {
    return {
      id: user.id,
      name: this.getUserName(user.firstName, user.lastName, user.email),
      email: user.email,
      organizationName:
        user.organizationMemberships[0]?.organization.name ?? 'No organization',
      workspaceCount: new Set(
        user.workspaceMemberships.map((membership) => membership.workspaceId),
      ).size,
      roleSummary: this.getRoleSummary([
        ...user.organizationMemberships.map((membership) => membership.role),
        ...user.workspaceMemberships.map((membership) => membership.role),
      ]),
      status: this.normalizeUserStatus(user.status),
      lastSeen: this.formatDateTime(user.lastLoginAt ?? user.createdAt),
    };
  }

  private getRoleSummary(roles: string[]) {
    const uniqueRoles = [...new Set(roles.filter(Boolean))];
    return uniqueRoles.length ? uniqueRoles.slice(0, 3).join(', ') : 'No roles';
  }

  private normalizeUserStatus(status?: string | null): PlatformUserRow['status'] {
    const normalized = status?.toLowerCase();
    if (normalized === 'active') return 'active';
    if (normalized === 'invited') return 'invited';
    return 'disabled';
  }

  private buildAuditSearchFilters(
    search: string,
  ): Prisma.AuthAuditLogWhereInput[] {
    const filters: Prisma.AuthAuditLogWhereInput[] = [
      { user: { email: { contains: search, mode: 'insensitive' as const } } },
    ];
    const eventMatches = this.findAuditEventsMatchingSearch(search);

    if (eventMatches.length) {
      filters.push({ event: { in: eventMatches } });
    }

    if (this.isUuid(search)) {
      filters.push({ organizationId: search }, { workspaceId: search });
    }

    return filters;
  }

  private findAuditEventsMatchingSearch(search: string) {
    const normalizedSearch = search.trim().toLowerCase();
    const normalizedEnumSearch = normalizedSearch.replace(/[\s-]+/g, '_');

    return Object.values(AuthAuditEvent).filter((event) => {
      const normalizedEvent = event.toLowerCase();
      return (
        normalizedEvent.includes(normalizedSearch) ||
        normalizedEvent.includes(normalizedEnumSearch)
      );
    });
  }

  private isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private normalizeSubscriptionStatus(status: string): BillingRow['status'] {
    const normalized = status.toLowerCase();
    if (normalized === 'cancelled') return 'canceled';
    if (['active', 'trialing', 'past_due', 'canceled'].includes(normalized)) {
      return normalized as BillingRow['status'];
    }
    return 'canceled';
  }

  private normalizeChannelStatus(status: string): ChannelHealthRow['status'] {
    const normalized = status.toLowerCase();
    if (['connected', 'active'].includes(normalized)) return 'healthy';
    if (['warning', 'token_warning', 'degraded'].includes(normalized)) return 'warning';
    return 'critical';
  }

  private formatProvider(type: string) {
    const labels: Record<string, string> = {
      whatsapp: 'WhatsApp',
      messenger: 'Messenger',
      instagram: 'Instagram',
      email: 'Email',
      sms: 'SMS',
      webchat: 'Webchat',
    };

    return labels[type.toLowerCase()] ?? type;
  }

  private estimateUsageLimit(metric: string) {
    const normalized = metric.toLowerCase();
    if (normalized.includes('message')) return 250000;
    if (normalized.includes('ai')) return 50000;
    if (normalized.includes('storage')) return 100000;
    if (normalized.includes('contact')) return 100000;
    if (normalized.includes('broadcast')) return 50000;
    return 100000;
  }

  private readMetadataString(metadata: unknown, key: string) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }

  private formatDateTime(value?: Date | string | null) {
    if (!value) return 'Never';

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Never';

    return date.toISOString();
  }

  private formatNumber(value: number) {
    return Intl.NumberFormat('en', { notation: 'compact' }).format(value);
  }
}
