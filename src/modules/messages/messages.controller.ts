import {
    Controller,
    Post,
    Get,
    Param,
    Body,
    Req,
    UseGuards,
    Logger,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CreateMessageDto } from './dto/create-message.dto';
import { User } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { OutboundService, SendMessageDto } from '../outbound/outbound.service';

@Controller('api/conversations/:conversationId/messages')
@UseGuards(JwtGuard, WorkspaceGuard)
export class MessagesController {
    private readonly logger = new Logger(MessagesController.name);
    constructor(private service: MessagesService,
        private outbound: OutboundService


    ) { }

    // @UseGuards(JwtGuard, WorkspaceGuard, PermissionGuard)
    // @RequirePermission('message.send')
    // @Post()
    // create(
    //     @Req() req: any,
    //     @Param('conversationId') conversationId: string,
    //     @Body() dto: CreateMessageDto,
    // ) {
    //     return this.service.create(
    //         req.workspaceId,
    //         conversationId,
    //         req.user.id,
    //         dto,
    //     );
    // }

    @UseGuards(JwtGuard, WorkspaceGuard)
    @Get()
    findAll(
        @Req() req: any,
        @Param('conversationId') conversationId: string,
    ) {
        return this.service.findAll(req.workspaceId, conversationId);
    }

    @UseGuards(JwtGuard, WorkspaceGuard)
    @Post('read')
    async markRead(
        @Req() req: any,
        @Param('conversationId') conversationId: string,
    ) {
        return this.service.readMessages(req.workspaceId, conversationId);
    }

    @Post()
    async send(
        @Param('conversationId') conversationId: string,
        @Body() body: SendMessageDto,
        @Req() req: any,
        // @CurrentUser() user: User,
    ) {
        this.logger.log(`Sending message to conversation ${conversationId} with body: ${JSON.stringify(body)}`);
        return this.outbound.sendMessage({
            ...body,
            conversationId,
            authorId: req.user.id,
        });
    }
}