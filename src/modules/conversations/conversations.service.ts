import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { slaQueue } from '../../queues/sla.queue';
import { RedisService } from 'src/redis/redis.service';
import { ActivityService } from '../activity/activity.service';
import { OpenActivityMeta, CloseActivityMeta, AssignUserActivityMeta, AssignTeamActivityMeta, UnassignUserActivityMeta, UnassignTeamActivityMeta, MergeContactActivityMeta, ChannelAddedActivityMeta } from '../activity/activity.types';
import { IsIn, IsOptional, IsString } from 'class-validator';



// ─── DTOs ─────────────────────────────────────────────────────────────────────
 
export class UpdateStatusDto {

  @IsIn(['open', 'pending', 'resolved', 'closed'])
  status: 'open' | 'pending' | 'resolved' | 'closed';

  @IsOptional()
  @IsString()
  actorId?: string;

  @IsOptional()
  @IsIn(['user', 'system', 'automation'])
  actorType?: 'user' | 'system' | 'automation';
}
 
export interface AssignUserDto {
  userId: string;          // user to assign
  teamId?: string;         // optionally assign team at the same time
  actorId?: string;        // who is doing the assigning
}
 
export interface UnassignUserDto {
  actorId?: string;
}
 
export interface AssignTeamDto {
  teamId: string;
  actorId?: string;
}
 
export interface UnassignTeamDto {
  actorId?: string;
}
 
export interface MergeContactDto {
  /** The contact that will be DELETED (its conversations move to survivorContactId) */
  mergedContactId: string;
  actorId?: string;
}
 
export interface AddNoteDto {
  text: string;
  actorId: string;
  mentionedUserIds?: string[];
  attachments?: { url: string; name: string; type: string }[];
}
 
export interface ChangePriorityDto {
  priority: 'low' | 'normal' | 'high' | 'urgent';
  actorId?: string;
}
@Injectable()
export class ConversationsService {
    constructor(private prisma: PrismaService,
                private activityService: ActivityService,
        
        private realtime: RealtimeService,
        private redis: RedisService,) { }


    async create(workspaceId: string, contactId: string) {
        const conversation = await this.prisma.conversation.create({
            data: {
                workspaceId,
                contactId,
            },
        });


        // Increment total and open counts
        await this.redis.increment(
            `dashboard:${workspaceId}`,
            'total',
            1,
        );

        // Increment open count
        await this.redis.increment(
            `dashboard:${workspaceId}`,
            'open',
            1,
        );

        // Example SLA: 5 minutes for first reply
        const delayMs = 5 * 60 * 1000;

        await slaQueue.add(
            'sla-breach',
            {
                workspaceId,
                conversationId: conversation.id,
            },
            {
                delay: delayMs,
                removeOnComplete: true,
            },
        );

        // If no assignee manually set
        // if (!conversation.assigneeId) {
        //     await this.autoAssign(workspaceId, conversation.id);
        // }


        return conversation;
    }

    async findAll(workspaceId: string) {
        return this.prisma.conversation.findMany({
            where: { workspaceId },
            include: {
                contact: true,
                lastMessage: true,
                channel: true,
            },
            orderBy: { updatedAt: 'desc' },
        });
    }

    // ─── Status (open / close / pending / reopen) ─────────────────────────────
 
