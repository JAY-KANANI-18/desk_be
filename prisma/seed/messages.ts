import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { batchInsert, getFaker, randBetween, weightedPick } from './helpers';
import type {
  SeedConversationsResult,
  SeededConversation,
} from './conversations';
import type { SeedUsersResult } from './users';

export type SeedMessagesDeps = SeedUsersResult &
  SeedConversationsResult & {
    prisma: PrismaClient;
  };

export type SeedMessagesResult = {
  messageIdsByConversationId: Map<string, string[]>;
  messageCount: number;
  attachmentCount: number;
};

type AttachmentSeed = {
  messageType: string;
  attachment: Omit<
    Prisma.MessageAttachmentCreateManyInput,
    'messageId' | 'createdAt'
  >;
};

const SUPPORT_TOPICS = [
  'pricing plan',
  'invoice',
  'workspace setup',
  'WhatsApp connection',
  'Instagram messages',
  'team assignment',
  'imported contacts',
  'automation workflow',
  'message delivery',
  'account access',
];

function buildMessageText(direction: 'incoming' | 'outgoing'): string {
  const faker = getFaker();
  const topic = SUPPORT_TOPICS[randBetween(0, SUPPORT_TOPICS.length - 1)];

  if (direction === 'incoming') {
    return weightedPick([
      {
        value: `Hi, I need help with our ${topic}. ${faker.lorem.sentence()}`,
        weight: 35,
      },
      { value: `Can someone check the ${topic} for our account?`, weight: 20 },
      {
        value: `We are seeing an issue with ${topic}. ${faker.lorem.sentence()}`,
        weight: 25,
      },
      {
        value: `Quick question about ${topic}: ${faker.lorem.sentence()}`,
        weight: 20,
      },
    ]);
  }

  return weightedPick([
    {
      value: `Thanks for reaching out. I checked the ${topic} and can help with that.`,
      weight: 30,
    },
    {
      value: `I have made an update on our side. Please try the ${topic} again.`,
      weight: 25,
    },
    {
      value: `Got it. I am sharing the next steps for your ${topic}. ${faker.lorem.sentence()}`,
      weight: 25,
    },
    {
      value: `That makes sense. I will keep this conversation updated as we review the ${topic}.`,
      weight: 20,
    },
  ]);
}

function buildAttachment(messageId: string): AttachmentSeed {
  const faker = getFaker();
  const type = weightedPick([
    { value: 'image', weight: 45 },
    { value: 'document', weight: 30 },
    { value: 'audio', weight: 15 },
    { value: 'video', weight: 10 },
  ]);
  const fileId = faker.string.alphanumeric(16).toLowerCase();

  if (type === 'image') {
    return {
      messageType: 'image',
      attachment: {
        id: randomUUID(),
        type,
        name: `screenshot-${fileId}.png`,
        mimeType: 'image/png',
        size: randBetween(80_000, 2_500_000),
        width: randBetween(900, 2400),
        height: randBetween(700, 1800),
        url: `https://cdn.axodesk-demo.local/messages/${messageId}/${fileId}.png`,
        providerUrl: `https://provider-media.example/${fileId}`,
        externalMediaId: `media_${fileId}`,
        metadata: {
          caption: faker.lorem.sentence(),
        },
      },
    };
  }

  if (type === 'document') {
    const filename = `${faker.system.commonFileName('pdf')}`;

    return {
      messageType: 'document',
      attachment: {
        id: randomUUID(),
        type,
        name: filename,
        mimeType: 'application/pdf',
        size: randBetween(120_000, 5_000_000),
        url: `https://cdn.axodesk-demo.local/messages/${messageId}/${fileId}.pdf`,
        providerUrl: `https://provider-media.example/${fileId}`,
        externalMediaId: `media_${fileId}`,
        metadata: {
          filename,
          pageCount: randBetween(1, 24),
        },
      },
    };
  }

  if (type === 'audio') {
    return {
      messageType: 'audio',
      attachment: {
        id: randomUUID(),
        type,
        name: `voice-note-${fileId}.mp3`,
        mimeType: 'audio/mpeg',
        size: randBetween(60_000, 900_000),
        duration: randBetween(8, 120),
        url: `https://cdn.axodesk-demo.local/messages/${messageId}/${fileId}.mp3`,
        providerUrl: `https://provider-media.example/${fileId}`,
        externalMediaId: `media_${fileId}`,
        metadata: {
          transcriptPreview: faker.lorem.sentence(),
        },
      },
    };
  }

  return {
    messageType: 'video',
    attachment: {
      id: randomUUID(),
      type,
      name: `walkthrough-${fileId}.mp4`,
      mimeType: 'video/mp4',
      size: randBetween(1_000_000, 18_000_000),
      duration: randBetween(12, 180),
      width: 1280,
      height: 720,
      url: `https://cdn.axodesk-demo.local/messages/${messageId}/${fileId}.mp4`,
      providerUrl: `https://provider-media.example/${fileId}`,
      externalMediaId: `media_${fileId}`,
      metadata: {
        caption: faker.lorem.sentence(),
      },
    },
  };
}

