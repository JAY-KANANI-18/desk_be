import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from '../prisma/prisma.module';
import { OrganizationModule } from '../src/modules/organization/organization.module';
import { ContactsModule } from '../src/modules/contacts/contacts.module';
import { ConversationsModule } from '../src/modules/conversations/conversations.module';
import { MessagesModule } from '../src/modules/messages/messages.module';
import { RealtimeModule } from '../src/realtime/realtime.module';
import { RedisModule } from '../src/redis/redis.module';
import { TeamsModule } from '../src/modules/teams/teams.module';
import { WorkflowsModule } from '../src/modules/workflows/workflows.module';
import { InboundModule } from '../src/modules/inbound/inbound.module';
import { ChannelsModule } from '../src/modules/channels/channels.module';
import { WebhooksModule } from '../src/modules/webhooks/webhooks.module';
import { UsersModule } from '../src/modules/users/users.module';
import { WorkspaceModule } from '../src/modules/workspace/workspace.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { NotificationQueue } from './queues/notification.queue';
import { FilesModule } from './modules/files/files.module';
@Module({
  imports: [PrismaModule,
    RedisModule,
    RealtimeModule,
    OrganizationModule, ContactsModule, ConversationsModule, MessagesModule,
    UsersModule,
    WorkspaceModule,
    ChannelsModule,
    WebhooksModule,
    TeamsModule, WorkflowsModule, InboundModule,
    EventEmitterModule.forRoot(),
    NotificationsModule,
    FilesModule


  ],
  controllers: [AppController],
  providers: [AppService, NotificationQueue],
  exports: [NotificationQueue],

})
export class AppModule { }
