import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { MessageProcessingQueueService } from 'src/modules/outbound/message-processing-queue.service';

type AiAgentAttachment = {
  type: string;
  url: string;
  name: string;
  mimeType?: string;
};

type SendAiAgentReplyInput = {
  workspaceId: string;
  conversationId: string;
  channelId: string;
  text?: string | null;
  subject?: string | null;
  attachments?: AiAgentAttachment[];
  replyToMessageId?: string;
  metadata?: Record<string, any>;
};

@Injectable()
export class AiAgentOutboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processingQueue: MessageProcessingQueueService,
    private readonly events: EventEmitter2,
  ) {}

  async sendReply(input: SendAiAgentReplyInput) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, workspaceId: input.workspaceId },
      include: { contact: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    const channel = await this.prisma.channel.findFirst({
      where: { id: input.channelId, workspaceId: input.workspaceId },
    });
    if (!channel) throw new NotFoundException(`Channel ${input.channelId} not found`);

    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: { contactId: conversation.contactId, channelId: input.channelId },
    });
    const to = contactChannel?.identifier;
    if (!to) {
      throw new BadRequestException(
        `No ContactChannel found for contact ${conversation.contactId} on channel ${input.channelId}. Cannot send AI reply.`,
      );
    }

    const attachments = input.attachments ?? [];
    const message = await this.prisma.message.create({
      data: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        channelId: input.channelId,
        channelType: channel.type,
        type: input.metadata?.template ? 'template' : attachments.length ? attachments[0].type : 'text',
        direction: 'outgoing',
        text: input.text ?? null,
        subject: input.subject ?? null,
        status: 'pending',
        authorId: null,
        replyToChannelMsgId: input.replyToMessageId ?? input.metadata?.replyToMessageId ?? null,
        metadata: input.metadata ? (input.metadata as any) : undefined,
        sentAt: new Date(),
      },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        messageAttachments: true,
        channel: true,
      },
    });

    if (attachments.length) {
      await this.prisma.messageAttachment.createMany({
        data: attachments.map((attachment) => ({
          messageId: message.id,
          type: attachment.type,
          name: attachment.name,
          mimeType: attachment.mimeType ?? null,
          url: attachment.url,
        })),
      });
    }

    await this.prisma.conversation.update({
      where: { id: input.conversationId },
      data: {
        lastMessageId: message.id,
        lastMessageAt: new Date(),
      },
    });

    const queueEntry = await this.prisma.outboundQueue.create({
      data: {
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: message.id,
        to,
        payload: this.buildQueuePayload(channel.type, to, input),
        status: 'pending',
      },
    });

    await this.processingQueue.enqueueQueueEntry(queueEntry.id);

    this.events.emit('message.outbound', {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      message: this.formatMessage(message),
    });

    return this.formatMessage(message);
  }

  private buildQueuePayload(channelType: string, to: string, input: SendAiAgentReplyInput): Record<string, any> {
    const attachments = input.attachments ?? [];

    switch (channelType) {
      case 'whatsapp':
        if (input.metadata?.template) {
          return {
            to,
            template: {
              id: input.metadata.template.id,
              metaId: input.metadata.template.metaId,
              name: input.metadata.template.name,
              language: input.metadata.template.language,
              variables: input.metadata.template.variables ?? {},
            },
          };
        }
        return {
          messaging_product: 'whatsapp',
          to,
          ...(attachments.length
            ? {
                type: attachments[0].type === 'document' ? 'document' : attachments[0].type,
                [attachments[0].type === 'document' ? 'document' : attachments[0].type]: {
                  link: attachments[0].url,
                  ...(attachments[0].name ? { filename: attachments[0].name } : {}),
                  ...(input.text ? { caption: input.text } : {}),
                },
              }
            : {
                type: 'text',
                text: input.text ? { body: input.text } : undefined,
              }),
          ...(input.replyToMessageId ? { context: { message_id: input.replyToMessageId } } : {}),
        };
      case 'instagram':
      case 'messenger':
        if (input.metadata?.template) {
          return {
            to,
            template: {
              id: input.metadata.template.id,
              metaId: input.metadata.template.metaId,
              name: input.metadata.template.name,
              language: input.metadata.template.language,
              variables: input.metadata.template.variables ?? {},
            },
          };
        }
        return {
          recipient: { id: to },
          message: {
            ...(input.text ? { text: input.text } : {}),
            ...(attachments.length
              ? {
                  attachment: {
                    type: attachments[0].mimeType?.startsWith('image/')
                      ? 'image'
                      : attachments[0].mimeType?.startsWith('video/')
                        ? 'video'
                        : attachments[0].mimeType?.startsWith('audio/')
                          ? 'audio'
                          : 'file',
                    payload: {
                      url: attachments[0].url,
                      is_reusable: true,
                    },
                  },
                }
              : {}),
            ...(input.metadata?.quickReplies?.length
              ? {
                  quick_replies: input.metadata.quickReplies.map((qr: any) => ({
                    content_type: 'text',
                    title: qr.title,
                    payload: qr.payload,
                  })),
                }
              : {}),
          },
        };
      case 'email':
        return {
          to,
          subject: input.subject ?? input.metadata?.email?.subject ?? '',
          text: input.text,
          html: input.metadata?.htmlBody ?? input.metadata?.email?.htmlBody,
          headers: {
            ...(input.metadata?.email?.inReplyTo ? { 'In-Reply-To': input.metadata.email.inReplyTo } : {}),
            ...(input.metadata?.email?.references ? { References: input.metadata.email.references } : {}),
          },
          attachments,
        };
      default:
        return { to, text: input.text, attachments };
    }
  }

  private formatMessage(message: any) {
    return {
      id: message.id,
      conversationId: message.conversationId,
      channelId: message.channelId,
      channelType: message.channelType,
      type: message.type,
      direction: message.direction,
      text: message.text,
      subject: message.subject,
      status: message.status,
      createdAt: message.createdAt.toISOString(),
      sentAt: message.sentAt?.toISOString() ?? null,
      replyToChannelMsgId: message.replyToChannelMsgId ?? null,
      metadata: message.metadata,
      author: message.author
        ? {
            id: message.author.id,
            name: `${message.author.firstName ?? ''} ${message.author.lastName ?? ''}`.trim(),
            avatarUrl: message.author.avatarUrl,
          }
        : undefined,
      attachments: (message.messageAttachments ?? []).map((attachment: any) => ({
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        url: attachment.url,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
    };
  }
}
