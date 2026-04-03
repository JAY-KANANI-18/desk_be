import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';

@Injectable()
export class StatusService {
    constructor(
        private prisma: PrismaService,
        private realtime: RealtimeService,
    ) { }

    async process(statusUpdate: any) {
        const message = await this.prisma.message.findFirst({
            where: {
                channelMsgId: statusUpdate.externalMessageId,
            },
        });

        if (!message) return;

        await this.prisma.message.update({
            where: { id: message.id },
            data: {
                status: statusUpdate.status,
            },
        });

        this.realtime.emitToWorkspace(
            message.workspaceId,
            'message:status',
            {
                messageId: message.id,
                status: statusUpdate.status,
            },
        );
    }
}