function messageCreatedAt(
  conversation: SeededConversation,
  messageIndex: number,
): Date {
  const startMs = conversation.createdAt.getTime();
  const endMs = conversation.lastMessageAt.getTime();
  const ratio = (messageIndex + 1) / conversation.messageCount;

  return new Date(startMs + Math.floor((endMs - startMs) * ratio));
}

export async function seedMessages({
  prisma,
  workspaceId,
  agentIds,
  conversations,
}: SeedMessagesDeps): Promise<SeedMessagesResult> {
  const faker = getFaker();
  const messageRows: Prisma.MessageCreateManyInput[] = [];
  const attachmentRows: Prisma.MessageAttachmentCreateManyInput[] = [];
  const messageIdsByConversationId = new Map<string, string[]>();

  conversations.forEach((conversation) => {
    const conversationMessageIds: string[] = [];

    for (let index = 0; index < conversation.messageCount; index += 1) {
      const id = randomUUID();
      const direction = index % 2 === 0 ? 'incoming' : 'outgoing';
      const createdAt = messageCreatedAt(conversation, index);
      const hasAttachment = Math.random() < 0.12;
      const attachmentSeed = hasAttachment ? buildAttachment(id) : null;
      const isEmail = conversation.channelType === 'email';
      const channelMsgId =
        Math.random() < 0.2
          ? `provider_${conversation.channelType}_${randomUUID()}`
          : null;
      const authorId =
        direction === 'outgoing'
          ? agentIds[randBetween(0, agentIds.length - 1)]
          : null;
      const status =
        direction === 'incoming'
          ? weightedPick([
              { value: 'delivered', weight: 45 },
              { value: 'read', weight: 55 },
            ])
          : weightedPick([
              { value: 'sent', weight: 25 },
              { value: 'delivered', weight: 40 },
              { value: 'read', weight: 30 },
              { value: 'failed', weight: 5 },
            ]);

      messageRows.push({
        id,
        workspaceId,
        conversationId: conversation.id,
        channelId: conversation.channelId,
        channelType: conversation.channelType,
        type: attachmentSeed?.messageType ?? (isEmail ? 'email' : 'text'),
        direction,
        text: buildMessageText(direction),
        subject:
          isEmail && index === 0 ? faker.lorem.words(randBetween(4, 8)) : null,
        channelMsgId,
        authorId,
        status,
        rawPayload: {
          seeded: true,
          provider: conversation.channelType,
          recipient: conversation.contactIdentifier,
          providerMessageId: channelMsgId,
        },
        metadata: isEmail
          ? {
              htmlBody: `<p>${faker.lorem.sentences(randBetween(1, 3))}</p>`,
              headers: {
                'x-seed-source': 'axodesk-prisma-seed',
              },
            }
          : {
              sentiment: weightedPick([
                { value: 'neutral', weight: 55 },
                { value: 'positive', weight: 25 },
                { value: 'negative', weight: 20 },
              ]),
            },
        createdAt,
        sentAt: direction === 'outgoing' ? createdAt : null,
      });

      if (attachmentSeed) {
        attachmentRows.push({
          ...attachmentSeed.attachment,
          messageId: id,
          createdAt,
        });
      }

      conversationMessageIds.push(id);
    }

    messageIdsByConversationId.set(conversation.id, conversationMessageIds);
  });

  await batchInsert<Prisma.MessageCreateManyInput>(prisma.message, messageRows);
  await batchInsert<Prisma.MessageAttachmentCreateManyInput>(
    prisma.messageAttachment,
    attachmentRows,
  );

  return {
    messageIdsByConversationId,
    messageCount: messageRows.length,
    attachmentCount: attachmentRows.length,
  };
}
