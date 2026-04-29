import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  batchInsert,
  dateInRange,
  getFaker,
  randBetween,
  weightedPick,
} from './helpers';
import type { SeedContactsResult, SeededContact } from './contacts';
import type { SeededChannelType } from './config';
import type { SeedUsersResult } from './users';

export type ConversationStatus = 'open' | 'resolved' | 'pending';
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type SeededConversation = {
  id: string;
  contactId: string;
  channelId: string;
  channelType: SeededChannelType;
  contactIdentifier: string;
  createdAt: Date;
  lastMessageAt: Date;
  status: ConversationStatus;
  priority: ConversationPriority;
  messageCount: number;
  assigneeId: string | null;
  teamId: string | null;
};

export type SeedConversationsDeps = SeedUsersResult &
  SeedContactsResult & {
    prisma: PrismaClient;
  };

export type SeedConversationsResult = {
  conversations: SeededConversation[];
};

const CONVERSATION_COUNT = 10000;
const MESSAGE_COUNT = 2000000;
const MIN_MESSAGES_PER_CONVERSATION = 100;
const MAX_MESSAGES_PER_CONVERSATION = 200;

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = randBetween(0, index);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function allocateMessageCounts(
  totalConversations: number,
  totalMessages: number,
): number[] {
  const counts = Array.from(
    { length: totalConversations },
    () => MIN_MESSAGES_PER_CONVERSATION,
  );
  let remaining =
    totalMessages - totalConversations * MIN_MESSAGES_PER_CONVERSATION;
  const availableIndexes = Array.from(
    { length: totalConversations },
    (_, index) => index,
  );

  if (
    remaining < 0 ||
    totalMessages > totalConversations * MAX_MESSAGES_PER_CONVERSATION
  ) {
    throw new Error(
      'Cannot allocate the requested message volume across conversations',
    );
  }

  while (remaining > 0) {
    const availablePosition = randBetween(0, availableIndexes.length - 1);
    const conversationIndex = availableIndexes[availablePosition];
    counts[conversationIndex] += 1;
    remaining -= 1;

    if (counts[conversationIndex] === MAX_MESSAGES_PER_CONVERSATION) {
      availableIndexes.splice(availablePosition, 1);
    }
  }

  return shuffle(counts);
}

function selectConversationContacts(
  contacts: SeededContact[],
): SeededContact[] {
  if (contacts.length > CONVERSATION_COUNT) {
    return shuffle(contacts).slice(0, CONVERSATION_COUNT);
  }

  const extraConversationCount = CONVERSATION_COUNT - contacts.length;
  const contactsWithSecondConversation = shuffle(contacts).slice(
    0,
    extraConversationCount,
  );

  return shuffle([...contacts, ...contactsWithSecondConversation]);
}

function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

export async function seedConversations({
  prisma,
  workspaceId,
  contacts,
  contactChannelByContactId,
}: SeedConversationsDeps): Promise<SeedConversationsResult> {
  const faker = getFaker();
  const now = new Date();
  const latestConversationCreatedAt = new Date(
    now.getTime() - 1000 * 60 * 60 * 12,
  );
  const messageCounts = allocateMessageCounts(
    CONVERSATION_COUNT,
    MESSAGE_COUNT,
  );
  const selectedContacts = selectConversationContacts(contacts);
  const conversationRows: Prisma.ConversationCreateManyInput[] = [];
  const conversations: SeededConversation[] = [];

  selectedContacts.forEach((contact, index) => {
    const contactChannel = contactChannelByContactId.get(contact.id);

    if (!contactChannel) {
      throw new Error(`Missing contact channel for contact ${contact.id}`);
    }

    const createdAt = dateInRange(
      contact.createdAt,
      latestConversationCreatedAt,
    );
    const lastMessageAt = dateInRange(
      addMilliseconds(createdAt, 1000 * 60),
      now,
    );
    const status = weightedPick<ConversationStatus>([
      { value: 'open', weight: 60 },
      { value: 'resolved', weight: 25 },
      { value: 'pending', weight: 15 },
    ]);
    const priority = weightedPick<ConversationPriority>([
      { value: 'normal', weight: 50 },
      { value: 'high', weight: 25 },
      { value: 'low', weight: 15 },
      { value: 'urgent', weight: 10 },
    ]);
    const resolvedAt =
      status === 'resolved' ? dateInRange(lastMessageAt, now) : null;
    const firstResponseAt =
      messageCounts[index] > 1
        ? dateInRange(addMilliseconds(createdAt, 1000 * 60), lastMessageAt)
        : null;
    const slaDueAt = addMilliseconds(
      createdAt,
      1000 * 60 * 60 * randBetween(2, 48),
    );
    const slaBreached =
      slaDueAt < now && status !== 'resolved' && Math.random() < 0.12;
    const subject =
      contactChannel.channelType === 'email'
        ? faker.lorem
            .words(randBetween(4, 9))
            .replace(/^\w/, (letter) => letter.toUpperCase())
        : null;
    const conversationId = randomUUID();

    conversationRows.push({
      id: conversationId,
      workspaceId,
      contactId: contact.id,
      subject,
      status,
      lastMessageAt,
      lastIncomingAt: dateInRange(createdAt, lastMessageAt),
      unreadCount: 0,
      slaDueAt,
      slaBreached,
      priority,
      firstResponseAt,
      resolvedAt,
      createdAt,
      updatedAt: resolvedAt ?? lastMessageAt,
    });

    conversations.push({
      id: conversationId,
      contactId: contact.id,
      channelId: contactChannel.channelId,
      channelType: contactChannel.channelType,
      contactIdentifier: contactChannel.identifier,
      createdAt,
      lastMessageAt,
      status,
      priority,
      messageCount: messageCounts[index],
      assigneeId: contact.assigneeId,
      teamId: contact.teamId,
    });
  });

  await batchInsert<Prisma.ConversationCreateManyInput>(
    prisma.conversation,
    conversationRows,
  );

  return {
    conversations,
  };
}
