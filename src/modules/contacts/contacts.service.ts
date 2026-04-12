import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AssignContactDto } from './dto/assign.dto';
import { RealtimeService } from 'src/realtime/realtime.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MergeContactsDto } from './dto/merge-contact.dto';
import { ActivityService } from '../activity/activity.service';

const CONTACT_INCLUDE = {
  tags: { include: { tag: true } },
  lifecycle: { select: { id: true, name: true, emoji: true } },
  assignee: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
  team: { select: { id: true, name: true } },
  contactChannels: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      channelId: true,
      channelType: true,
      identifier: true,
      displayName: true,
      avatarUrl: true,
      createdAt: true,
      updatedAt: true,
      lastMessageTime: true,
      lastIncomingMessageTime: true,
      lastCallInteractionTime: true,
      messageWindowExpiry: true,
      conversationWindowCategory: true,
      call_permission: true,
      hasPermanentCallPermission: true,
    },
  },
  mergedIntoContact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
    },
  },
} satisfies Prisma.ContactInclude;

type ContactWithDetails = Prisma.ContactGetPayload<{ include: typeof CONTACT_INCLUDE }>;

@Injectable()
export class ContactsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private events: EventEmitter2,
    private activity: ActivityService,
  ) {}

  private listContactsWhere(
    workspaceId: string,
    opts: { search?: string; lifecycle?: string },
  ): Prisma.ContactWhereInput {
    const where: Prisma.ContactWhereInput = {
      workspaceId,
      mergedIntoContactId: null,
    };

    if (opts.search?.trim()) {
      const q = opts.search.trim();
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
      ];
    }

    if (opts.lifecycle?.trim()) {
      where.lifecycle = {
        name: {
          equals: opts.lifecycle.trim(),
          mode: 'insensitive',
        },
      };
    }

    return where;
  }

  private listContactsOrderBy(
    sortField?: string,
    sortDir?: string,
  ): Prisma.ContactOrderByWithRelationInput[] {
    const dir: Prisma.SortOrder = sortDir === 'desc' ? 'desc' : 'asc';

    if (sortField === 'name') {
      return [{ firstName: dir }, { lastName: dir }, { id: dir }];
    }

    if (sortField === 'email') {
      return [{ email: dir }, { id: dir }];
    }

    if (sortField === 'phone') {
      return [{ phone: dir }, { id: dir }];
    }

    if (sortField === 'lifecycle') {
      return [{ lifecycle: { name: dir } }, { id: dir }];
    }

    return [{ createdAt: 'desc' }, { id: 'desc' }];
  }

  async create(workspaceId: string, dto: CreateContactDto) {
    const contact = await this.prisma.contact.create({
      data: {
        ...dto,
        workspaceId,
        email: this.normalizeOptionalEmail(dto.email),
        phone: this.normalizeOptionalPhone(dto.phone),
      },
      include: CONTACT_INCLUDE,
    });

    this.events.emit('contact.created', {
      workspaceId,
      contactId: contact.id,
      contact,
    });

    return this.toContactResponse(contact);
  }

  async assign(workspaceId: string, contactId: string, dto: AssignContactDto) {
    await this.getEditableContact(workspaceId, contactId);

    if (dto.assigneeId) {
      const member = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId, userId: dto.assigneeId, status: 'active' },
      });
      if (!member) throw new NotFoundException('Agent not in workspace');
    }

    if (dto.teamId) {
      const team = await this.prisma.team.findFirst({
        where: { id: dto.teamId, workspaceId },
      });
      if (!team) throw new NotFoundException('Team not found');
    }

    const updated = await this.prisma.contact.update({
      where: { id: contactId },
      data: {
        assigneeId: dto.assigneeId ?? null,
        teamId: dto.teamId ?? null,
      },
      include: CONTACT_INCLUDE,
    });

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', this.toContactResponse(updated));

    this.events.emit('contact.assigned', {
      workspaceId,
      contactId,
      assigneeId: dto.assigneeId ?? null,
      teamId: dto.teamId ?? null,
    });

    return this.toContactResponse(updated);
  }

  async updateLifecycle(workspaceId: string, contactId: string, lifecycleId: string) {
    await this.getEditableContact(workspaceId, contactId);

    const contact = await this.prisma.contact.update({
      where: { id: contactId },
      data: { lifecycleId },
      include: CONTACT_INCLUDE,
    });

    this.events.emit('contact.lifecycle_updated', {
      workspaceId,
      contactId,
      lifecycleId,
    });

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', this.toContactResponse(contact));

    return this.toContactResponse(contact);
  }
