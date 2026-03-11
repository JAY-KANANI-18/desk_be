import { Module } from '@nestjs/common';
import { PrismaModule } from 'prisma/prisma.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';
import { InboundService } from './inbound.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { PrismaService } from 'prisma/prisma.service';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { RealtimeService } from 'src/realtime/realtime.service';
import { WorkflowsModule } from '../workflows/workflows.module';
import { MediaService } from '../channels/media.service';
import { ChannelRegistry } from '../channels/channel-registry.service';
import { ChannelsModule } from '../channels/channels.module';

@Module({
    imports: [
        PrismaModule,
        ConversationsModule,
        MessagesModule,
        RealtimeModule,
        WorkflowsModule,
        ChannelsModule,
    ],
    providers: [PrismaService, RealtimeService, InboundService, ConversationsService, MessagesService,MediaService,ChannelRegistry,MediaService],
    exports: [InboundService], // 👈 important
})
export class InboundModule { }