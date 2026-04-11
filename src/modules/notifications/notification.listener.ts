import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationListener {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent('message.inbound')
  async handleMessageInbound(event: {
    workspaceId: string;
    conversationId: string;
    message: {
      id: string;
      text?: string | null;
      subject?: string | null;
      type?: string | null;
    };
  }) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: event.conversationId },
      include: {
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            assigneeId: true,
            teamId: true,
          },
        },
      },
    });

    if (!conversation) {
      return;
    }

    const recipientIds = conversation.contact.assigneeId
      ? [conversation.contact.assigneeId]
      : conversation.contact.teamId
        ? (await this.prisma.teamMember.findMany({
          where: { teamId: conversation.contact.teamId },
          select: { userId: true },
        })).map((member) => member.userId)
        : [];

    if (recipientIds.length === 0) {
      return;
    }

    const contactName = [conversation.contact.firstName, conversation.contact.lastName]
      .filter(Boolean)
      .join(' ')
      .trim() || conversation.contact.email || conversation.contact.phone || 'a contact';
    const preview = (event.message.text || event.message.subject || event.message.type || 'New incoming message').trim();

    await Promise.all(
      Array.from(new Set(recipientIds)).map((userId) =>
        this.notifications.ingest({
          userId,
          workspaceId: event.workspaceId,
          type: NotificationType.NEW_INCOMING_MESSAGE,
          title: `New message from ${contactName}`,
          body: preview.length > 180 ? `${preview.slice(0, 180)}...` : preview,
          metadata: {
            contactId: conversation.contact.id,
            conversationId: conversation.id,
            messageId: event.message.id,
          },
          sourceEntityType: 'message',
          sourceEntityId: event.message.id,
          dedupeKey: `inbound-message:${event.message.id}:${userId}`,
          target: {
            assigneeId: conversation.contact.assigneeId,
            contactId: conversation.contact.id,
            conversationId: conversation.id,
          },
        }),
      ),
    );
  }
}
