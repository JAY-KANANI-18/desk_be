import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { OrganizationModule } from './modules/organization/organization.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { MessagesModule } from './modules/messages/messages.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { TeamsModule } from './modules/teams/teams.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { InboundModule } from './modules/inbound/inbound.module';
import { ChannelsModule } from './modules/channels/channels.module';
// import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { UsersModule } from './modules/users/users.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { NotificationQueue } from './queues/notification.queue';
import { FilesModule } from './modules/files/files.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { TagsModule } from './modules/tags/tags.module';
import { ChannelAdaptersModule } from './modules/channel-adapters/channel-adapters.module';
import { MediaModule } from './modules/media/media.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { BillingModule } from './modules/billing/billing.module';
import { PrismaModule } from './prisma/prisma.module';
@Module({
  imports: [PrismaModule,
    RedisModule,
    RealtimeModule,
    OrganizationModule, ContactsModule, ConversationsModule, MessagesModule,
    UsersModule,
    WorkspaceModule,
    ChannelsModule,
    // WebhooksModule,
    TeamsModule, WorkflowsModule, InboundModule,
    EventEmitterModule.forRoot(),
    NotificationsModule,
    FilesModule,
    LifecycleModule,
    TagsModule,
    ChannelAdaptersModule,
    MediaModule,
    AnalyticsModule,
    BillingModule


  ],
  controllers: [AppController],
  providers: [AppService, NotificationQueue],
  exports: [NotificationQueue],

})
export class AppModule { }
