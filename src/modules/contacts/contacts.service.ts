import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AssignContactDto } from './dto/assign.dto';
import { RealtimeService } from 'src/realtime/realtime.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class ContactsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private events: EventEmitter2,
  ) {}

  async create(workspaceId: string, dto: CreateContactDto) {
    const contact = await this.prisma.contact.create({
      data: { ...dto, workspaceId },
    });

    this.events.emit('contact.created', {
      workspaceId,
      contactId: contact.id,
      contact,
    });

    return contact;
  }

  async assign(workspaceId: string, contactId: string, dto: AssignContactDto) {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) throw new NotFoundException('Contact not found');

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
    });

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', updated);

    this.events.emit('contact.assigned', {
      workspaceId,
      contactId,
      assigneeId: dto.assigneeId ?? null,
      teamId: dto.teamId ?? null,
    });

    return updated;
  }

  async updateLifecycle(workspaceId: string, contactId: string, lifecycleId: string) {
    const contact = await this.prisma.contact.update({
      where: { id: contactId, workspaceId },
      data: { lifecycleId },
    });

    this.events.emit('contact.lifecycle_updated', {
      workspaceId,
      contactId,
      lifecycleId,
    });

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', contact);

    return contact;
  }
async addTag(workspaceId: string, contactId: string, tagId: string) {
  // Verify contact belongs to workspace
  const contact = await this.prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
  });
  if (!contact) throw new NotFoundException('Contact not found');

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
  const contact = await this.prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
  });
  if (!contact) throw new NotFoundException('Contact not found');

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
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) return;

    let eligibleAgentIds: string[] = [];

    if (contact.teamId) {
      const teamMembers = await this.prisma.teamMember.findMany({
        where: { teamId: contact.teamId },
        include: { user: true },
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

    if (!eligibleAgentIds.length) return;

    const workloads = await Promise.all(
      eligibleAgentIds.map(async (agentId) => {
        const count = await this.prisma.contact.count({
          where: { workspaceId, assigneeId: agentId },
        });
        return { userId: agentId, count };
      }),
    );

    workloads.sort((a, b) => a.count - b.count);
    const selectedAgent = workloads[0];

    const updated = await this.prisma.contact.update({
      where: { id: contactId },
      data: { assigneeId: selectedAgent.userId },
    });

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', updated);

    this.events.emit('contact.assigned', {
      workspaceId,
      contactId,
      assigneeId: selectedAgent.userId,
      teamId: contact.teamId,
    });

    return updated;
  }

  async findAll(workspaceId: string) {
    return this.prisma.contact.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(workspaceId: string, id: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { id, workspaceId },
    });
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  async update(workspaceId: string, id: string, dto: UpdateContactDto) {
    await this.findOne(workspaceId, id);

    const contact = await this.prisma.contact.update({
      where: { id },
      data: dto,
    });

    this.events.emit('contact.field_updated', {
      workspaceId,
      contactId: id,
      fields: dto,
    });

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', contact);

    return contact;
  }

  async remove(workspaceId: string, id: string) {
    await this.findOne(workspaceId, id);
    return this.prisma.contact.delete({ where: { id } });
  }

  async statusUpdate(workspaceId: string, contactId: string, status: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    const updated = await this.prisma.contact.update({
      where: { id: contactId },
      data: { status },
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

   

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', updated);

    return updated;
  }
}