async addTag(workspaceId: string, contactId: string, tagId: string) {
  await this.getEditableContact(workspaceId, contactId);

  // Verify tag belongs to workspace
  const tag = await this.prisma.tag.findFirst({
    where: { id: tagId, workspaceId },
  });
  if (!tag) throw new NotFoundException('Tag not found');

  // Upsert to avoid duplicate error if already added
  await this.prisma.contactTag.upsert({
    where: { contactId_tagId: { contactId, tagId } },
    create: { contactId, tagId },
    update: {},
  });

  // Load updated tags for event + realtime
  const updatedTags = await this.prisma.contactTag.findMany({
    where: { contactId },
    select: { tagId: true },
  });

  const tagIds = updatedTags.map((t) => t.tagId);

  this.events.emit('contact.tag_updated', {
    workspaceId,
    contactId,
    action: 'added',
    tagId,
    tags: tagIds,
  });

  this.realtime.emitToWorkspace(workspaceId, 'contact:updated', {
    id: contactId,
    tags: tagIds,
  });

  return { contactId, tagId, tags: tagIds };
}

async removeTag(workspaceId: string, contactId: string, tagId: string) {
  await this.getEditableContact(workspaceId, contactId);

  // Delete join row — ignore if it didn't exist
  await this.prisma.contactTag.deleteMany({
    where: { contactId, tagId },
  });

  const updatedTags = await this.prisma.contactTag.findMany({
    where: { contactId },
    select: { tagId: true },
  });

  const tagIds = updatedTags.map((t) => t.tagId);

  this.events.emit('contact.tag_updated', {
    workspaceId,
    contactId,
    action: 'removed',
    tagId,
    tags: tagIds,
  });

  this.realtime.emitToWorkspace(workspaceId, 'contact:updated', {
    id: contactId,
    tags: tagIds,
  });

  return { contactId, tagId, tags: tagIds };
}

  async autoAssign(workspaceId: string, contactId: string) {
    const contact = await this.getEditableContact(workspaceId, contactId);

    let eligibleAgentIds: string[] = [];

    if (contact.teamId) {
      const teamMembers = await this.prisma.teamMember.findMany({
        where: { teamId: contact.teamId },
      });

      const workspaceMembers = await this.prisma.workspaceMember.findMany({
        where: {
          workspaceId,
          userId: { in: teamMembers.map((t) => t.userId) },
          role: 'agent',
          status: 'active',
          availability: 'online',
        },
      });

      eligibleAgentIds = workspaceMembers.map((m) => m.userId);
    } else {
      const workspaceMembers = await this.prisma.workspaceMember.findMany({
        where: { workspaceId, role: 'agent', status: 'active', availability: 'online' },
      });
      eligibleAgentIds = workspaceMembers.map((m) => m.userId);
    }

    if (!eligibleAgentIds.length) return null;

    const workloads = await Promise.all(
      eligibleAgentIds.map(async (agentId) => {
        const count = await this.prisma.contact.count({
          where: { workspaceId, assigneeId: agentId, mergedIntoContactId: null },
        });
        return { userId: agentId, count };
      }),
    );

    workloads.sort((a, b) => a.count - b.count);
    const selectedAgent = workloads[0];

    const updated = await this.prisma.contact.update({
      where: { id: contactId },
      data: { assigneeId: selectedAgent.userId },
      include: CONTACT_INCLUDE,
    });

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', this.toContactResponse(updated));

    this.events.emit('contact.assigned', {
      workspaceId,
      contactId,
      assigneeId: selectedAgent.userId,
      teamId: contact.teamId,
    });

    return this.toContactResponse(updated);
  }

  async findAll(
    workspaceId: string,
    opts: {
      search?: string;
      lifecycle?: string;
      sortField?: string;
      sortDir?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(Math.max(1, opts.limit ?? 10), 100);
    const where = this.listContactsWhere(workspaceId, {
      search: opts.search,
      lifecycle: opts.lifecycle,
    });
    const orderBy = this.listContactsOrderBy(opts.sortField, opts.sortDir);

    const [total, contacts] = await Promise.all([
      this.prisma.contact.count({ where }),
      this.prisma.contact.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: CONTACT_INCLUDE,
      }),
    ]);

    return {
      data: contacts.map((contact) => this.toContactResponse(contact)),
      total,
      page,
      limit,
    };
  }

  async findOne(workspaceId: string, id: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { id, workspaceId },
      include: CONTACT_INCLUDE,
    });
    if (!contact) throw new NotFoundException('Contact not found');

    const duplicateSummary = contact.mergedIntoContactId
      ? { contactId: id, suggestions: [] }
      : await this.findDuplicates(workspaceId, id);
    return {
      ...this.toContactResponse(contact),
      duplicateSummary: {
        total: duplicateSummary.suggestions.length,
        suggestions: duplicateSummary.suggestions.slice(0, 3),
      },
    };
  }

  async update(workspaceId: string, id: string, dto: UpdateContactDto) {
    await this.getEditableContact(workspaceId, id);

    const contact = await this.prisma.contact.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.email !== undefined ? { email: this.normalizeOptionalEmail(dto.email) } : {}),
        ...(dto.phone !== undefined ? { phone: this.normalizeOptionalPhone(dto.phone) } : {}),
      },
      include: CONTACT_INCLUDE,
    });

    this.events.emit('contact.field_updated', {
      workspaceId,
      contactId: id,
      fields: dto,
    });

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', this.toContactResponse(contact));

    return this.toContactResponse(contact);
  }

  async remove(workspaceId: string, id: string) {
    await this.getEditableContact(workspaceId, id);
    return this.prisma.contact.delete({ where: { id } });
  }

  async statusUpdate(workspaceId: string, contactId: string, status: string) {
    await this.getEditableContact(workspaceId, contactId);

    const updated = await this.prisma.contact.update({
      where: { id: contactId },
      data: { status },
      include: CONTACT_INCLUDE,
    });

    if (status === 'closed') {
      this.events.emit('conversation.closed', {
        workspaceId,
        contactId,
      });
    } else {
        this.events.emit('conversation.opened', {
        workspaceId,
        contactId,
        source: 'user',
        });
    }

   

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', this.toContactResponse(updated));

    return this.toContactResponse(updated);
  }

  async findDuplicates(workspaceId: string, contactId: string) {
    const current = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId, mergedIntoContactId: null },
      include: CONTACT_INCLUDE,
    });
    if (!current) throw new NotFoundException('Contact not found');

    const currentEmail = this.normalizeOptionalEmail(current.email);
    const currentPhone = this.normalizeOptionalPhone(current.phone);
    const currentName = this.normalizeName([current.firstName, current.lastName].filter(Boolean).join(' '));
    const currentCompany = this.normalizeName(current.company);

    if (!currentEmail && !currentPhone && !currentName) {
      return { contactId, suggestions: [] };
    }

    const candidates = await this.prisma.contact.findMany({
      where: {
        workspaceId,
        id: { not: contactId },
        mergedIntoContactId: null,
        OR: [
          ...(currentEmail ? [{ email: { equals: currentEmail, mode: 'insensitive' as const } }] : []),
          ...(currentPhone ? [{ phone: currentPhone }] : []),
          ...(current.firstName && current.lastName
            ? [{
                AND: [
                  { firstName: { equals: current.firstName, mode: 'insensitive' as const } },
                  { lastName: { equals: current.lastName, mode: 'insensitive' as const } },
                ],
              }]
            : []),
        ],
      },
      include: CONTACT_INCLUDE,
      take: 10,
      orderBy: { updatedAt: 'desc' },
    });

    const suggestions = await Promise.all(
      candidates.map(async (candidate) => {
        const reasons: string[] = [];
        let score = 0;

        const candidateEmail = this.normalizeOptionalEmail(candidate.email);
        const candidatePhone = this.normalizeOptionalPhone(candidate.phone);
        const candidateName = this.normalizeName([candidate.firstName, candidate.lastName].filter(Boolean).join(' '));
        const candidateCompany = this.normalizeName(candidate.company);

        if (currentEmail && candidateEmail && currentEmail === candidateEmail) {
          reasons.push('exact_email');
          score += 55;
        }

        if (currentPhone && candidatePhone && currentPhone === candidatePhone) {
          reasons.push('exact_phone');
          score += 50;
        }

        if (currentName && candidateName && currentName === candidateName) {
          reasons.push('exact_name');
          score += 18;
        }

        if (currentCompany && candidateCompany && currentCompany === candidateCompany) {
          reasons.push('same_company');
          score += 7;
        }

        const overlappingChannels = candidate.contactChannels.filter((channel) =>
          current.contactChannels.some(
            (currentChannel) =>
              currentChannel.channelType === channel.channelType &&
              currentChannel.identifier === channel.identifier,
          ),
        );

        if (overlappingChannels.length > 0) {
          reasons.push('shared_channel_identity');
          score += 20;
        }

        const [conversationCount, openConversationCount] = await Promise.all([
          this.prisma.conversation.count({ where: { workspaceId, contactId: candidate.id } }),
          this.prisma.conversation.count({
            where: { workspaceId, contactId: candidate.id, status: { not: 'closed' } },
          }),
        ]);

        return {
          contact: this.toContactResponse(candidate),
          score: Math.min(score, 100),
          reasons,
          conversationCount,
          openConversationCount,
        };
      }),
    );

    return {
      contactId,
      suggestions: suggestions
        .filter((item) => item.score >= 35)
        .sort((a, b) => b.score - a.score),
    };
  }

  async getMergePreview(workspaceId: string, primaryContactId: string, secondaryContactId: string) {
    if (primaryContactId === secondaryContactId) {
      throw new BadRequestException('A contact cannot be merged into itself');
    }

    const [primary, secondary] = await Promise.all([
      this.getEditableContact(workspaceId, primaryContactId, true),
      this.getEditableContact(workspaceId, secondaryContactId, true),
    ]);

    if (primary.mergedIntoContactId) {
      throw new ConflictException('The primary contact is already merged into another profile');
    }

    const duplicateInsight = await this.findDuplicates(workspaceId, primaryContactId);
    const matchedInsight = duplicateInsight.suggestions.find(
      (suggestion) => suggestion.contact.id === secondaryContactId,
    );

    const [conversationsToMove, channelsToMove, workflowRunsToMove, notificationHistoryToMove] =
      await Promise.all([
        this.prisma.conversation.count({ where: { workspaceId, contactId: secondaryContactId } }),
        this.prisma.contactChannel.count({ where: { workspaceId, contactId: secondaryContactId } }),
        this.prisma.workflowRun.count({ where: { workspaceId, contactId: secondaryContactId } }),
        this.prisma.notificationEmailHistory.count({ where: { workspaceId, contactId: secondaryContactId } }),
      ]);

    return {
      primary: this.toContactResponse(primary),
      secondary: this.toContactResponse(secondary),
      confidenceScore: matchedInsight?.score ?? 0,
      reasonCodes: matchedInsight?.reasons ?? [],
      suggestedResolution: this.buildSuggestedResolution(primary, secondary),
      impact: {
        conversationsToMove,
        channelsToMove,
        workflowRunsToMove,
        notificationHistoryToMove,
      },
    };
  }

  async mergeContacts(
    workspaceId: string,
    primaryContactId: string,
    dto: MergeContactsDto,
    actorId?: string,
  ) {
    const preview = await this.getMergePreview(
      workspaceId,
      primaryContactId,
      dto.secondaryContactId,
    );

    const resolution = {
      ...preview.suggestedResolution,
      ...(dto.resolution ?? {}),
      tags: dto.resolution?.tags ?? preview.suggestedResolution.tags,
      marketingOptOut:
        dto.resolution?.marketingOptOut ?? preview.suggestedResolution.marketingOptOut,
    };

    const result = await this.prisma.$transaction(async (tx) => {
      const primary = await this.getEditableContactWithClient(tx, workspaceId, primaryContactId, true);
      const secondary = await this.getEditableContactWithClient(
        tx,
        workspaceId,
        dto.secondaryContactId,
        true,
      );

      if (primary.mergedIntoContactId) {
        throw new ConflictException('The primary contact is already merged');
      }

      if (secondary.mergedIntoContactId) {
        throw new ConflictException('The duplicate contact is already merged');
      }

      await tx.contact.update({
        where: { id: primary.id },
        data: {
          firstName: resolution.firstName || primary.firstName,
          lastName: resolution.lastName || null,
          email: this.normalizeOptionalEmail(resolution.email) ?? null,
          phone: this.normalizeOptionalPhone(resolution.phone) ?? null,
          company: resolution.company ?? null,
          lifecycleId: resolution.lifecycleId ?? primary.lifecycleId ?? secondary.lifecycleId ?? null,
          marketingOptOut: !!resolution.marketingOptOut,
        },
      });

      const selectedTagNames = new Set((resolution.tags ?? []).map((tag) => tag.trim()).filter(Boolean));
      const mergedTagIds = Array.from(
        new Set(
          [...primary.tags, ...secondary.tags]
            .filter((tag) => selectedTagNames.size === 0 || selectedTagNames.has(tag.tag.name))
            .map((tag) => tag.tagId),
        ),
      );

      for (const tagId of mergedTagIds) {
        await tx.contactTag.upsert({
          where: { contactId_tagId: { contactId: primary.id, tagId } },
          create: { contactId: primary.id, tagId },
          update: {},
        });
      }

      await tx.contactTag.deleteMany({
        where: {
          contactId: primary.id,
          ...(mergedTagIds.length ? { tagId: { notIn: mergedTagIds } } : {}),
        },
      });

      await tx.contactTag.deleteMany({
        where: { contactId: secondary.id },
      });

      const primaryChannelKeys = new Set(
        primary.contactChannels.map((channel) => `${channel.channelId}:${channel.identifier}`),
      );
      const secondaryChannels = await tx.contactChannel.findMany({
        where: { workspaceId, contactId: secondary.id },
      });

      for (const channel of secondaryChannels) {
        const key = `${channel.channelId}:${channel.identifier}`;
        if (primaryChannelKeys.has(key)) {
          await tx.contactChannel.delete({ where: { id: channel.id } });
          continue;
        }

        await tx.contactChannel.update({
          where: { id: channel.id },
          data: { contactId: primary.id },
        });
      }

      const allConversations = await tx.conversation.findMany({
        where: {
          workspaceId,
          contactId: { in: [primary.id, secondary.id] },
        },
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'asc' }],
      });

      const primaryConversations = allConversations.filter((conversation) => conversation.contactId === primary.id);
      const survivorConversation = primaryConversations[0] ?? allConversations[0] ?? null;
      const mergedConversationIds = survivorConversation
        ? allConversations
            .filter((conversation) => conversation.id !== survivorConversation.id)
            .map((conversation) => conversation.id)
        : [];

      if (survivorConversation) {
        await tx.conversation.update({
          where: { id: survivorConversation.id },
          data: {
            contactId: primary.id,
            lastMessageId: null,
          },
        });

        if (mergedConversationIds.length > 0) {
          await tx.conversation.updateMany({
            where: { id: { in: mergedConversationIds } },
            data: { lastMessageId: null },
          });

          await tx.message.updateMany({
            where: { conversationId: { in: mergedConversationIds } },
            data: { conversationId: survivorConversation.id },
          });

          await tx.conversationActivity.updateMany({
            where: { conversationId: { in: mergedConversationIds } },
            data: { conversationId: survivorConversation.id },
          });

          await tx.conversation.deleteMany({
            where: { id: { in: mergedConversationIds } },
          });
        }

        const [latestMessage, latestIncomingMessage] = await Promise.all([
          tx.message.findFirst({
            where: { conversationId: survivorConversation.id },
            orderBy: [{ createdAt: 'desc' }],
            select: { id: true, createdAt: true },
          }),
          tx.message.findFirst({
            where: { conversationId: survivorConversation.id, direction: 'incoming' },
            orderBy: [{ createdAt: 'desc' }],
            select: { createdAt: true },
          }),
        ]);

        await tx.conversation.update({
          where: { id: survivorConversation.id },
          data: {
            contactId: primary.id,
            subject:
              survivorConversation.subject ??
              allConversations.find((conversation) => conversation.subject)?.subject ??
              null,
            status: this.pickMergedConversationStatus(allConversations.map((conversation) => conversation.status)),
            priority: this.pickMergedConversationPriority(allConversations.map((conversation) => conversation.priority)),
            unreadCount: allConversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0),
            lastMessageId: latestMessage?.id ?? null,
            lastMessageAt: latestMessage?.createdAt ?? null,
            lastIncomingAt: latestIncomingMessage?.createdAt ?? null,
            firstResponseAt:
              allConversations
                .map((conversation) => conversation.firstResponseAt)
                .filter(Boolean)
                .sort((left, right) => left!.getTime() - right!.getTime())[0] ?? null,
            resolvedAt:
              allConversations
                .map((conversation) => conversation.resolvedAt)
                .filter(Boolean)
                .sort((left, right) => right!.getTime() - left!.getTime())[0] ?? null,
            slaDueAt:
              allConversations
                .map((conversation) => conversation.slaDueAt)
                .filter(Boolean)
                .sort((left, right) => left!.getTime() - right!.getTime())[0] ?? null,
            slaBreached: allConversations.some((conversation) => conversation.slaBreached),
          },
        });
      }

      await tx.workflowRun.updateMany({
        where: { workspaceId, contactId: secondary.id },
        data: { contactId: primary.id },
      });

      const historyRows = await tx.notificationEmailHistory.findMany({
        where: { workspaceId, contactId: secondary.id },
      });

      for (const row of historyRows) {
        const existing = await tx.notificationEmailHistory.findFirst({
          where: {
            userId: row.userId,
            workspaceId,
            contactId: primary.id,
            type: row.type,
            inactivitySessionId: row.inactivitySessionId,
          },
        });

        if (existing) {
          await tx.notificationEmailHistory.delete({ where: { id: row.id } });
        } else {
          await tx.notificationEmailHistory.update({
            where: { id: row.id },
            data: { contactId: primary.id },
          });
        }
      }

      await tx.contact.update({
        where: { id: secondary.id },
        data: {
          status: 'merged',
          mergedIntoContactId: primary.id,
          mergedAt: new Date(),
          mergedByUserId: actorId ?? null,
          assigneeId: null,
          teamId: null,
        },
      });

      const mergeRun = await tx.contactMergeRun.create({
        data: {
          workspaceId,
          primaryContactId: primary.id,
          secondaryContactId: secondary.id,
          source: dto.source ?? 'inbox_sidebar',
          confidenceScore: dto.confidenceScore ?? preview.confidenceScore,
          reasonCodes: (dto.reasonCodes ?? preview.reasonCodes) as Prisma.InputJsonValue,
          resolution: resolution as Prisma.InputJsonValue,
          summary: {
            impact: preview.impact,
            survivorConversationId: survivorConversation?.id ?? null,
            mergedConversationIds,
          } as Prisma.InputJsonValue,
          executedByUserId: actorId ?? null,
        },
      });

      const refreshedSurvivorConversation = survivorConversation
        ? await tx.conversation.findUnique({
            where: { id: survivorConversation.id },
            include: {
              contact: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  phone: true,
                  avatarUrl: true,
                  company: true,
                  status: true,
                  assigneeId: true,
                  teamId: true,
                  lifecycleId: true,
                  contactChannels: {
                    select: {
                      id: true,
                      channelId: true,
                      channelType: true,
                      identifier: true,
                      displayName: true,
                      avatarUrl: true,
                      createdAt: true,
                      updatedAt: true,
                      lastMessageTime: true,
                      lastIncomingMessageTime: true,
                      lastCallInteractionTime: true,
                      messageWindowExpiry: true,
                      conversationWindowCategory: true,
                      call_permission: true,
                      hasPermanentCallPermission: true,
                    },
                  },
                },
              },
              lastMessage: {
                select: {
                  id: true,
                  text: true,
                  direction: true,
                  type: true,
                  status: true,
                  createdAt: true,
                  channelId: true,
                  channel: true,
                },
              },
            },
          })
        : null;

      const mergedPrimary = await tx.contact.findUnique({
        where: { id: primary.id },
        include: CONTACT_INCLUDE,
      });

      return {
        mergeRunId: mergeRun.id,
        contact: mergedPrimary ? this.toContactResponse(mergedPrimary) : null,
        survivorConversationId: survivorConversation?.id ?? null,
        mergedConversationIds,
        survivorConversation: refreshedSurvivorConversation,
        mergedContactName: `${secondary.firstName ?? ''} ${secondary.lastName ?? ''}`.trim(),
        survivorContactName: `${primary.firstName ?? ''} ${primary.lastName ?? ''}`.trim(),
      };
    });

    if (result.survivorConversationId) {
      await this.activity.record({
        workspaceId,
        conversationId: result.survivorConversationId,
        eventType: 'merge_contact',
        actorId,
        metadata: {
          mergedContactId: dto.secondaryContactId,
          mergedContactName: result.mergedContactName,
          survivorContactId: primaryContactId,
          survivorContactName: result.survivorContactName,
          mergedConversationIds: result.mergedConversationIds,
          survivorConversationId: result.survivorConversationId,
        } as any,
      });
    }

    if (result.contact) {
      this.realtime.emitToWorkspace(workspaceId, 'contact:updated', result.contact);
      this.realtime.emitToWorkspace(workspaceId, 'contact:merged', {
        primaryContactId,
        secondaryContactId: dto.secondaryContactId,
        mergeRunId: result.mergeRunId,
        survivorConversationId: result.survivorConversationId,
        mergedConversationIds: result.mergedConversationIds,
      });
      if (result.survivorConversation) {
        this.events.emit('conversation.updated', result.survivorConversation);
      }
    }

    return result;
  }

  private async getEditableContact(
    workspaceId: string,
    contactId: string,
    allowMerged = false,
  ) {
    return this.getEditableContactWithClient(this.prisma, workspaceId, contactId, allowMerged);
  }

  private async getEditableContactWithClient(
    client: PrismaService | Prisma.TransactionClient,
    workspaceId: string,
    contactId: string,
    allowMerged = false,
  ) {
    const contact = await client.contact.findFirst({
      where: { id: contactId, workspaceId },
      include: CONTACT_INCLUDE,
    });

    if (!contact) {
      throw new NotFoundException('Contact not found');
    }

    if (!allowMerged && contact.mergedIntoContactId) {
      throw new ConflictException('This contact is already merged into another profile');
    }

    return contact;
  }

  private toContactResponse(contact: ContactWithDetails) {
    return {
      ...contact,
      tags: contact.tags.map((item) => item.tag.name),
      tagIds: contact.tags.map((item) => item.tagId),
      lifecycleStage: contact.lifecycle?.name ?? null,
    };
  }

  private normalizeOptionalEmail(value?: string | null) {
    const email = value?.trim().toLowerCase();
    return email ? email : null;
  }

  private normalizeOptionalPhone(value?: string | null) {
    const raw = value?.trim();
    if (!raw) return null;

    const hasPlus = raw.startsWith('+');
    const digits = raw.replace(/[^\d]/g, '');
    if (!digits) return null;

    return `${hasPlus ? '+' : ''}${digits}`;
  }

  private normalizeName(value?: string | null) {
    return value?.trim().toLowerCase().replace(/\s+/g, ' ') || null;
  }

  private pickMergedConversationStatus(statuses: string[]) {
    if (statuses.includes('open')) return 'open';
    if (statuses.includes('pending')) return 'pending';
    if (statuses.includes('resolved')) return 'resolved';
    if (statuses.includes('closed')) return 'closed';
    return 'open';
  }

  private pickMergedConversationPriority(priorities: string[]) {
    const rank: Record<string, number> = {
      low: 1,
      normal: 2,
      high: 3,
      urgent: 4,
    };

    return [...priorities].sort((left, right) => (rank[right] ?? 0) - (rank[left] ?? 0))[0] ?? 'normal';
  }

  private buildSuggestedResolution(primary: ContactWithDetails, secondary: ContactWithDetails) {
    const pickLonger = (a?: string | null, b?: string | null) => {
      const left = a?.trim() || '';
      const right = b?.trim() || '';
      if (!left) return right || null;
      if (!right) return left || null;
      return right.length > left.length ? right : left;
    };

    return {
      firstName: pickLonger(primary.firstName, secondary.firstName) ?? primary.firstName,
      lastName: pickLonger(primary.lastName, secondary.lastName),
      email: this.normalizeOptionalEmail(primary.email) ?? this.normalizeOptionalEmail(secondary.email),
      phone: this.normalizeOptionalPhone(primary.phone) ?? this.normalizeOptionalPhone(secondary.phone),
      company: pickLonger(primary.company, secondary.company),
      lifecycleId: primary.lifecycleId ?? secondary.lifecycleId ?? null,
      marketingOptOut: !!primary.marketingOptOut || !!secondary.marketingOptOut,
      tags: Array.from(
        new Set([
          ...primary.tags.map((tag) => tag.tag.name),
          ...secondary.tags.map((tag) => tag.tag.name),
        ]),
      ),
    };
  }
}