  async updateStatus(
    conversationId: string,
    dto: UpdateStatusDto,
  ) {
    console.log("INTO");
    
    const conv = await this.findOrFail(conversationId);
 
    const previousStatus = conv.status;
 
    if (previousStatus === dto.status) return conv; // no-op
 
    // Map to activity event type
    const eventType = this.statusToEvent(previousStatus, dto.status);
 
    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status:     dto.status,
        resolvedAt: dto.status === 'resolved' ? new Date() : undefined,
        updatedAt:  new Date(),
      },
    });
 
    await this.activityService.record({
      workspaceId:    conv.workspaceId,
      conversationId: conv.id,
      eventType,
      actorId:    dto.actorId,
      actorType:  dto.actorType ?? (dto.actorId ? 'user' : 'system'),
      metadata:   { previousStatus } satisfies OpenActivityMeta | CloseActivityMeta,
    });
 
    return updated;
  }
 
  // ─── Assign user ──────────────────────────────────────────────────────────
 
  async assignUser(conversationId: string, dto: AssignUserDto) {
    const conv = await this.findOrFail(conversationId);
 
    // Load previous assignee from contact
    const contact = await this.prisma.contact.findUnique({
      where:  { id: conv.contactId },
      select: {
        assigneeId: true,
        assignee:   { select: { firstName: true, lastName: true } },
        teamId:     true,
        team:       { select: { name: true } },
      },
    });
 
    // Load new assignee
    const newUser = await this.prisma.user.findUnique({
      where:  { id: dto.userId },
      select: { firstName: true, lastName: true },
    });
    if (!newUser) throw new BadRequestException(`User ${dto.userId} not found`);
 
    const previousUserId   = contact?.assigneeId ?? null;
    const previousUserName = contact?.assignee
      ? `${contact.assignee.firstName ?? ''} ${contact.assignee.lastName ?? ''}`.trim()
      : null;
 
    // Update contact assignment
    await this.prisma.contact.update({
      where: { id: conv.contactId },
      data: {
        assigneeId: dto.userId,
        teamId:     dto.teamId ?? contact?.teamId ?? undefined,
      },
    });
 
    const meta: AssignUserActivityMeta = {
      previousUserId,
      previousUserName,
      newUserId:   dto.userId,
      newUserName: `${newUser.firstName ?? ''} ${newUser.lastName ?? ''}`.trim(),
    };
 
    await this.activityService.record({
      workspaceId:    conv.workspaceId,
      conversationId: conv.id,
      eventType:      'assign_user',
      actorId:        dto.actorId,
      subjectUserId:  dto.userId,
      subjectTeamId:  dto.teamId,
      metadata:       meta,
    });
 
    // If team is also being assigned, write a separate team activity
    if (dto.teamId && dto.teamId !== contact?.teamId) {
      const newTeam = await this.prisma.team.findUnique({
        where:  { id: dto.teamId },
        select: { name: true },
      });
      const meta2: AssignTeamActivityMeta = {
        previousTeamId:   contact?.teamId ?? null,
        previousTeamName: contact?.team?.name ?? null,
        newTeamId:        dto.teamId,
        newTeamName:      newTeam?.name ?? 'Unknown',
      };
      await this.activityService.record({
        workspaceId:    conv.workspaceId,
        conversationId: conv.id,
        eventType:      'assign_team',
        actorId:        dto.actorId,
        subjectTeamId:  dto.teamId,
        metadata:       meta2,
      });
    }
 
    return conv;
  }
 
  // ─── Unassign user ────────────────────────────────────────────────────────
 
  async unassignUser(conversationId: string, dto: UnassignUserDto) {
    const conv = await this.findOrFail(conversationId);
 
    const contact = await this.prisma.contact.findUnique({
      where:  { id: conv.contactId },
      select: {
        assigneeId: true,
        assignee:   { select: { firstName: true, lastName: true } },
      },
    });
 
    if (!contact?.assigneeId) return; // already unassigned
 
    const previousUserName = contact.assignee
      ? `${contact.assignee.firstName ?? ''} ${contact.assignee.lastName ?? ''}`.trim()
      : 'Unknown';
 
    const previousUserId = contact.assigneeId;
 
    await this.prisma.contact.update({
      where: { id: conv.contactId },
      data:  { assigneeId: null },
    });
 
    const meta: UnassignUserActivityMeta = {
      previousUserId,
      previousUserName,
    };
 
    await this.activityService.record({
      workspaceId:    conv.workspaceId,
      conversationId: conv.id,
      eventType:      'unassign_user',
      actorId:        dto.actorId,
      subjectUserId:  previousUserId,
      metadata:       meta,
    });
  }
 
  // ─── Assign team ──────────────────────────────────────────────────────────
 
  async assignTeam(conversationId: string, dto: AssignTeamDto) {
    const conv = await this.findOrFail(conversationId);
 
    const contact = await this.prisma.contact.findUnique({
      where:  { id: conv.contactId },
      select: { teamId: true, team: { select: { name: true } } },
    });
 
    const newTeam = await this.prisma.team.findUnique({
      where:  { id: dto.teamId },
      select: { name: true },
    });
    if (!newTeam) throw new BadRequestException(`Team ${dto.teamId} not found`);
 
    await this.prisma.contact.update({
      where: { id: conv.contactId },
      data:  { teamId: dto.teamId },
    });
 
    const meta: AssignTeamActivityMeta = {
      previousTeamId:   contact?.teamId ?? null,
      previousTeamName: contact?.team?.name ?? null,
      newTeamId:        dto.teamId,
      newTeamName:      newTeam.name,
    };
 
    await this.activityService.record({
      workspaceId:    conv.workspaceId,
      conversationId: conv.id,
      eventType:      'assign_team',
      actorId:        dto.actorId,
      subjectTeamId:  dto.teamId,
      metadata:       meta,
    });
  }
 
  // ─── Unassign team ────────────────────────────────────────────────────────
 
  async unassignTeam(conversationId: string, dto: UnassignTeamDto) {
    const conv = await this.findOrFail(conversationId);
 
    const contact = await this.prisma.contact.findUnique({
      where:  { id: conv.contactId },
      select: { teamId: true, team: { select: { name: true } } },
    });
 
    if (!contact?.teamId) return; // already no team
 
    const previousTeamName = contact.team?.name ?? 'Unknown';
    const previousTeamId   = contact.teamId;
 
    await this.prisma.contact.update({
      where: { id: conv.contactId },
      data:  { teamId: null },
    });
 
    const meta: UnassignTeamActivityMeta = {
      previousTeamId,
      previousTeamName,
    };
 
    await this.activityService.record({
      workspaceId:    conv.workspaceId,
      conversationId: conv.id,
      eventType:      'unassign_team',
      actorId:        dto.actorId,
      subjectTeamId:  previousTeamId,
      metadata:       meta,
    });
  }
 
  // ─── Add internal note ────────────────────────────────────────────────────
 
  async addNote(conversationId: string, dto: AddNoteDto) {
    const conv = await this.findOrFail(conversationId);
 
    return this.activityService.record({
      workspaceId:    conv.workspaceId,
      conversationId: conv.id,
      eventType:      'note',
      actorId:        dto.actorId,
      actorType:      'user',
      metadata: {
        text:             dto.text,
        mentionedUserIds: dto.mentionedUserIds ?? [],
        attachments:      dto.attachments ?? [],
      },
    });
  }
 
  // ─── Merge contact ────────────────────────────────────────────────────────
 
  async mergeContact(conversationId: string, dto: MergeContactDto) {
    const conv = await this.findOrFail(conversationId);
 
    // Load merged contact details for the activity description
    const mergedContact = await this.prisma.contact.findUnique({
      where:  { id: dto.mergedContactId },
      select: { firstName: true, lastName: true },
    });
    if (!mergedContact) {
      throw new BadRequestException(`Contact ${dto.mergedContactId} not found`);
    }
 
    const mergedContactName =
      `${mergedContact.firstName} ${mergedContact.lastName ?? ''}`.trim();
 
    // Re-parent all conversations, messages, contact channels from merged → survivor
    await this.prisma.$transaction([
      this.prisma.conversation.updateMany({
        where: { contactId: dto.mergedContactId },
        data:  { contactId: conv.contactId },
      }),
      this.prisma.message.updateMany({
        where: { conversationId: { in: await this.getConvIds(dto.mergedContactId) } },
        data:  {},                              // no field change needed — conv is re-parented above
      }),
      this.prisma.contactChannel.updateMany({
        where: { contactId: dto.mergedContactId },
        data:  { contactId: conv.contactId },
      }),
      // Soft-delete merged contact
      this.prisma.contact.update({
        where: { id: dto.mergedContactId },
        data:  { status: 'merged' },
      }),
    ]);
 
    const meta: MergeContactActivityMeta = {
      mergedContactId:   dto.mergedContactId,
      mergedContactName,
      survivorContactId: conv.contactId,
    };
 
    await this.activityService.record({
      workspaceId:    conv.workspaceId,
      conversationId: conv.id,
      eventType:      'merge_contact',
      actorId:        dto.actorId,
      metadata:       meta,
    });
  }
 
  // ─── Change priority ──────────────────────────────────────────────────────
 
  async changePriority(conversationId: string, dto: ChangePriorityDto) {
    const conv = await this.findOrFail(conversationId);
 
    const previousPriority = conv.priority;
 
    if (previousPriority === dto.priority) return conv;
 
    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  { priority: dto.priority },
    });
 
    await this.activityService.record({
      workspaceId:    conv.workspaceId,
      conversationId: conv.id,
      eventType:      'priority_changed',
      actorId:        dto.actorId,
      metadata:       { previousPriority, newPriority: dto.priority },
    });
 
    return updated;
  }
 
  // ─── Record channel added (called from InboundService) ───────────────────
 
  async recordChannelAdded(
    conversationId: string,
    workspaceId: string,
    meta: ChannelAddedActivityMeta,
    actorId?: string,
  ) {
    await this.activityService.record({
      workspaceId,
      conversationId,
      eventType: 'channel_added',
      actorId,
      actorType: actorId ? 'user' : 'system',
      metadata:  meta,
    });
  }
 
  // ─── Timeline ─────────────────────────────────────────────────────────────
 
  async getTimeline(conversationId: string, workspaceId: string) {
    return this.activityService.getTimeline(conversationId, workspaceId);
  }
 
  // ─── Helpers ──────────────────────────────────────────────────────────────
 
  private async findOrFail(id: string) {
    const conv = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conv) throw new NotFoundException(`Conversation ${id} not found`);
    return conv;
  }
 
  private async getConvIds(contactId: string): Promise<string[]> {
    const convs = await this.prisma.conversation.findMany({
      where:  { contactId },
      select: { id: true },
    });
    return convs.map(c => c.id);
  }
 
  private statusToEvent(
    prev: string,
    next: string,
  ): 'open' | 'close' | 'reopen' | 'pending' {
    if (next === 'open'    && prev !== 'open') return 'open';
    if (next === 'closed'  || next === 'resolved') return 'close';
    if (next === 'pending') return 'pending';
    return 'open';
  }

}