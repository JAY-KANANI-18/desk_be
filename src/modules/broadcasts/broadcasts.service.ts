import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MessageProcessingQueueService } from '../outbound/message-processing-queue.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from '@prisma/client';

export type BroadcastAudienceFilters = {
  tagIds?: string[];
  lifecycleId?: string;
  /** Default true: skip contacts with marketingOptOut */
  respectMarketingOptOut?: boolean;
};

@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly processingQueue: MessageProcessingQueueService,
  ) {}

  private contactWhereFromFilters(
    workspaceId: string,
    filters: BroadcastAudienceFilters,
  ): Prisma.ContactWhereInput {
    const respectOptOut = filters.respectMarketingOptOut !== false;
    return {
      workspaceId,
      ...(respectOptOut ? { marketingOptOut: false } : {}),
      ...(filters.lifecycleId ? { lifecycleId: filters.lifecycleId } : {}),
      ...(filters.tagIds?.length
        ? { tags: { some: { tagId: { in: filters.tagIds } } } }
        : {}),
    };
  }

  private parseScheduledAt(raw?: string): Date | null {
    if (!raw?.trim()) return null;
    const scheduledAt = new Date(raw);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('scheduledAt must be a valid date');
    }
    return scheduledAt;
  }

  private isFutureSchedule(scheduledAt: Date | null) {
    return !!scheduledAt && scheduledAt.getTime() > Date.now() + 30_000;
  }

  private assertEditableScheduledRun(run: { status: string }) {
    if (run.status !== 'scheduled') {
      throw new BadRequestException(
        'Only scheduled broadcasts can be edited, rescheduled, or sent now. Running and completed broadcasts are locked for audit safety.',
      );
    }
  }

  private listRunsWhere(opts: {
    workspaceId: string;
    search?: string;
    status?: string;
  }): Prisma.BroadcastRunWhereInput {
    const where: Prisma.BroadcastRunWhereInput = {
      workspaceId: opts.workspaceId,
    };

    if (opts.status?.trim()) {
      where.status = opts.status.trim();
    }

    if (opts.search?.trim()) {
      const q = opts.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { textPreview: { contains: q, mode: 'insensitive' } },
        { templateName: { contains: q, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private listRunsOrderBy(opts: {
    sortBy?: string;
    sortOrder?: string;
  }): Prisma.BroadcastRunOrderByWithRelationInput[] {
    const sortOrder: Prisma.SortOrder = opts.sortOrder === 'asc' ? 'asc' : 'desc';

    if (opts.sortBy === 'name') {
      return [{ name: sortOrder }, { id: sortOrder }];
    }

    if (opts.sortBy === 'status') {
      return [{ status: sortOrder }, { id: sortOrder }];
    }

    if (opts.sortBy === 'scheduledAt') {
      return [{ scheduledAt: sortOrder }, { id: sortOrder }];
    }

    return [{ createdAt: 'desc' }, { id: 'desc' }];
  }

  async listApprovedWhatsAppTemplates(workspaceId: string, channelId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== 'whatsapp') {
      throw new BadRequestException('Templates list applies to WhatsApp channels only');
    }
    return this.prisma.whatsAppTemplate.findMany({
      where: { workspaceId, channelId, status: 'APPROVED' },
      orderBy: [{ name: 'asc' }, { language: 'asc' }],
    });
  }

  async previewAudience(opts: {
    workspaceId: string;
    channelId: string;
    filters: BroadcastAudienceFilters;
    limit?: number;
  }) {
    const { workspaceId, channelId, filters, limit = 200 } = opts;
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const take = Math.min(Math.max(1, limit), 2000);

    const contactWhere = this.contactWhereFromFilters(workspaceId, filters);

    const total = await this.prisma.contactChannel.count({
      where: {
        workspaceId,
        channelId,
        contact: contactWhere,
      },
    });

    const sample = await this.prisma.contactChannel.findMany({
      where: {
        workspaceId,
        channelId,
        contact: contactWhere,
      },
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        contact: { select: { id: true, firstName: true, lastName: true, phone: true } },
      },
    });

    return {
      channelId,
      channelType: channel.type,
      totalMatching: total,
      previewLimit: take,
      previewCount: sample.length,
      sample: sample.map((cc) => ({
        contactId: cc.contactId,
        identifier: cc.identifier,
        name: [cc.contact.firstName, cc.contact.lastName].filter(Boolean).join(' ') || cc.contact.phone || '—',
      })),
    };
  }

  async listRuns(
    workspaceId: string,
    opts: {
      take?: number;
      cursor?: string;
      search?: string;
      status?: string;
      sortBy?: string;
      sortOrder?: string;
    } = {},
  ) {
    const take = Math.min(Math.max(1, opts.take ?? 50), 100);
    const where = this.listRunsWhere({
      workspaceId,
      search: opts.search,
      status: opts.status,
    });
    const orderBy = this.listRunsOrderBy({
      sortBy: opts.sortBy,
      sortOrder: opts.sortOrder,
    });

    const [total, rows] = await Promise.all([
      this.prisma.broadcastRun.count({ where }),
      this.prisma.broadcastRun.findMany({
        where,
        orderBy,
        take: take + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        include: {
          channel: { select: { id: true, name: true, type: true, identifier: true } },
        },
      }),
    ]);

    const hasMore = rows.length > take;
    const data = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : undefined;

    return { data, nextCursor, total };
  }

  async getRun(workspaceId: string, id: string) {
    const run = await this.prisma.broadcastRun.findFirst({
      where: { id, workspaceId },
      include: {
        channel: { select: { id: true, name: true, type: true, identifier: true } },
      },
    });
    if (!run) throw new NotFoundException('Broadcast run not found');
    return run;
  }

  async getRunAnalytics(workspaceId: string, id: string) {
    await this.getRun(workspaceId, id);

    const rows = await this.prisma.message.groupBy({
      by: ['status'],
      where: { workspaceId, broadcastRunId: id },
      _count: { _all: true },
    });

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const c = r._count._all;
      byStatus[r.status] = c;
      total += c;
    }

    return {
      broadcastRunId: id,
      totalMessages: total,
      byStatus,
      queueNote:
        'Messages move through pending → sent → delivered/read as providers confirm. Failed rows indicate enqueue or provider rejection.',
    };
  }

  async getRunTrace(workspaceId: string, id: string) {
    await this.getRun(workspaceId, id);

    const messages = await this.prisma.message.findMany({
      where: { workspaceId, broadcastRunId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        status: true,
        text: true,
        channelMsgId: true,
        createdAt: true,
        sentAt: true,
        metadata: true,
        conversation: {
          select: {
            id: true,
            contact: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phone: true,
                email: true,
              },
            },
          },
        },
        outboundQueue: {
          select: {
            id: true,
            status: true,
            attempts: true,
            maxRetries: true,
            lastError: true,
            scheduledAt: true,
            sentAt: true,
          },
        },
      },
    });

    return {
      broadcastRunId: id,
      limit: 200,
      rows: messages.map((message) => {
        const contact = message.conversation?.contact;
        const metadata = (message.metadata ?? {}) as Record<string, any>;
        return {
          messageId: message.id,
          conversationId: message.conversation?.id ?? null,
          contactId: contact?.id ?? null,
          recipient:
            [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') ||
            contact?.phone ||
            contact?.email ||
            metadata.contactIdentifier ||
            'Unknown recipient',
          identifier: metadata.contactIdentifier ?? null,
          messageStatus: message.status,
          queueStatus: message.outboundQueue?.status ?? null,
          attempts: message.outboundQueue?.attempts ?? 0,
          maxRetries: message.outboundQueue?.maxRetries ?? 0,
          lastError: message.outboundQueue?.lastError ?? metadata.error ?? null,
          channelMsgId: message.channelMsgId,
          createdAt: message.createdAt,
          scheduledAt: message.outboundQueue?.scheduledAt ?? null,
          sentAt: message.sentAt ?? message.outboundQueue?.sentAt ?? null,
          preview: message.text?.slice(0, 140) ?? null,
        };
      }),
    };
  }

  async updateScheduledBroadcast(opts: {
    workspaceId: string;
    id: string;
    name?: string;
    scheduledAt?: string;
  }) {
    const run = await this.getRun(opts.workspaceId, opts.id);
    this.assertEditableScheduledRun(run);

    const data: Record<string, unknown> = {};
    if (opts.name !== undefined) {
      const name = opts.name.trim();
      if (!name) throw new BadRequestException('Broadcast name cannot be empty');
      data.name = name;
    }
    if (opts.scheduledAt !== undefined) {
      const scheduledAt = this.parseScheduledAt(opts.scheduledAt);
      if (!this.isFutureSchedule(scheduledAt)) {
        throw new BadRequestException('Schedule time must be at least 1 minute from now');
      }
      data.scheduledAt = scheduledAt;
    }
    if (!Object.keys(data).length) return run;

    await this.prisma.broadcastRun.update({
      where: { id: opts.id },
      data: data as any,
    });
    return this.getRun(opts.workspaceId, opts.id);
  }

  async sendScheduledNow(workspaceId: string, id: string) {
    const run = await this.getRun(workspaceId, id);
    this.assertEditableScheduledRun(run);

    const claimed = await this.prisma.broadcastRun.updateMany({
      where: { id, workspaceId, status: 'scheduled' },
      data: { status: 'running', startedAt: new Date(), scheduledAt: new Date() } as any,
    });
    if (!claimed.count) {
      throw new BadRequestException('Broadcast is already running or no longer scheduled');
    }

    await this.enqueueRun(workspaceId, id);
    return this.getRun(workspaceId, id);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduledBroadcasts() {
    const dueRuns = await (this.prisma.broadcastRun as any).findMany({
      where: {
        status: 'scheduled',
        scheduledAt: { lte: new Date() },
      },
      take: 10,
      orderBy: { scheduledAt: 'asc' },
    });

    for (const run of dueRuns) {
      try {
        const claimed = await this.prisma.broadcastRun.updateMany({
          where: { id: run.id, status: 'scheduled' },
          data: { status: 'running', startedAt: new Date() } as any,
        });
        if (!claimed.count) continue;
        await this.enqueueRun(run.workspaceId, run.id);
      } catch (err: any) {
        this.logger.error(`Scheduled broadcast failed run=${run.id}: ${err.message}`);
        await this.prisma.broadcastRun.update({
          where: { id: run.id },
          data: { status: 'partial_failure', completedAt: new Date() } as any,
        });
      }
    }
  }

  private async enqueueRun(workspaceId: string, runId: string) {
    const run = await (this.prisma.broadcastRun as any).findFirst({
      where: { id: runId, workspaceId },
      include: { channel: true },
    });
    if (!run) throw new NotFoundException('Broadcast run not found');

    const filters = run.audienceFilters as BroadcastAudienceFilters;
    const contactWhere = this.contactWhereFromFilters(workspaceId, filters);
    const contactChannels = await this.prisma.contactChannel.findMany({
      where: {
        workspaceId,
        channelId: run.channelId,
        contact: contactWhere,
      },
      include: { contact: true },
      take: Math.min(Math.max(1, run.totalAudience || 1), 500),
      orderBy: { createdAt: 'desc' },
    });

    let queued = 0;
    let failed = 0;
    const template =
      run.templateName && run.templateLanguage
        ? {
            name: run.templateName,
            language: run.templateLanguage,
            variables: (run.templateVariables as Record<string, string>) ?? {},
          }
        : undefined;
    const metadataBase: Record<string, unknown> = { source: 'broadcast' };
    if (template) metadataBase.template = template;

    for (const cc of contactChannels) {
      try {
        const conversation =
          (await this.prisma.conversation.findFirst({
            where: { workspaceId, contactId: cc.contactId },
            orderBy: { updatedAt: 'desc' },
          })) ||
          (await this.prisma.conversation.create({
            data: {
              workspaceId,
              contactId: cc.contactId,
              status: 'open',
            },
          }));

        await this.processingQueue.enqueueSendMessage({
          workspaceId,
          conversationId: conversation.id,
          channelId: run.channelId,
          authorId: run.createdById ?? undefined,
          text: run.messageText?.trim() || undefined,
          broadcastRunId: run.id,
          metadata: metadataBase as any,
        });
        queued++;
      } catch {
        failed++;
      }
    }

    const status = failed > 0 ? 'partial_failure' : 'completed';

    await this.prisma.broadcastRun.update({
      where: { id: run.id },
      data: {
        queuedCount: queued,
        failedEnqueue: failed,
        totalAudience: contactChannels.length,
        status,
        completedAt: new Date(),
      } as any,
    });

    return { queued, failed, totalAudience: contactChannels.length, status };
  }

  async sendBroadcast(opts: {
    workspaceId: string;
    name: string;
    channelId: string;
    authorId?: string;
    text?: string;
    template?: { name: string; language: string; variables?: Record<string, string> };
    filters: BroadcastAudienceFilters;
    limit?: number;
    scheduledAt?: string;
  }) {
    const {
      workspaceId,
      channelId,
      text,
      authorId,
      name,
      template,
      filters,
      limit = 200,
      scheduledAt: scheduledAtRaw,
    } = opts;

    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    if (channel.type === 'whatsapp') {
      if (!template?.name || !template?.language) {
        throw new BadRequestException(
          'WhatsApp broadcasts must use an approved template (name + language). Free-form text is not delivered outside the customer care window.',
        );
      }
    } else {
      if (!text?.trim() && !template?.name) {
        throw new BadRequestException('Provide message text or a template');
      }
    }

    const maxBatch = 500;
    const take = Math.min(Math.max(1, limit), maxBatch);
    const scheduledAt = this.parseScheduledAt(scheduledAtRaw);
    const shouldSchedule = this.isFutureSchedule(scheduledAt);

    const contactWhere = this.contactWhereFromFilters(workspaceId, filters);

    const contactChannels = await this.prisma.contactChannel.findMany({
      where: {
        workspaceId,
        channelId,
        contact: contactWhere,
      },
      include: { contact: true },
      take,
      orderBy: { createdAt: 'desc' },
    });

    const audienceFilters: Prisma.InputJsonValue = {
      tagIds: filters.tagIds ?? [],
      lifecycleId: filters.lifecycleId ?? null,
      respectMarketingOptOut: filters.respectMarketingOptOut !== false,
    };

    const run = await this.prisma.broadcastRun.create({
      data: {
        workspaceId,
        name: name.trim() || `Broadcast ${new Date().toISOString().slice(0, 16)}`,
        channelId,
        audienceFilters,
        contentMode: template ? 'template' : 'text',
        templateName: template?.name ?? null,
        templateLanguage: template?.language ?? null,
        templateVariables: (template?.variables ?? null) as any,
        messageText: text?.trim() || null,
        textPreview: (text ?? '').slice(0, 500) || null,
        totalAudience: contactChannels.length,
        queuedCount: 0,
        failedEnqueue: 0,
        status: shouldSchedule ? 'scheduled' : 'running',
        scheduledAt,
        startedAt: shouldSchedule ? null : new Date(),
        createdById: authorId ?? null,
      } as any,
    });

    if (shouldSchedule) {
      return {
        broadcastRunId: run.id,
        totalAudience: contactChannels.length,
        queued: 0,
        failed: 0,
        channelId,
        status: 'scheduled',
        scheduledAt: scheduledAt?.toISOString(),
        whatsAppComplianceNote:
          channel.type === 'whatsapp'
            ? 'Only opted-in users with a WhatsApp identifier on this channel receive the template. Marketing opt-outs are excluded when respectMarketingOptOut is enabled.'
            : undefined,
      };
    }

    let queued = 0;
    let failed = 0;

    const metadataBase: Record<string, unknown> = {
      source: 'broadcast',
    };
    if (template?.name) {
      metadataBase.template = {
        name: template.name,
        language: template.language,
        variables: template.variables ?? {},
      };
    }

    for (const cc of contactChannels) {
      try {
        const conversation =
          (await this.prisma.conversation.findFirst({
            where: { workspaceId, contactId: cc.contactId },
            orderBy: { updatedAt: 'desc' },
          })) ||
          (await this.prisma.conversation.create({
            data: {
              workspaceId,
              contactId: cc.contactId,
              status: 'open',
            },
          }));

        await this.processingQueue.enqueueSendMessage({
          workspaceId,
          conversationId: conversation.id,
          channelId,
          authorId,
          text: text?.trim() || undefined,
          broadcastRunId: run.id,
          metadata: metadataBase as any,
        });
        queued++;
      } catch {
        failed++;
      }
    }

    const status =
      failed > 0 && queued === 0
        ? 'partial_failure'
        : failed > 0
          ? 'partial_failure'
          : 'completed';

    await this.prisma.broadcastRun.update({
      where: { id: run.id },
      data: {
        queuedCount: queued,
        failedEnqueue: failed,
        status,
        completedAt: new Date(),
      } as any,
    });

    return {
      broadcastRunId: run.id,
      totalAudience: contactChannels.length,
      queued,
      failed,
      channelId,
      status,
      whatsAppComplianceNote:
        channel.type === 'whatsapp'
          ? 'Only opted-in users with a WhatsApp identifier on this channel receive the template. Marketing opt-outs are excluded when respectMarketingOptOut is enabled.'
          : undefined,
    };
  }
}
