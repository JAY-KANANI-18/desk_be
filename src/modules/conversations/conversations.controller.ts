import {
    Controller,
    Get,
    Post,
    Patch,
    Param,
    Body,
    Req,
    UseGuards,
    Delete,
    HttpCode,
    HttpStatus,
    ParseUUIDPipe,
} from '@nestjs/common';
import { ConversationsService, UpdateStatusDto } from './conversations.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ActivityService } from '../activity/activity.service';
import { IsString, IsOptional, IsArray, IsIn } from 'class-validator';



// ─── Request body DTOs ────────────────────────────────────────────────────────


export class AssignUserBody {
    @IsString()
    userId: string;

    @IsOptional()
    @IsString()
    teamId?: string;
}

export class AssignTeamBody {
    @IsString()
    teamId: string;
}

export class AddNoteBody {
    @IsString()
    text: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    mentionedUserIds?: string[];
}

export class MergeContactBody {
    /** The contact ID that will be deleted (merged into this conversation's contact) */
    @IsString()
    mergedContactId: string;
}

export class ChangePriorityBody {
    @IsIn(['low', 'normal', 'high', 'urgent'])
    priority: 'low' | 'normal' | 'high' | 'urgent';
}
@Controller('api/conversations')
@UseGuards(JwtGuard, WorkspaceGuard)

export class ConversationsController {
    constructor(private conversationService: ConversationsService,
        private activityService: ActivityService

    ) { }

    @UseGuards( PermissionGuard)
    @RequirePermission('message.send')
    @Post()
    create(@Req() req: any, @Body() dto: CreateConversationDto) {
        return this.conversationService.create(req.workspaceId, dto.contactId);
    }

    @Get()
    findAll(@Req() req: any) {
        return this.conversationService.findAll(req.workspaceId);
    }
    // ── GET timeline (messages + activities merged) ───────────────────────────
    // Replace your existing GET /conversations/:id/messages with this.
    // The FE decides how to render each item based on item.type.

    @Get(':id/timeline')
    async getTimeline(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: any,
    ) {
        const workspaceId = req.user?.workspaceId ?? req.workspaceId;
        return this.conversationService.getTimeline(id, workspaceId);
    }

    // ── GET activities only ───────────────────────────────────────────────────

    @Get(':id/activities')
    async getActivities(
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.activityService.findByConversation(id);
    }

    // ── PATCH status: open / close / pending ──────────────────────────────────

    @Patch(':id/status')
    async updateStatus(
        @Param('id') id: string,
        @Body() body: UpdateStatusDto,
        @Req() req: any,
    ) {
        console.log("INTO");

        const actorId = req.user?.id;
        return this.conversationService.updateStatus(id, {
            status: body.status,
            actorId,
        });
    }

    // ── POST close (convenience shortcut) ────────────────────────────────────

    @Post(':id/close')
    @HttpCode(HttpStatus.OK)
    async close(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: any,
    ) {
        return this.conversationService.updateStatus(id, {
            status: 'closed',
            actorId: req.user?.id,
        });
    }

    // ── POST open (reopen) ────────────────────────────────────────────────────

    @Post(':id/open')
    @HttpCode(HttpStatus.OK)
    async open(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: any,
    ) {
        return this.conversationService.updateStatus(id, {
            status: 'open',
            actorId: req.user?.id,
        });
    }

    // ── POST pending ──────────────────────────────────────────────────────────

    @Post(':id/pending')
    @HttpCode(HttpStatus.OK)
    async pending(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: any,
    ) {
        return this.conversationService.updateStatus(id, {
            status: 'pending',
            actorId: req.user?.id,
        });
    }

    // ── POST assign user ──────────────────────────────────────────────────────

    @Post(':id/assign/user')
    @HttpCode(HttpStatus.OK)
    async assignUser(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AssignUserBody,
        @Req() req: any,
    ) {
        return this.conversationService.assignUser(id, {
            userId: body.userId,
            teamId: body.teamId,
            actorId: req.user?.id,
        });
    }

    // ── DELETE unassign user ──────────────────────────────────────────────────

    @Delete(':id/assign/user')
    @HttpCode(HttpStatus.OK)
    async unassignUser(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: any,
    ) {
        return this.conversationService.unassignUser(id, {
            actorId: req.user?.id,
        });
    }

    // ── POST assign team ──────────────────────────────────────────────────────

    @Post(':id/assign/team')
    @HttpCode(HttpStatus.OK)
    async assignTeam(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AssignTeamBody,
        @Req() req: any,
    ) {
        return this.conversationService.assignTeam(id, {
            teamId: body.teamId,
            actorId: req.user?.id,
        });
    }

    // ── DELETE unassign team ──────────────────────────────────────────────────

    @Delete(':id/assign/team')
    @HttpCode(HttpStatus.OK)
    async unassignTeam(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: any,
    ) {
        return this.conversationService.unassignTeam(id, {
            actorId: req.user?.id,
        });
    }

    // ── POST internal note ────────────────────────────────────────────────────

    @Post(':id/notes')
    async addNote(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AddNoteBody,
        @Req() req: any,
    ) {
        const actorId = req.user?.id;
        if (!actorId) throw new Error('Authenticated user required for notes');

        return this.conversationService.addNote(id, {
            text: body.text,
            actorId,
            mentionedUserIds: body.mentionedUserIds,
        });
    }

    // ── POST merge contact ────────────────────────────────────────────────────

    @Post(':id/merge-contact')
    @HttpCode(HttpStatus.OK)
    async mergeContact(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: MergeContactBody,
        @Req() req: any,
    ) {
        return this.conversationService.mergeContact(id, {
            mergedContactId: body.mergedContactId,
            actorId: req.user?.id,
        });
    }

    // ── PATCH priority ────────────────────────────────────────────────────────

    @Patch(':id/priority')
    async changePriority(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ChangePriorityBody,
        @Req() req: any,
    ) {
        return this.conversationService.changePriority(id, {
            priority: body.priority,
            actorId: req.user?.id,
        });
    }


}