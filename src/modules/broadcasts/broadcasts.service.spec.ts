import { PrismaService } from '../../prisma/prisma.service';
import { MessageProcessingQueueService } from '../outbound/message-processing-queue.service';
import { BroadcastsService } from './broadcasts.service';

type SnapshotAudienceTestApi = {
  snapshotAudience(opts: {
    workspaceId: string;
    channel: { id: string; type: string };
    filters: { tagIds?: string[]; respectMarketingOptOut?: boolean };
    take: number;
  }): Promise<Array<{ id: string; contactId: string; identifier: string }>>;
};

function createService() {
  const prisma = {
    channel: {
      findFirst: jest.fn(),
    },
    contact: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    contactChannel: {
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    broadcastRun: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    broadcastRecipient: {
      count: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
      updateMany: jest.fn(),
    },
    message: {
      count: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
    },
    conversation: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    emailUnsubscribeToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const processingQueue = {
    enqueueSendMessage: jest.fn(),
  };

  return {
    prisma,
    processingQueue,
    service: new BroadcastsService(
      prisma as unknown as PrismaService,
      processingQueue as unknown as MessageProcessingQueueService,
    ),
  };
}

describe('BroadcastsService contact-field audience', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('previews email contacts from Contact.email when no ContactChannel exists', async () => {
    const { prisma, service } = createService();
    prisma.channel.findFirst.mockResolvedValue({
      id: 'channel-1',
      workspaceId: 'workspace-1',
      type: 'email',
    });
    prisma.contact.count.mockResolvedValue(1);
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 'contact-1',
        firstName: 'Manasvi',
        lastName: 'Jain',
        phone: null,
        email: 'MANASVI.JAIN@4700BC.COM',
        contactChannels: [],
      },
    ]);

    const result = await service.previewAudience({
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      filters: { tagIds: ['tag-priority'] },
    });

    expect(prisma.contactChannel.count).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      channelId: 'channel-1',
      channelType: 'email',
      totalMatching: 1,
      previewCount: 1,
      sample: [
        {
          contactId: 'contact-1',
          identifier: 'manasvi.jain@4700bc.com',
          name: 'Manasvi Jain',
        },
      ],
    });
  });

  it('creates a missing email ContactChannel when snapshotting an email broadcast', async () => {
    const { prisma, service } = createService();
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 'contact-1',
        workspaceId: 'workspace-1',
        firstName: 'Manasvi',
        lastName: 'Jain',
        phone: null,
        email: 'MANASVI.JAIN@4700BC.COM',
        contactChannels: [],
      },
    ]);
    prisma.contactChannel.findFirst.mockResolvedValue(null);
    prisma.contactChannel.create.mockResolvedValue({
      id: 'contact-channel-1',
      workspaceId: 'workspace-1',
      contactId: 'contact-1',
      channelId: 'channel-1',
      channelType: 'email',
      identifier: 'manasvi.jain@4700bc.com',
      createdAt: new Date('2026-05-12T00:00:00.000Z'),
      contact: {
        id: 'contact-1',
        firstName: 'Manasvi',
        lastName: 'Jain',
        phone: null,
        email: 'MANASVI.JAIN@4700BC.COM',
      },
    });

    const result = await (service as unknown as SnapshotAudienceTestApi).snapshotAudience({
      workspaceId: 'workspace-1',
      channel: { id: 'channel-1', type: 'email' },
      filters: { tagIds: ['tag-priority'] },
      take: 200,
    });

    expect(prisma.contactChannel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'workspace-1',
          contactId: 'contact-1',
          channelId: 'channel-1',
          channelType: 'email',
          identifier: 'manasvi.jain@4700bc.com',
        }),
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: 'contact-channel-1',
        contactId: 'contact-1',
        identifier: 'manasvi.jain@4700bc.com',
      }),
    ]);
  });

  it('previews WhatsApp contacts from Contact.phone when no ContactChannel exists', async () => {
    const { prisma, service } = createService();
    prisma.channel.findFirst.mockResolvedValue({
      id: 'channel-1',
      workspaceId: 'workspace-1',
      type: 'whatsapp',
    });
    prisma.contact.count.mockResolvedValue(2);
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 'contact-1',
        firstName: 'Jay',
        lastName: 'Kanani',
        phone: '916353969157',
        email: 'jaykanani1999@gmail.com',
        contactChannels: [],
      },
      {
        id: 'contact-2',
        firstName: 'Jaykanani28887',
        lastName: null,
        phone: '+91 70437 14531',
        email: 'jaykanani28887@gmail.com',
        contactChannels: [],
      },
    ]);

    const result = await service.previewAudience({
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      filters: { tagIds: ['tag-jaybhai'] },
    });

    expect(prisma.contactChannel.count).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      channelId: 'channel-1',
      channelType: 'whatsapp',
      totalMatching: 2,
      previewCount: 2,
      sample: [
        {
          contactId: 'contact-1',
          identifier: '916353969157',
          name: 'Jay Kanani',
        },
        {
          contactId: 'contact-2',
          identifier: '917043714531',
          name: 'Jaykanani28887',
        },
      ],
    });
  });

  it('creates a missing WhatsApp ContactChannel when snapshotting a WhatsApp broadcast', async () => {
    const { prisma, service } = createService();
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 'contact-1',
        workspaceId: 'workspace-1',
        firstName: 'Jay',
        lastName: 'Kanani',
        phone: '+91 63539 69157',
        email: 'jaykanani1999@gmail.com',
        contactChannels: [],
      },
    ]);
    prisma.contactChannel.findFirst.mockResolvedValue(null);
    prisma.contactChannel.create.mockResolvedValue({
      id: 'contact-channel-1',
      workspaceId: 'workspace-1',
      contactId: 'contact-1',
      channelId: 'channel-1',
      channelType: 'whatsapp',
      identifier: '916353969157',
      createdAt: new Date('2026-05-12T00:00:00.000Z'),
      contact: {
        id: 'contact-1',
        firstName: 'Jay',
        lastName: 'Kanani',
        phone: '+91 63539 69157',
        email: 'jaykanani1999@gmail.com',
      },
    });

    const result = await (service as unknown as SnapshotAudienceTestApi).snapshotAudience({
      workspaceId: 'workspace-1',
      channel: { id: 'channel-1', type: 'whatsapp' },
      filters: { tagIds: ['tag-jaybhai'] },
      take: 200,
    });

    expect(prisma.contactChannel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'workspace-1',
          contactId: 'contact-1',
          channelId: 'channel-1',
          channelType: 'whatsapp',
          identifier: '916353969157',
        }),
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: 'contact-channel-1',
        contactId: 'contact-1',
        identifier: '916353969157',
      }),
    ]);
  });

  it('reuses an existing WhatsApp ContactChannel from a duplicate contact without dropping the tagged contact', async () => {
    const { prisma, service } = createService();
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 'tagged-contact',
        workspaceId: 'workspace-1',
        firstName: 'Jaykanani1999',
        lastName: null,
        phone: '916353969157',
        email: 'jaykanani1999@gmail.com',
        contactChannels: [],
      },
    ]);
    prisma.contactChannel.findFirst.mockResolvedValue({
      id: 'existing-contact-channel',
      workspaceId: 'workspace-1',
      contactId: 'duplicate-contact',
      channelId: 'channel-1',
      channelType: 'whatsapp',
      identifier: '916353969157',
      createdAt: new Date('2026-05-12T00:00:00.000Z'),
      contact: {
        id: 'duplicate-contact',
        firstName: 'Jay',
        lastName: 'Kanani',
        phone: '916353969157',
        email: null,
      },
    });

    const result = await (service as unknown as SnapshotAudienceTestApi).snapshotAudience({
      workspaceId: 'workspace-1',
      channel: { id: 'channel-1', type: 'whatsapp' },
      filters: { tagIds: ['tag-jaybhai'] },
      take: 200,
    });

    expect(prisma.contactChannel.create).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        id: 'existing-contact-channel',
        contactId: 'tagged-contact',
        identifier: '916353969157',
      }),
    ]);
  });
});

