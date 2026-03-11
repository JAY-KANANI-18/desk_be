import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationListener } from './notification.listener';
import { NotificationPreferencesService } from './notification-preferences.service';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { NotificationQueue } from 'src/queues/notification.queue';

@Module({
    imports: [RealtimeModule],
  providers: [
    NotificationsService,
    NotificationListener,
    NotificationPreferencesService,
    NotificationQueue
  ],
  exports: [NotificationsService]
})
export class NotificationsModule {}