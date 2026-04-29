import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  batchInsert,
  dateInRange,
  getFaker,
  randBetween,
  weightedPick,
} from './helpers';
import type {
  SeededChannel,
  SeededChannelType,
  SeedConfigResult,
} from './config';
import type { SeedUsersResult } from './users';

export type SeededContact = {
  id: string;
  createdAt: Date;
  assigneeId: string | null;
  workspaceMemberId: string | null;
  teamId: string | null;
  lifecycleId: string | null;
};

export type SeededContactChannel = {
  id: string;
  contactId: string;
  channelId: string;
  channelType: SeededChannelType;
  identifier: string;
};

export type SeedContactsDeps = SeedUsersResult &
  SeedConfigResult & {
    prisma: PrismaClient;
  };

export type SeedContactsResult = {
  contacts: SeededContact[];
  contactChannels: SeededContactChannel[];
  contactChannelByContactId: Map<string, SeededContactChannel>;
};

const CONTACT_COUNT = 300000;

function buildChannelIdentifier(
  channel: SeededChannel,
  email: string,
  phone: string,
  index: number,
): string {
  const faker = getFaker();

  if (channel.type === 'email') {
    return email;
  }

  if (channel.type === 'whatsapp') {
    return phone;
  }

  return `ig_${index + 1}_${faker.string.alphanumeric(10).toLowerCase()}`;
}

export async function seedContacts({
  prisma,
  workspaceId,
  agentIds,
  workspaceMemberByUserId,
  channels,
  teamIds,
  tagIds,
  lifecycleStageIds,
}: SeedContactsDeps): Promise<SeedContactsResult> {
  const faker = getFaker();
  const now = new Date();
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(now.getFullYear() - 2);
  const latestContactCreatedAt = new Date(
    now.getTime() - 1000 * 60 * 60 * 24 * 2,
  );

  const contactRows: Prisma.ContactCreateManyInput[] = [];
  const contactChannelRows: Prisma.ContactChannelCreateManyInput[] = [];
  const contactTagRows: Prisma.ContactTagCreateManyInput[] = [];
  const contacts: SeededContact[] = [];
  const contactChannels: SeededContactChannel[] = [];
  const contactChannelByContactId = new Map<string, SeededContactChannel>();

  for (let index = 0; index < CONTACT_COUNT; index += 1) {
    const id = randomUUID();
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const email = faker.internet
      .email({ firstName, lastName, provider: 'customer-mail.test' })
      .toLowerCase()
      .replace('@', `.${index + 1}@`);
    const phone = `+1555${(1000000 + index).toString()}${faker.string.numeric(2)}`;
    const createdAt = dateInRange(twoYearsAgo, latestContactCreatedAt);
    const updatedAt = dateInRange(createdAt, now);
    const assigned = Math.random() < 0.7;
    const assigneeId = assigned
      ? agentIds[randBetween(0, agentIds.length - 1)]
      : null;
    const workspaceMemberId = assigneeId
      ? (workspaceMemberByUserId.get(assigneeId) ?? null)
      : null;
    const teamId =
      assigned || Math.random() < 0.2
        ? teamIds[randBetween(0, teamIds.length - 1)]
        : null;
    const lifecycleId = weightedPick([
      { value: lifecycleStageIds[0], weight: 35 },
      { value: lifecycleStageIds[1], weight: 25 },
      { value: lifecycleStageIds[2], weight: 18 },
      { value: lifecycleStageIds[3], weight: 17 },
      { value: lifecycleStageIds[4], weight: 5 },
    ]);
    const status = weightedPick([
      { value: 'open', weight: 70 },
      { value: 'closed', weight: 30 },

    ]);
    const channel = channels[randBetween(0, channels.length - 1)];
    const contactChannelId = randomUUID();
    const identifier = buildChannelIdentifier(channel, email, phone, index);
    const channelLastMessageAt = dateInRange(createdAt, now);

    contactRows.push({
      id,
      workspaceId,
      firstName,
      lastName,
      email,
      phone,
      company: Math.random() < 0.72 ? faker.company.name() : null,
      avatarUrl: Math.random() < 0.78 ? faker.image.avatar() : null,
      createdAt,
      updatedAt,
      lifecycleId,
      status,
      marketingOptOut: Math.random() < 0.08,
      assigneeId,
      teamId,
      workspaceMemberId,
    });

    contactChannelRows.push({
      id: contactChannelId,
      workspaceId,
      contactId: id,
      channelId: channel.id,
      channelType: channel.type,
      identifier,
      displayName: `${firstName} ${lastName}`,
      avatarUrl: Math.random() < 0.65 ? faker.image.avatar() : null,
      profileRaw: {
        source: 'seed',
        locale: weightedPick([
          { value: 'en_US', weight: 60 },
          { value: 'en_IN', weight: 30 },
          { value: 'hi_IN', weight: 10 },
        ]),
      },
      lastMessageTime: BigInt(channelLastMessageAt.getTime()),
      lastIncomingMessageTime: BigInt(
        dateInRange(createdAt, channelLastMessageAt).getTime(),
      ),
      messageWindowExpiry: BigInt(
        channelLastMessageAt.getTime() + 1000 * 60 * 60 * 24,
      ),
      conversationWindowCategory: {
        category: channel.type === 'whatsapp' ? 'service' : 'standard',
      },
      call_permission: channel.type === 'whatsapp' ? Math.random() < 0.4 : null,
      hasPermanentCallPermission:
        channel.type === 'whatsapp' && Math.random() < 0.1,
      createdAt,
      updatedAt,
    });

    const contactChannelSummary: SeededContactChannel = {
      id: contactChannelId,
      contactId: id,
      channelId: channel.id,
      channelType: channel.type,
      identifier,
    };

    contacts.push({
      id,
      createdAt,
      assigneeId,
      workspaceMemberId,
      teamId,
      lifecycleId,
    });
    contactChannels.push(contactChannelSummary);
    contactChannelByContactId.set(id, contactChannelSummary);

    const tagCount = weightedPick([
      { value: 0, weight: 35 },
      { value: 1, weight: 38 },
      { value: 2, weight: 20 },
      { value: 3, weight: 7 },
    ]);
    const selectedTagIds = new Set<string>();

    while (selectedTagIds.size < tagCount) {
      selectedTagIds.add(tagIds[randBetween(0, tagIds.length - 1)]);
    }

    selectedTagIds.forEach((tagId) => {
      contactTagRows.push({
        contactId: id,
        tagId,
      });
    });
  }

  await batchInsert<Prisma.ContactCreateManyInput>(prisma.contact, contactRows);
  await batchInsert<Prisma.ContactChannelCreateManyInput>(
    prisma.contactChannel,
    contactChannelRows,
  );
  await batchInsert<Prisma.ContactTagCreateManyInput>(
    prisma.contactTag,
    contactTagRows,
  );

  return {
    contacts,
    contactChannels,
    contactChannelByContactId,
  };
}