describe('BroadcastsService trace pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters recipient trace rows on the backend and returns pagination metadata', async () => {
    const { prisma, service } = createService();
    const createdAt = new Date('2026-05-12T13:37:00.000Z');
    prisma.broadcastRun.findFirst.mockResolvedValue({
      id: 'run-1',
      workspaceId: 'workspace-1',
      name: 'May broadcast',
      channelId: 'channel-1',
      channel: { id: 'channel-1', name: 'WhatsApp', type: 'whatsapp', identifier: '123' },
    });
    prisma.broadcastRecipient.count
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2);
    prisma.broadcastRecipient.findMany.mockResolvedValue([
      {
        id: 'recipient-1',
        conversationId: null,
        contactId: 'contact-1',
        identifier: '917043714531',
        status: 'dead_letter',
        attempts: 3,
        maxRetries: 3,
        lastError: 'Recipient phone number not in allowed list',
        providerMessageId: null,
        renderedText: null,
        createdAt,
        sentAt: null,
        deliveredAt: null,
        readAt: null,
        contact: {
          id: 'contact-1',
          firstName: 'Jay',
          lastName: null,
          phone: '917043714531',
          email: null,
        },
        message: null,
      },
    ]);

    const result = await service.getRunTrace('workspace-1', 'run-1', {
      status: 'attention',
      page: 2,
      take: 1,
    });

    expect(prisma.broadcastRecipient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 1,
        take: 1,
        where: expect.objectContaining({
          workspaceId: 'workspace-1',
          broadcastRunId: 'run-1',
          OR: expect.any(Array),
        }),
      }),
    );
    expect(result).toMatchObject({
      broadcastRunId: 'run-1',
      limit: 1,
      page: 2,
      total: 5,
      filteredTotal: 2,
      totalPages: 2,
      status: 'attention',
      rows: [
        {
          recipientId: 'recipient-1',
          recipient: 'Jay',
          identifier: '917043714531',
          messageStatus: 'dead_letter',
          queueStatus: 'dead_letter',
        },
      ],
    });
  });
});
