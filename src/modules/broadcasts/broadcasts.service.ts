import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageProcessingQueueService } from '../outbound/message-processing-queue.service';
import { normalizeContactIdentifierForChannel } from '../../common/utils/contact-identifier.util';

export type BroadcastAudienceFilters = {
  tagIds?: string[];
  lifecycleId?: string;
  /** Default true: skip contacts with marketingOptOut */
  respectMarketingOptOut?: boolean;
  commerce?: CommerceAudienceFilters;
};

export type CommerceAudienceFilters = {
  abandonedCart?: {
    olderThanMinutes?: number;
    minTotalAmount?: number;
    productExternalIds?: string[];
  };
  purchased?: {
    since?: string;
    minTotalAmount?: number;
    productExternalIds?: string[];
    statuses?: string[];
  };
};

type AudienceContactSnapshot = {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
};

type AudienceContactChannel = {
  id: string;
  workspaceId: string;
  contactId: string;
  channelId: string;
  channelType: string;
  identifier: string;
  createdAt: Date;
  contact: AudienceContactSnapshot;
};

type BroadcastRecipientForQueue = Prisma.BroadcastRecipientGetPayload<{
  include: {
    contact: {
      select: {
        id: true;
        firstName: true;
        lastName: true;
        phone: true;
        email: true;
      };
    };
    contactChannel: true;
    emailUnsubscribeTokens: true;
  };
}>;

type RecipientDisplayTarget = {
  identifier: string | null;
  contact: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
  };
};

const MAX_BROADCAST_BATCH = 500;
const DUPLICATE_SEND_WINDOW_MS = 30_000;
type BroadcastChannelCapability = {
  supported: true;
  messageMode: 'approved_template' | 'text';
  complianceNote?: string;
};

const BROADCAST_CHANNEL_METADATA = {
  whatsapp: {
    broadcast: {
      supported: true,
      messageMode: 'approved_template',
      complianceNote:
        'Only opted-in users with a WhatsApp identifier on this channel receive the template. Marketing opt-outs are excluded when respectMarketingOptOut is enabled.',
    },
  },
  email: {
    broadcast: {
      supported: true,
      messageMode: 'text',
    },
  },
} satisfies Record<string, { broadcast: BroadcastChannelCapability }>;
type BroadcastChannelType = keyof typeof BROADCAST_CHANNEL_METADATA;
type BroadcastTraceStatusFilter = 'all' | 'sent' | 'delivered' | 'read' | 'attention';
type BroadcastTraceOptions = {
  status?: string;
  page?: number;
  take?: number;
};
type NormalisedBroadcastTraceOptions = {
  status: BroadcastTraceStatusFilter;
  page: number;
  take: number;
  skip: number;
};

