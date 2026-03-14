import { forwardRef, Module } from '@nestjs/common';
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
import { ActivityService } from '../activity/activity.service';

@Module({
    imports: [
        PrismaModule,
        ConversationsModule,
        // MessagesModule,
    forwardRef(() => MessagesModule),   // ✅ fix
        RealtimeModule,
        WorkflowsModule,
        // ChannelsModule,
        forwardRef(() => ChannelsModule), // ✅ fix
        

    ],
    providers: [PrismaService, RealtimeService, InboundService, ConversationsService, MessagesService,ActivityService],
    exports: [InboundService], // 👈 important
})
export class InboundModule { }