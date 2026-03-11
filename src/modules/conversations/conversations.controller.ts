import {
    Controller,
    Get,
    Post,
    Patch,
    Param,
    Body,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CreateConversationDto } from './dto/create-conversation.dto';

@Controller('api/conversations')
export class ConversationsController {
    constructor(private service: ConversationsService) { }

    @UseGuards(JwtGuard, WorkspaceGuard, PermissionGuard)
    @RequirePermission('message.send')
    @Post()
    create(@Req() req: any, @Body() dto: CreateConversationDto) {
        return this.service.create(req.workspaceId, dto.contactId);
    }

    @UseGuards(JwtGuard, WorkspaceGuard)
    @Get()
    findAll(@Req() req: any) {
        return this.service.findAll(req.workspaceId);
    }


    // @UseGuards(JwtGuard, WorkspaceGuard)
    // @Patch(':id/status/:status')
    // updateStatus(
    //     @Req() req: any,
    //     @Param('id') id: string,
    //     @Param('status') status: string,
    // ) {
    //     return this.service.updateStatus(req.workspaceId, id, status);
    // }
    // @UseGuards(JwtGuard, WorkspaceGuard)
    // @Patch(':id/resolve')
    // resolve(@Req() req: any, @Param('id') id: string) {
    //     return this.service.resolve(req.workspaceId, id);
    // }
}