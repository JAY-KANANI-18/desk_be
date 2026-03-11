import { Injectable } from '@nestjs/common';
import { RealtimeService } from '../../realtime/realtime.service';
import { PrismaService } from 'prisma/prisma.service';
import { NotificationQueue } from 'src/queues/notification.queue';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationType } from '@prisma/client';

@Injectable()
export class NotificationsService {

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
      private notificationQueue: NotificationQueue,
        private preferences: NotificationPreferencesService

    
  ) {}

 async createNotification(data: {
  userId: string
  workspaceId: string
  email: string
  type: NotificationType
  title: string
  body: string
}) {

  const prefs = await this.preferences.getUserPreferences(data.userId)

  // store in-app notification
  const notification = await this.prisma.notification.create({
    data: {
      userId: data.userId,
    //   workspaceId: data.workspaceId,
      type: data.type,
      title: data.title,
      body: data.body
    }
  })

  // email preference check
  let shouldSendEmail = false

  switch (data.type) {

    case "NEW_MESSAGE":
      shouldSendEmail = prefs.emailNewMessage
      break

    case "MENTION":
      shouldSendEmail = prefs.emailMention
      break

    case "ASSIGNED":
      shouldSendEmail = prefs.emailAssignment
      break

    // case "WORKFLOW_UPDATE":
    //   shouldSendEmail = prefs.emailWorkflow
    //   break

    // case "BROADCAST_STATUS":
    //   shouldSendEmail = prefs.emailBroadcast
    //   break
  }

  if (shouldSendEmail) {

    await this.notificationQueue.addEmailNotification({
      email: data.email,
      subject: data.title,
      body: data.body
    })

  }

  return notification
}
}