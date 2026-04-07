import {
    Controller,
    Post,
    Get,
    Param,
    Body,
    Req,
    Logger,
    BadRequestException,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { CreateMessageDto } from './dto/create-message.dto';
import { User } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { OutboundService, SendMessageDto } from '../outbound/outbound.service';
import { IsIn, IsString, IsUUID } from 'class-validator';
import { v4 as uuid } from 'uuid';
import { R2Service } from 'src/common/storage/r2.service';
import { JwtOnly, WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';



// ─── DTO ──────────────────────────────────────────────────────────────────────

class PresignDto {
    @IsIn(['message-attachment'])
    type: 'message-attachment';

    @IsString()
    fileName: string;

    @IsString()
    contentType: string;

    /** conversation id — used to scope the storage path */
    @IsUUID()
    entityId: string;
}
@Controller('api/conversations/:conversationId/messages')
export class MessagesController {
    private readonly logger = new Logger(MessagesController.name);
    constructor(private service: MessagesService,
        private outbound: OutboundService,
        // private r2: R2Service,


    ) { }

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


    // @Post('presign')
    // async presign(@Body() dto: PresignDto, @Req() req: any) {
    //     const workspaceId = req.workspaceId as string;

    //     // Sanitise filename
    //     const ext = dto.fileName.split('.').pop() ?? 'bin';
    //     const safeName = `${uuid()}.${ext}`;
    //     const key = `attachments/${workspaceId}/${dto.entityId}/${safeName}`;

    //     const ALLOWED_TYPES = [
    //         'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    //         'video/mp4', 'video/quicktime',
    //         'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
    //         'application/pdf',
    //         'application/msword',
    //         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    //         'application/vnd.ms-excel',
    //         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    //         'text/plain', 'text/csv',
    //     ];

    //     if (!ALLOWED_TYPES.includes(dto.contentType)) {
    //         throw new BadRequestException(`Content-Type ${dto.contentType} is not allowed`);
    //     }

    //     const { uploadUrl, fileUrl } = await this.r2.createPresignedUploadUrl(
    //         key,
    //         dto.contentType,
    //         // expiresIn: 300, // 5 minutes
    //     );

    //     return { uploadUrl, fileUrl, key };
    // }

    @Get()
          @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)

    findAll(
        @Req() req: any,
        @Param('conversationId') conversationId: string,
    ) {
        return this.service.findAll(req.workspaceId, conversationId);
    }

    @Post('read')
    @WorkspaceRoute()
    async markRead(
        @Req() req: any,
        @Param('conversationId') conversationId: string,
    ) {
        return this.service.readMessages(req.workspaceId, conversationId);
    }

    @Post()
      @WorkspaceRoute(WorkspacePermission.MESSAGES_SEND)

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