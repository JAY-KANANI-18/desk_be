jest.mock('../media/media.service', () => ({
  MediaService: class MediaService {},
}));

import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { InboundService } from './inbound.service';

function createService() {
  const prisma = {
    contact: {
      create: jest.fn(),
      update: jest.fn(),
    },
    contactChannel: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    conversation: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    message: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    messageAttachment: {
      createMany: jest.fn(),
    },
  };
  const media = {
    processAttachments: jest.fn().mockResolvedValue([]),
  };
  const emitter = {
    emit: jest.fn(),
  };

  const service = new InboundService(
    prisma as unknown as PrismaService,
    media as unknown as MediaService,
    emitter as unknown as EventEmitter2,
  );

  return { prisma, media, emitter, service };
}

describe('InboundService workflow trigger events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits conversation.opened with the real conversation id after reopening a closed contact', async () => {
    const { prisma, emitter, service } = createService();
    const contact = {
      id: 'contact-1',
      workspaceId: 'workspace-1',
      firstName: 'Jay',
      lastName: 'Kanani',
      phone: '919999999999',
      email: null,
      status: 'closed',
      avatarUrl: null,
    };
    const contactChannel = {
      id: 'contact-channel-1',
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      channelType: 'instagram',
      identifier: 'ig-user-1',
      contact,
    };
    const conversation = {
      id: 'conversation-1',
      workspaceId: 'workspace-1',
      contactId: 'contact-1',
    };
    const message = {
      id: 'message-1',
      workspaceId: 'workspace-1',
      conversationId: 'conversation-1',
      direction: 'incoming',
      type: 'text',
      text: 'Hi',
    };

    prisma.contactChannel.findFirst.mockResolvedValue(contactChannel);
    prisma.contact.update.mockResolvedValue({ ...contact, status: 'open' });
    prisma.conversation.findFirst.mockResolvedValue(conversation);
    prisma.conversation.update
      .mockResolvedValueOnce(conversation)
      .mockResolvedValueOnce({ ...conversation, lastMessageId: 'message-1' });
    prisma.message.create.mockResolvedValue(message);
    prisma.contactChannel.update.mockResolvedValue(contactChannel);

    await service.process({
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      channelType: 'instagram',
      contactIdentifier: 'ig-user-1',
      direction: 'incoming',
      messageType: 'text',
      text: 'Hi',
      channelMsgId: 'provider-message-1',
    });

    expect(emitter.emit).toHaveBeenCalledWith('conversation.opened', {
      workspaceId: 'workspace-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      source: 'contact',
      channel: 'instagram',
    });
    expect(emitter.emit).not.toHaveBeenCalledWith(
      'conversation.opened',
      expect.objectContaining({ conversationId: null }),
    );
    expect(emitter.emit).toHaveBeenCalledWith('message.inbound', {
      workspaceId: 'workspace-1',
      conversationId: 'conversation-1',
      message,
    });
  });
});
