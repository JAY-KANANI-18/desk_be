import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from './notifications.service';
import { MessageCreatedEvent } from '../../events/message-created.event';
import { NotificationType } from '@prisma/client';

@Injectable()
export class NotificationListener {

  constructor(
    private notifications: NotificationsService
  ) {}

  @OnEvent('message.created')
  async handleMessageCreated(event: MessageCreatedEvent) {



      await this.notifications.createNotification({
        userId: event.senderId,
        workspaceId: event.workspaceId,
        type: NotificationType.NEW_MESSAGE,
        email: event.assigneeEmail,
        title: "New message",
        body: "You received a new message",
        // payload: {
        //   conversationId: event.conversationId,
        //   messageId: event.messageId
        // }
      })

    

  }
}