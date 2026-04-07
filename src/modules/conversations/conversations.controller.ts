// src/conversations/conversations.controller.ts
//
// Complete controller.  All routes the FE inboxApi.ts calls:
//
//   GET    /api/conversations                    list + filter + search
//   GET    /api/conversations/search             full-text message search
//   GET    /api/conversations/:id                single conversation
//   GET    /api/conversations/:id/timeline       merged msg + activity (paginated)
//   GET    /api/conversations/:id/messages       messages only (paginated)
//   POST   /api/conversations                    create new conversation
//   POST   /api/conversations/:id/messages       send message
//   POST   /api/conversations/:id/notes          add internal note
//   POST   /api/conversations/:id/read           mark read
//   POST   /api/conversations/:id/close
//   POST   /api/conversations/:id/open
//   POST   /api/conversations/:id/pending
//   POST   /api/conversations/:id/assign/user
//   DELETE /api/conversations/:id/assign/user
//   POST   /api/conversations/:id/assign/team
//   DELETE /api/conversations/:id/assign/team
//   POST   /api/conversations/:id/merge-contact
//   PATCH  /api/conversations/:id/priority
//   PATCH  /api/conversations/:id/status         (generic — also used by FE)
//   GET    /api/conversations/:id/activities     activities only

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
  Optional,
} from '@nestjs/common';
import { IsString, IsOptional, IsArray, IsIn, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

import { ConversationsService } from './conversations.service';
import { ActivityService } from '../activity/activity.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto as SendMessageBody } from './dto/send-message.dto';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';

// ─── Body DTOs ────────────────────────────────────────────────────────────────

export class AssignUserBody {
  @IsString() userId: string;
  @IsOptional() @IsString() teamId?: string;
}

export class AssignTeamBody {
  @IsString() teamId: string;
}

export class AddNoteBody {
  @IsString() text: string;
  @IsOptional() @IsArray() @IsString({ each: true }) mentionedUserIds?: string[];
}

export class MergeContactBody {
  @IsString() mergedContactId: string;
}

export class ChangePriorityBody {
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority: 'low' | 'normal' | 'high' | 'urgent';
}

export class UpdateStatusBody {
  @IsIn(['open', 'pending', 'resolved', 'closed'])
  status: 'open' | 'pending' | 'resolved' | 'closed';
}

// ─── Query DTOs ────────────────────────────────────────────────────────────────

export class ListConversationsQuery {
  @IsOptional() @IsString()
  status?: string;

  @IsOptional() @IsString()
  priority?: string;

  @IsOptional() @IsIn(['incoming', 'outgoing', 'all'])
  direction?: 'incoming' | 'outgoing' | 'all';

  @IsOptional() @IsString()
  channelType?: string;

  @IsOptional() @IsString()
  assigneeId?: string;

  @IsOptional() @IsString()
  teamId?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  unreplied?: boolean;

  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsString()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number;

  @IsOptional() @IsString()
  lifecycleId?: string;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@Controller('api/conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly activityService: ActivityService,
  ) { }

  // ══════════════════════════════════════════════════════════════
  // LIST + SEARCH
  // ══════════════════════════════════════════════════════════════

  /**
   * GET /api/conversations
   * Query: status, priority, direction, channelType, assigneeId,
   *        teamId, unreplied, search, cursor, limit
   */
  @Get()
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  findAll(@Req() req: any, @Query() query: ListConversationsQuery) {
    const workspaceId = req.workspaceId as string;
    const actorUserId = req.user?.id as string;

    return this.conversationsService.findAll(workspaceId, {
      ...query,
      actorUserId,
    });
  }

  /**
   * GET /api/conversations/search?q=hello&limit=20
   * Full-text search across message content.
   * MUST be defined before /:id to avoid route collision.
   */
  @Get('search')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)


  searchMessages(
    @Req() req: any,
    @Query('q') q: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const workspaceId = req.workspaceId as string;
    return this.conversationsService.searchMessages(workspaceId, q ?? '', limit);
  }

  // ══════════════════════════════════════════════════════════════
  // SINGLE CONVERSATION
  // ══════════════════════════════════════════════════════════════

  @Get(':id')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)


  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ) {
    return this.conversationsService.findOne(id, req.workspaceId);
  }

  // ══════════════════════════════════════════════════════════════
  // CREATE
  // ══════════════════════════════════════════════════════════════

  @Post()
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)



  create(@Req() req: any, @Body() dto: CreateConversationDto) {
    return this.conversationsService.create(
      req.workspaceId,
      dto.contactId,
      dto.channelId,
    );
  }

  // ══════════════════════════════════════════════════════════════
  // MESSAGES
  // ══════════════════════════════════════════════════════════════

  /**
   * GET /api/conversations/:id/messages?cursor=...&limit=30
   * Returns messages only (newest-first from BE; FE reverses for display).
   */
  @Get(':id/messages')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)


  getMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit?: number,
  ) {
    return this.conversationsService.getMessages(id, req.workspaceId, cursor, limit);
  }

  /**
   * POST /api/conversations/:id/messages
   * Body: { channelId, text?, attachments?, metadata? }
   */
  //   @RequirePermission('message.send')
  //   @Post(':id/messages')
  //   @HttpCode(HttpStatus.CREATED)
  //   sendMessage(
  //     @Param('id', ParseUUIDPipe) id: string,
  //     @Body() body: SendMessageBody,
  //     @Req() req: any,
  //   ) {
  //     return this.conversationsService.sendMessage({
  //       workspaceId:    req.workspaceId,
  //       conversationId: id,
  //       channelId:      body.channelId,
  //       actorId:        req.user.id,
  //       text:           body.text,
  //       attachments:    body.attachments,
  //       metadata:       body.metadata,
  //     });
  //   }

  // ══════════════════════════════════════════════════════════════
  // TIMELINE
  // ══════════════════════════════════════════════════════════════

  /**
   * GET /api/conversations/:id/timeline?cursor=...&limit=30
   * Returns merged messages + activities sorted by timestamp.
   */
  @Get(':id/timeline')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)


  getTimeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit?: number,
  ) {
    return this.conversationsService.getTimeline(
      id, req.workspaceId, cursor, limit,
    );
  }

  // ══════════════════════════════════════════════════════════════
  // ACTIVITIES
  // ══════════════════════════════════════════════════════════════

  @Get(':id/activities')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)


  getActivities(@Param('id', ParseUUIDPipe) id: string) {
    return this.activityService.findByConversation(id);
  }

  // ══════════════════════════════════════════════════════════════
  // STATUS MUTATIONS
  // ══════════════════════════════════════════════════════════════

  /** PATCH /api/conversations/:id/status  { status: "closed" } */
  @Patch(':id/status')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)


  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateStatusBody,
    @Req() req: any,
  ) {
    return this.conversationsService.updateStatus(id, {
      status: body.status,
      actorId: req.user?.id,
    });
  }

  @Post(':id/close')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)


  @HttpCode(HttpStatus.OK)
  close(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.conversationsService.updateStatus(id, {
      status: 'closed', actorId: req.user?.id,
    });
  }

  @Post(':id/open')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)


  @HttpCode(HttpStatus.OK)
  open(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.conversationsService.updateStatus(id, {
      status: 'open', actorId: req.user?.id,
    });
  }

  @Post(':id/pending')
  @HttpCode(HttpStatus.OK)
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

  pending(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.conversationsService.updateStatus(id, {
      status: 'pending', actorId: req.user?.id,
    });
  }

  // ══════════════════════════════════════════════════════════════
  // ASSIGN / UNASSIGN
  // ══════════════════════════════════════════════════════════════

  @Post(':id/assign/user')
  @HttpCode(HttpStatus.OK)
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

  assignUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignUserBody,
    @Req() req: any,
  ) {
    return this.conversationsService.assignUser(id, {
      userId: body.userId,
      teamId: body.teamId,
      actorId: req.user?.id,
    });
  }

  @Delete(':id/assign/user')
  @HttpCode(HttpStatus.OK)
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

  unassignUser(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.conversationsService.unassignUser(id, { actorId: req.user?.id });
  }

  @Post(':id/assign/team')
  @HttpCode(HttpStatus.OK)
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

  assignTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignTeamBody,
    @Req() req: any,
  ) {
    return this.conversationsService.assignTeam(id, {
      teamId: body.teamId,
      actorId: req.user?.id,
    });
  }

  @Delete(':id/assign/team')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

  @HttpCode(HttpStatus.OK)
  unassignTeam(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.conversationsService.unassignTeam(id, { actorId: req.user?.id });
  }

  // ══════════════════════════════════════════════════════════════
  // NOTES / PRIORITY / MERGE / READ
  // ══════════════════════════════════════════════════════════════

  @Post(':id/notes')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddNoteBody,
    @Req() req: any,
  ) {
    if (!req.user?.id) throw new Error('Authenticated user required for notes');
    return this.conversationsService.addNote(id, {
      text: body.text,
      actorId: req.user.id,
      mentionedUserIds: body.mentionedUserIds,
    });
  }

  @Patch(':id/priority')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

  changePriority(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ChangePriorityBody,
    @Req() req: any,
  ) {
    return this.conversationsService.changePriority(id, {
      priority: body.priority,
      actorId: req.user?.id,
    });
  }

  @Post(':id/merge-contact')
  @HttpCode(HttpStatus.OK)
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

  mergeContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MergeContactBody,
    @Req() req: any,
  ) {
    return this.conversationsService.mergeContact(id, {
      mergedContactId: body.mergedContactId,
      actorId: req.user?.id,
    });
  }

  /** POST /api/conversations/:id/read — zeroes unread counter */
  @Post(':id/read')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.conversationsService.markRead(id, req.workspaceId);
  }
}