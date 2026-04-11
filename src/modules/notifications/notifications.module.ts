import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationListener } from './notification.listener';
import { NotificationPreferencesService } from './notification-preferences.service';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { NotificationQueue } from 'src/queues/notification.queue';
import { NotificationsController } from './notifications.controller';
import { NotificationActivityService } from './notification-activity.service';
import { NotificationRuleEngineService } from './notification-rule-engine.service';

@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationListener,
    NotificationPreferencesService,
    NotificationActivityService,
    NotificationRuleEngineService,
    NotificationQueue,
  ],
  exports: [NotificationsService, NotificationPreferencesService, NotificationActivityService]
})
export class NotificationsModule {}