const BROADCAST_TRACE_STATUS_FILTERS = new Set<BroadcastTraceStatusFilter>([
  'all',
  'sent',
  'delivered',
  'read',
  'attention',
]);
const BROADCAST_ATTENTION_STATUSES = ['failed', 'bounced', 'dead_letter', 'unsubscribed'];

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
    const commerceWhere = this.commerceContactWhereFromFilters(filters.commerce);
    return {
      workspaceId,
      ...(respectOptOut ? { marketingOptOut: false } : {}),
      ...(filters.lifecycleId ? { lifecycleId: filters.lifecycleId } : {}),
      ...(filters.tagIds?.length
        ? { tags: { some: { tagId: { in: filters.tagIds } } } }
        : {}),
      ...commerceWhere,
    };
  }

  private commerceContactWhereFromFilters(
    filters?: CommerceAudienceFilters,
  ): Prisma.ContactWhereInput {
    if (!filters) return {};
    const clauses: Prisma.ContactWhereInput[] = [];

    if (filters.abandonedCart) {
      const olderThanMinutes = Math.max(0, filters.abandonedCart.olderThanMinutes ?? 0);
      clauses.push({
        commerceCarts: {
          some: {
            status: 'abandoned',
            abandonedAt: olderThanMinutes
              ? { lte: new Date(Date.now() - olderThanMinutes * 60_000) }
              : { not: null },
            ...(filters.abandonedCart.minTotalAmount != null
              ? { totalAmount: { gte: filters.abandonedCart.minTotalAmount } }
              : {}),
            ...(filters.abandonedCart.productExternalIds?.length
              ? {
                  lineItems: {
                    some: {
                      externalProductId: { in: filters.abandonedCart.productExternalIds },
                    },
                  },
                }
              : {}),
          },
        },
      });
    }

    if (filters.purchased) {
      clauses.push({
        commerceOrders: {
          some: {
            status: {
              in: filters.purchased.statuses?.length
                ? filters.purchased.statuses
                : ['paid', 'fulfilled'],
            },
            ...(filters.purchased.since
              ? { placedAt: { gte: new Date(filters.purchased.since) } }
              : {}),
            ...(filters.purchased.minTotalAmount != null
              ? { totalAmount: { gte: filters.purchased.minTotalAmount } }
              : {}),
            ...(filters.purchased.productExternalIds?.length
              ? {
                  lineItems: {
                    some: {
                      externalProductId: { in: filters.purchased.productExternalIds },
                    },
                  },
                }
              : {}),
          },
        },
      });
    }

    return clauses.length ? { AND: clauses } : {};
  }

  private normaliseAudienceFilters(
    filters: BroadcastAudienceFilters,
  ): Prisma.InputJsonObject {
    return {
      tagIds: [...(filters.tagIds ?? [])].sort(),
      lifecycleId: filters.lifecycleId ?? null,
      respectMarketingOptOut: filters.respectMarketingOptOut !== false,
      commerce: filters.commerce
        ? (JSON.parse(JSON.stringify(filters.commerce)) as Prisma.InputJsonValue)
        : null,
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

  private getChannelBroadcastCapability(
    channel: { type: string },
  ): BroadcastChannelCapability | null {
    const metadata =
      BROADCAST_CHANNEL_METADATA[channel.type as BroadcastChannelType];
    return metadata?.broadcast ?? null;
  }

  private assertChannelSupportsBroadcast(
    channel: { type: string },
  ): BroadcastChannelCapability {
    const capability = this.getChannelBroadcastCapability(channel);
    if (capability?.supported) return capability;
    throw new BadRequestException(
      'Broadcasts are available for WhatsApp and Email only. Website Chat, Instagram, and Messenger are conversation channels and cannot be used for broadcasts.',
    );
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

  private normaliseTraceOptions(opts: BroadcastTraceOptions = {}): NormalisedBroadcastTraceOptions {
    const rawStatus = (opts.status ?? 'all').trim().toLowerCase();
    if (!BROADCAST_TRACE_STATUS_FILTERS.has(rawStatus as BroadcastTraceStatusFilter)) {
      throw new BadRequestException('Unknown broadcast recipient status filter');
    }

    const take = Math.min(Math.max(1, opts.take ?? 20), 100);
    const page = Math.max(1, opts.page ?? 1);
    return {
      status: rawStatus as BroadcastTraceStatusFilter,
      page,
      take,
      skip: (page - 1) * take,
    };
  }

  private traceRecipientWhere(
    workspaceId: string,
    id: string,
    status: BroadcastTraceStatusFilter,
  ): Prisma.BroadcastRecipientWhereInput {
    const where: Prisma.BroadcastRecipientWhereInput = { workspaceId, broadcastRunId: id };
    if (status === 'all') return where;

    const statuses =
      status === 'sent'
        ? ['sent', 'delivered', 'read']
        : status === 'delivered'
          ? ['delivered', 'read']
          : status === 'read'
            ? ['read']
            : BROADCAST_ATTENTION_STATUSES;

    if (status === 'attention') {
      return {
        ...where,
        OR: [
          { status: { in: statuses } },
          { lastError: { not: null } },
          {
            message: {
              is: {
                status: { in: statuses },
              },
            },
          },
          {
            message: {
              is: {
                outboundQueue: {
                  is: {
                    lastError: { not: null },
                  },
                },
              },
            },
          },
        ],
      };
    }

    return {
      ...where,
      OR: [
        { status: { in: statuses } },
        {
          message: {
            is: {
              status: { in: statuses },
            },
          },
        },
      ],
    };
  }

  private traceMessageWhere(
    workspaceId: string,
    id: string,
    status: BroadcastTraceStatusFilter,
  ): Prisma.MessageWhereInput {
    const where: Prisma.MessageWhereInput = { workspaceId, broadcastRunId: id };
    if (status === 'all') return where;

    const statuses =
      status === 'sent'
        ? ['sent', 'delivered', 'read']
        : status === 'delivered'
          ? ['delivered', 'read']
          : status === 'read'
            ? ['read']
            : BROADCAST_ATTENTION_STATUSES;

    if (status === 'attention') {
      return {
        ...where,
        OR: [
          { status: { in: statuses } },
          {
            outboundQueue: {
              is: {
                lastError: { not: null },
              },
            },
          },
        ],
      };
    }

    return { ...where, status: { in: statuses } };
  }

  private getBroadcastContactField(channelType: string): 'email' | 'phone' | null {
    if (channelType === 'email') return 'email';
    if (channelType === 'whatsapp') return 'phone';
    return null;
  }

  private contactFieldWhere(field: 'email' | 'phone'): Prisma.ContactWhereInput {
    return field === 'email'
      ? { AND: [{ email: { not: null } }, { email: { not: '' } }] }
      : { AND: [{ phone: { not: null } }, { phone: { not: '' } }] };
  }

  private contactFieldAudienceWhere(
    workspaceId: string,
    channel: { id: string; type: string },
    filters: BroadcastAudienceFilters,
  ): Prisma.ContactWhereInput {
    const field = this.getBroadcastContactField(channel.type);
    if (!field) return this.contactWhereFromFilters(workspaceId, filters);

    return {
      AND: [
        this.contactWhereFromFilters(workspaceId, filters),
        {
          OR: [
            this.contactFieldWhere(field),
            {
              contactChannels: {
                some: {
                  workspaceId,
                  channelId: channel.id,
                  identifier: { not: '' },
                },
              },
            },
          ],
        },
      ],
    };
  }

  private contactFieldValue(
    contact: AudienceContactSnapshot,
    channelType: string,
  ): string | null | undefined {
    const field = this.getBroadcastContactField(channelType);
    return field ? contact[field] : null;
  }

  private normaliseAudienceIdentifier(
    channelType: string,
    value: string | null | undefined,
  ) {
    return normalizeContactIdentifierForChannel(channelType, value);
  }

  private toAudienceContactChannel(
    contactChannel: Pick<
      AudienceContactChannel,
      'id' | 'workspaceId' | 'contactId' | 'channelId' | 'channelType' | 'identifier' | 'createdAt'
    >,
    contact: AudienceContactSnapshot,
  ): AudienceContactChannel {
    return {
      id: contactChannel.id,
      workspaceId: contactChannel.workspaceId,
      contactId: contact.id,
      channelId: contactChannel.channelId,
      channelType: contactChannel.channelType,
      identifier: contactChannel.identifier,
      createdAt: contactChannel.createdAt,
      contact,
    };
  }

  private async ensureAudienceContactChannel(opts: {
    workspaceId: string;
    channel: { id: string; type: string };
    contact: AudienceContactSnapshot;
  }): Promise<AudienceContactChannel | null> {
    const identifier = this.normaliseAudienceIdentifier(
      opts.channel.type,
      this.contactFieldValue(opts.contact, opts.channel.type),
    );
    if (!identifier) return null;

    const existing = await this.prisma.contactChannel.findFirst({
      where: {
        workspaceId: opts.workspaceId,
        channelId: opts.channel.id,
        identifier,
      },
      include: {
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
    });

    if (existing) {
      return this.toAudienceContactChannel(existing, opts.contact);
    }

    const displayName = [opts.contact.firstName, opts.contact.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    try {
      return await this.prisma.contactChannel.create({
        data: {
          workspaceId: opts.workspaceId,
          contactId: opts.contact.id,
          channelId: opts.channel.id,
          channelType: opts.channel.type,
          identifier,
          displayName: displayName || null,
        },
        include: {
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
      });
    } catch (err: unknown) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }

      const raced = await this.prisma.contactChannel.findFirst({
        where: {
          workspaceId: opts.workspaceId,
          channelId: opts.channel.id,
          identifier,
        },
        include: {
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
      });
      return raced ? this.toAudienceContactChannel(raced, opts.contact) : null;
    }
  }

  private async snapshotContactFieldAudience(opts: {
    workspaceId: string;
    channel: { id: string; type: string };
    filters: BroadcastAudienceFilters;
    take: number;
  }): Promise<AudienceContactChannel[]> {
    const contacts = await this.prisma.contact.findMany({
      where: this.contactFieldAudienceWhere(opts.workspaceId, opts.channel, opts.filters),
      select: {
        id: true,
        workspaceId: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        contactChannels: {
          where: {
            workspaceId: opts.workspaceId,
            channelId: opts.channel.id,
            identifier: { not: '' },
          },
          select: {
            id: true,
            workspaceId: true,
            contactId: true,
            channelId: true,
            channelType: true,
            identifier: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      take: opts.take,
      orderBy: { createdAt: 'desc' },
    });

    const audience: AudienceContactChannel[] = [];
    for (const contact of contacts) {
      const existing = contact.contactChannels[0];
      const contactSnapshot = {
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        phone: contact.phone,
        email: contact.email,
      };
      if (existing) {
        audience.push(this.toAudienceContactChannel(existing, contactSnapshot));
        continue;
      }

      const created = await this.ensureAudienceContactChannel({
        workspaceId: opts.workspaceId,
        channel: opts.channel,
        contact: contactSnapshot,
      });
      if (created) {
        audience.push(created);
      }
    }

    return audience;
  }

  private async snapshotAudience(opts: {
    workspaceId: string;
    channel: { id: string; type: string };
    filters: BroadcastAudienceFilters;
    take: number;
  }): Promise<AudienceContactChannel[]> {
    if (this.getBroadcastContactField(opts.channel.type)) {
      return this.snapshotContactFieldAudience({
        workspaceId: opts.workspaceId,
        channel: opts.channel,
        filters: opts.filters,
        take: opts.take,
      });
    }

    const contactWhere = this.contactWhereFromFilters(opts.workspaceId, opts.filters);
    return this.prisma.contactChannel.findMany({
      where: {
        workspaceId: opts.workspaceId,
        channelId: opts.channel.id,
        contact: contactWhere,
      },
      include: {
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
      take: opts.take,
      orderBy: { createdAt: 'desc' },
    });
  }

  private displayName(cc: RecipientDisplayTarget): string {
    const contact = cc.contact;
    return (
      [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
      contact.phone ||
      contact.email ||
      cc.identifier ||
      'Unknown recipient'
    );
  }

  private async resolveTemplateSnapshot(opts: {
    workspaceId: string;
    channelId: string;
    channelType: string;
    template?: { name: string; language: string; variables?: Record<string, string> };
  }): Promise<Prisma.InputJsonObject | null> {
    if (!opts.template?.name) return null;

    const capturedAt = new Date().toISOString();
    if (opts.channelType !== 'whatsapp') {
      return {
        provider: opts.channelType,
        name: opts.template.name,
        language: opts.template.language ?? null,
        variables: opts.template.variables ?? {},
        capturedAt,
      };
    }

    const template = await this.prisma.whatsAppTemplate.findFirst({
      where: {
        workspaceId: opts.workspaceId,
        channelId: opts.channelId,
        name: opts.template.name,
        language: opts.template.language,
        status: 'APPROVED',
      },
    });

    if (!template) {
      throw new BadRequestException(
        `Template "${opts.template.name}" (${opts.template.language}) not found or not approved`,
      );
    }

    return {
      provider: 'whatsapp',
      id: template.id,
      metaId: template.metaId,
      name: template.name,
      language: template.language,
      category: template.category,
      status: template.status,
      variables: template.variables as Prisma.InputJsonValue,
      components: template.components as Prisma.InputJsonValue,
      syncedAt: template.syncedAt?.toISOString() ?? null,
      capturedAt,
    };
  }

  private buildDedupeKey(opts: {
    channelId: string;
    filters: Prisma.InputJsonObject;
    text?: string;
    template?: { name: string; language: string; variables?: Record<string, string> };
  }) {
    const payload = {
      channelId: opts.channelId,
      filters: opts.filters,
      text: opts.text?.trim() || null,
      template: opts.template
        ? {
            name: opts.template.name,
            language: opts.template.language,
            variables: this.sortObject(opts.template.variables ?? {}),
          }
        : null,
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private sortObject(value: Record<string, unknown>): Record<string, unknown> {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const item = value[key];
        acc[key] =
          item && typeof item === 'object' && !Array.isArray(item)
            ? this.sortObject(item as Record<string, unknown>)
            : item;
        return acc;
      }, {});
  }

  private async assertNoDuplicateSend(opts: {
    workspaceId: string;
    channelId: string;
    dedupeKey: string;
  }) {
    const duplicate = await this.prisma.broadcastRun.findFirst({
      where: {
        workspaceId: opts.workspaceId,
        channelId: opts.channelId,
        dedupeKey: opts.dedupeKey,
        createdAt: {
          gte: new Date(Date.now() - DUPLICATE_SEND_WINDOW_MS),
        },
      },
      select: { id: true, name: true, createdAt: true },
    });

    if (duplicate) {
      throw new BadRequestException(
        `This broadcast payload was already submitted seconds ago as "${duplicate.name}". Wait briefly or change the audience/content before sending again.`,
      );
    }
  }

  private async createRecipientSnapshotRows(opts: {
    workspaceId: string;
    runId: string;
    channelId: string;
    recipients: AudienceContactChannel[];
    text?: string;
    templateSnapshot: Prisma.InputJsonObject | null;
  }) {
    if (!opts.recipients.length) return;

    const snapshotAt = new Date().toISOString();
    await this.prisma.broadcastRecipient.createMany({
      data: opts.recipients.map((cc) => ({
        workspaceId: opts.workspaceId,
        broadcastRunId: opts.runId,
        channelId: opts.channelId,
        contactId: cc.contactId,
        contactChannelId: cc.id,
        identifier: cc.identifier,
        recipientName: this.displayName(cc),
        status: 'pending',
        idempotencyKey: `${opts.runId}:${cc.id}`,
        renderedText: opts.text?.trim() || null,
        ...(opts.templateSnapshot ? { templateSnapshot: opts.templateSnapshot } : {}),
        metadata: {
          source: 'broadcast',
          audienceSnapshotAt: snapshotAt,
          contactChannelId: cc.id,
        },
      })),
      skipDuplicates: true,
    });
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
    this.assertChannelSupportsBroadcast(channel);

    const take = Math.min(Math.max(1, limit), 2000);
    const contactWhere = this.contactWhereFromFilters(workspaceId, filters);

    if (this.getBroadcastContactField(channel.type)) {
      const contactFieldWhere = this.contactFieldAudienceWhere(workspaceId, channel, filters);
      const total = await this.prisma.contact.count({ where: contactFieldWhere });
      const sampleContacts = await this.prisma.contact.findMany({
        where: contactFieldWhere,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          contactChannels: {
            where: {
              workspaceId,
              channelId,
              identifier: { not: '' },
            },
            select: { identifier: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });

      const sample = sampleContacts
        .map((contact) => {
          const identifier = this.normaliseAudienceIdentifier(
            channel.type,
            contact.contactChannels[0]?.identifier ??
              this.contactFieldValue(contact, channel.type),
          );
          if (!identifier) return null;

          return {
            contactId: contact.id,
            identifier,
            name: this.displayName({ identifier, contact }),
          };
        })
        .filter(
          (
            row,
          ): row is {
            contactId: string;
            identifier: string;
            name: string;
          } => Boolean(row),
        );

      return {
        channelId,
        channelType: channel.type,
        totalMatching: total,
        previewLimit: take,
        previewCount: sample.length,
        sample,
      };
    }

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
        contact: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
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
        name: this.displayName(cc),
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

    const rows = await this.prisma.broadcastRecipient.groupBy({
      by: ['status'],
      where: { workspaceId, broadcastRunId: id },
      _count: { _all: true },
    });

    if (!rows.length) {
      return this.getLegacyRunAnalytics(workspaceId, id);
    }

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const c = r._count._all;
      byStatus[r.status] = c;
      total += c;
    }

    return {
      broadcastRunId: id,
      totalRecipients: total,
      totalMessages: total,
      byStatus,
      queueNote:
        'Recipient rows move through pending, queued, sending, sent, delivered, read, failed, bounced, unsubscribed, and dead_letter as queues and provider webhooks reconcile.',
    };
  }

  private async getLegacyRunAnalytics(workspaceId: string, id: string) {
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
        'Legacy run: analytics are based on Message rows because this run predates BroadcastRecipient snapshots.',
    };
  }

  async getRunTrace(workspaceId: string, id: string, opts: BroadcastTraceOptions = {}) {
    await this.getRun(workspaceId, id);
    const traceOpts = this.normaliseTraceOptions(opts);
    const where = this.traceRecipientWhere(workspaceId, id, traceOpts.status);

    const total = await this.prisma.broadcastRecipient.count({
      where: { workspaceId, broadcastRunId: id },
    });

    if (!total) {
      return this.getLegacyRunTrace(workspaceId, id, traceOpts);
    }

    const [filteredTotal, recipients] = await Promise.all([
      this.prisma.broadcastRecipient.count({ where }),
      this.prisma.broadcastRecipient.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: traceOpts.skip,
        take: traceOpts.take,
        include: {
          contact: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
            },
          },
          message: {
            select: {
              id: true,
              status: true,
              text: true,
              channelMsgId: true,
              createdAt: true,
              sentAt: true,
              metadata: true,
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
          },
        },
      }),
    ]);

    return {
      broadcastRunId: id,
      limit: traceOpts.take,
      page: traceOpts.page,
      total,
      filteredTotal,
      totalPages: Math.max(1, Math.ceil(filteredTotal / traceOpts.take)),
      status: traceOpts.status,
      rows: recipients.map((recipient) => ({
        recipientId: recipient.id,
        messageId: recipient.message?.id ?? null,
        conversationId: recipient.conversationId,
        contactId: recipient.contactId,
        recipient: this.displayName(recipient),
        identifier: recipient.identifier,
        messageStatus: recipient.message?.status ?? recipient.status,
        queueStatus: recipient.status,
        attempts: recipient.attempts || recipient.message?.outboundQueue?.attempts || 0,
        maxRetries: recipient.maxRetries || recipient.message?.outboundQueue?.maxRetries || 0,
        lastError:
          recipient.lastError ??
          recipient.message?.outboundQueue?.lastError ??
          ((recipient.message?.metadata as Record<string, unknown> | null)?.error as string | null) ??
          null,
        channelMsgId: recipient.providerMessageId ?? recipient.message?.channelMsgId ?? null,
        createdAt: recipient.createdAt,
        scheduledAt: recipient.message?.outboundQueue?.scheduledAt ?? null,
        sentAt: recipient.sentAt ?? recipient.message?.sentAt ?? recipient.message?.outboundQueue?.sentAt ?? null,
        deliveredAt: recipient.deliveredAt,
        readAt: recipient.readAt,
        preview:
          recipient.renderedText?.slice(0, 140) ??
          recipient.message?.text?.slice(0, 140) ??
          null,
      })),
    };
  }

  private async getLegacyRunTrace(
    workspaceId: string,
    id: string,
    opts: NormalisedBroadcastTraceOptions,
  ) {
    const where = this.traceMessageWhere(workspaceId, id, opts.status);
    const [total, filteredTotal, messages] = await Promise.all([
      this.prisma.message.count({ where: { workspaceId, broadcastRunId: id } }),
      this.prisma.message.count({ where }),
      this.prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
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
      }),
    ]);

    return {
      broadcastRunId: id,
      limit: opts.take,
      page: opts.page,
      total,
      filteredTotal,
      totalPages: Math.max(1, Math.ceil(filteredTotal / opts.take)),
      status: opts.status,
      rows: messages.map((message) => {
        const contact = message.conversation?.contact;
        const metadata = (message.metadata ?? {}) as Record<string, unknown>;
        return {
          messageId: message.id,
          conversationId: message.conversation?.id ?? null,
          contactId: contact?.id ?? null,
          recipient:
            [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') ||
            contact?.phone ||
            contact?.email ||
            (metadata.contactIdentifier as string | undefined) ||
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

    const data: Prisma.BroadcastRunUpdateInput = {};
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
      data,
    });
    return this.getRun(opts.workspaceId, opts.id);
  }

  async sendScheduledNow(workspaceId: string, id: string) {
    const run = await this.getRun(workspaceId, id);
    this.assertEditableScheduledRun(run);
    this.assertChannelSupportsBroadcast(run.channel);

    const claimed = await this.prisma.broadcastRun.updateMany({
      where: { id, workspaceId, status: 'scheduled' },
      data: { status: 'running', startedAt: new Date(), scheduledAt: new Date() },
    });
    if (!claimed.count) {
      throw new BadRequestException('Broadcast is already running or no longer scheduled');
    }

    await this.enqueueRun(workspaceId, id);
    return this.getRun(workspaceId, id);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduledBroadcasts() {
    const dueRuns = await this.prisma.broadcastRun.findMany({
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
          data: { status: 'running', startedAt: new Date() },
        });
        if (!claimed.count) continue;
        await this.enqueueRun(run.workspaceId, run.id);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Scheduled broadcast failed run=${run.id}: ${message}`);
        await this.prisma.broadcastRun.update({
          where: { id: run.id },
          data: { status: 'partial_failure', completedAt: new Date() },
        });
      }
    }
  }

  private async enqueueRun(workspaceId: string, runId: string) {
    const run = await this.prisma.broadcastRun.findFirst({
      where: { id: runId, workspaceId },
      include: { channel: true },
    });
    if (!run) throw new NotFoundException('Broadcast run not found');
    this.assertChannelSupportsBroadcast(run.channel);

    const recipients = await this.prisma.broadcastRecipient.findMany({
      where: {
        workspaceId,
        broadcastRunId: runId,
        status: 'pending',
      },
      include: {
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
          },
        },
        contactChannel: true,
        emailUnsubscribeTokens: {
          where: { status: 'active' },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(1, run.totalAudience || 1), MAX_BROADCAST_BATCH),
    });

    let queued = 0;
    let failed = 0;

    for (const recipient of recipients) {
      try {
        const conversation =
          (await this.prisma.conversation.findFirst({
            where: { workspaceId, contactId: recipient.contactId },
            orderBy: { updatedAt: 'desc' },
          })) ||
          (await this.prisma.conversation.create({
            data: {
              workspaceId,
              contactId: recipient.contactId,
            },
          }));

        const metadata = await this.buildRecipientQueueMetadata(run, recipient);

        await this.processingQueue.enqueueSendMessage({
          workspaceId,
          conversationId: conversation.id,
          channelId: run.channelId,
          authorId: run.createdById ?? undefined,
          text: run.messageText?.trim() || undefined,
          broadcastRunId: run.id,
          broadcastRecipientId: recipient.id,
          idempotencyKey: recipient.idempotencyKey,
          metadata,
        });

        await this.prisma.broadcastRecipient.updateMany({
          where: { id: recipient.id, workspaceId },
          data: {
            status: 'queued',
            conversationId: conversation.id,
            queuedAt: new Date(),
            lastError: null,
          },
        });
        queued++;
      } catch (err: unknown) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.broadcastRecipient.updateMany({
          where: { id: recipient.id, workspaceId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            lastError: message,
          },
        });
      }
    }

    const status = failed > 0 ? 'partial_failure' : 'completed';

    await this.prisma.broadcastRun.update({
      where: { id: run.id },
      data: {
        queuedCount: { increment: queued },
        failedEnqueue: { increment: failed },
        status,
        completedAt: new Date(),
      },
    });

    return { queued, failed, totalAudience: run.totalAudience, status };
  }

  private async buildRecipientQueueMetadata(
    run: Prisma.BroadcastRunGetPayload<{ include: { channel: true } }>,
    recipient: BroadcastRecipientForQueue,
  ): Promise<Record<string, unknown>> {
    const metadata: Record<string, unknown> = {
      source: 'broadcast',
      broadcastRecipientId: recipient.id,
      idempotencyKey: recipient.idempotencyKey,
      contactChannelId: recipient.contactChannelId,
      audienceSnapshotStrategy: run.audienceSnapshotStrategy,
    };

    if (run.templateName && run.templateLanguage) {
      const snapshot = (recipient.templateSnapshot ??
        run.templateSnapshot ??
        {}) as Record<string, unknown>;
      metadata.template = {
        id: snapshot.id,
        metaId: snapshot.metaId,
        name: run.templateName,
        language: run.templateLanguage,
        variables: (run.templateVariables as Record<string, string> | null) ?? {},
        components: snapshot.components,
        snapshotCapturedAt: snapshot.capturedAt,
      };
    }

    if (run.channel.type === 'email') {
      const unsubscribe = await this.ensureEmailUnsubscribeToken(run, recipient);
      if (unsubscribe) {
        metadata.emailUnsubscribe = unsubscribe;
      }
    }

    return metadata;
  }

  private async ensureEmailUnsubscribeToken(
    run: Prisma.BroadcastRunGetPayload<{ include: { channel: true } }>,
    recipient: BroadcastRecipientForQueue,
  ) {
    const email = recipient.contact.email ?? recipient.identifier;
    if (!email?.includes('@')) return null;

    const existing = recipient.emailUnsubscribeTokens.find(
      (token) => token.status === 'active',
    );

    const token =
      existing ??
      (await this.prisma.emailUnsubscribeToken.create({
        data: {
          workspaceId: run.workspaceId,
          contactId: recipient.contactId,
          contactChannelId: recipient.contactChannelId,
          broadcastRunId: run.id,
          broadcastRecipientId: recipient.id,
          email,
          token: this.generateUnsubscribeToken(),
          status: 'active',
          source: 'broadcast',
        },
      }));

    return {
      token: token.token,
      url: this.unsubscribeUrl(token.token),
    };
  }

  private generateUnsubscribeToken() {
    return randomBytes(32).toString('base64url');
  }

  private unsubscribeUrl(token: string) {
    const base =
      process.env.PUBLIC_API_URL ||
      process.env.API_PUBLIC_URL ||
      process.env.BACKEND_PUBLIC_URL ||
      process.env.APP_URL ||
      process.env.PUBLIC_APP_URL ||
      'http://localhost:3000';
    return `${base.replace(/\/+$/, '')}/api/broadcasts/unsubscribe/${token}`;
  }

  async unsubscribeEmailToken(token: string) {
    if (!/^[A-Za-z0-9_-]{24,160}$/.test(token)) {
      throw new NotFoundException('Unsubscribe token not found');
    }

    const row = await this.prisma.emailUnsubscribeToken.findUnique({
      where: { token },
    });
    if (!row) throw new NotFoundException('Unsubscribe token not found');

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.contact.update({
        where: { id: row.contactId },
        data: { marketingOptOut: true },
      }),
      this.prisma.emailUnsubscribeToken.update({
        where: { id: row.id },
        data: { status: 'used', usedAt: now },
      }),
      ...(row.broadcastRecipientId
        ? [
            this.prisma.broadcastRecipient.updateMany({
              where: {
                id: row.broadcastRecipientId,
                workspaceId: row.workspaceId,
              },
              data: { status: 'unsubscribed', unsubscribedAt: now },
            }),
          ]
        : []),
    ]);

    return {
      success: true,
      status: 'unsubscribed',
    };
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
    const broadcastCapability = this.assertChannelSupportsBroadcast(channel);

    if (broadcastCapability.messageMode === 'approved_template') {
      if (!template?.name || !template?.language) {
        throw new BadRequestException(
          'WhatsApp broadcasts must use an approved template (name + language). Free-form text is not delivered outside the customer care window.',
        );
      }
    } else if (!text?.trim() && !template?.name) {
      throw new BadRequestException('Provide message text or a template');
    }

    const take = Math.min(Math.max(1, limit), MAX_BROADCAST_BATCH);
    const scheduledAt = this.parseScheduledAt(scheduledAtRaw);
    const shouldSchedule = this.isFutureSchedule(scheduledAt);
    const audienceFilters = this.normaliseAudienceFilters(filters);
    const dedupeKey = this.buildDedupeKey({
      channelId,
      filters: audienceFilters,
      text,
      template,
    });
    await this.assertNoDuplicateSend({ workspaceId, channelId, dedupeKey });

    const [contactChannels, templateSnapshot] = await Promise.all([
      this.snapshotAudience({
        workspaceId,
        channel,
        filters,
        take,
      }),
      this.resolveTemplateSnapshot({
        workspaceId,
        channelId,
        channelType: channel.type,
        template,
      }),
    ]);

    const hasAudience = contactChannels.length > 0;
    const run = await this.prisma.broadcastRun.create({
      data: {
        workspaceId,
        name: name.trim() || `Broadcast ${new Date().toISOString().slice(0, 16)}`,
        channelId,
        audienceFilters,
        audienceSnapshotStrategy: 'snapshot',
        dedupeKey,
        contentMode: template ? 'template' : 'text',
        templateName: template?.name ?? null,
        templateLanguage: template?.language ?? null,
        templateVariables: template?.variables ?? Prisma.JsonNull,
        templateSnapshot: templateSnapshot ?? Prisma.JsonNull,
        messageText: text?.trim() || null,
        textPreview: (text ?? '').slice(0, 500) || null,
        totalAudience: contactChannels.length,
        queuedCount: 0,
        failedEnqueue: 0,
        status: !hasAudience ? 'completed' : shouldSchedule ? 'scheduled' : 'running',
        scheduledAt,
        startedAt: !hasAudience || shouldSchedule ? null : new Date(),
        completedAt: hasAudience ? null : new Date(),
        createdById: authorId ?? null,
      },
    });

    await this.createRecipientSnapshotRows({
      workspaceId,
      runId: run.id,
      channelId,
      recipients: contactChannels,
      text,
      templateSnapshot,
    });

    if (!hasAudience) {
      return {
        broadcastRunId: run.id,
        totalAudience: 0,
        queued: 0,
        failed: 0,
        channelId,
        status: 'completed',
        audienceSnapshotStrategy: 'snapshot',
      };
    }

    if (shouldSchedule) {
      return {
        broadcastRunId: run.id,
        totalAudience: contactChannels.length,
        queued: 0,
        failed: 0,
        channelId,
        status: 'scheduled',
        scheduledAt: scheduledAt?.toISOString(),
        audienceSnapshotStrategy: 'snapshot',
        whatsAppComplianceNote: broadcastCapability.complianceNote,
      };
    }

    const result = await this.enqueueRun(workspaceId, run.id);
    return {
      broadcastRunId: run.id,
      totalAudience: contactChannels.length,
      queued: result.queued,
      failed: result.failed,
      channelId,
      status: result.status,
      audienceSnapshotStrategy: 'snapshot',
      whatsAppComplianceNote: broadcastCapability.complianceNote,
    };
  }
}
