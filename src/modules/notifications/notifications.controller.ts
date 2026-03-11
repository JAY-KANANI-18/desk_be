import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ConversationsService } from "../conversations/conversations.service";
import { PrismaService } from "prisma/prisma.service";
import { WorkspaceGuard } from "src/common/guards/workspace.guard";
import { JwtGuard } from "src/common/guards/jwt.guard";




@Controller('api/notifications')
@UseGuards(JwtGuard,WorkspaceGuard)
export class NotificationsController {
    constructor(private service: ConversationsService,
                private prisma: PrismaService


    ) { }


    @Get()
    async getUserNotifications(@Req() req: any
    ) {

        return this.prisma.notification.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' },
            take: 50
        })

    }

}
