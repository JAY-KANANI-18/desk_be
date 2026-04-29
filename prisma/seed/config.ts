import { Prisma, PrismaClient, StageType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { batchInsert, dateInRange, getFaker } from './helpers';
import type { SeedUsersResult } from './users';

export type SeededChannelType = 'whatsapp' | 'instagram' | 'email';

export type SeededChannel = {
  id: string;
  type: SeededChannelType;
  name: string;
};

export type SeedConfigDeps = SeedUsersResult & {
  prisma: PrismaClient;
};

export type SeedConfigResult = {
  channels: SeededChannel[];
  teamIds: string[];
  tagIds: string[];
  lifecycleStageIds: string[];
};

export async function seedConfig({
  prisma,
  workspaceId,
  agentIds,
}: SeedConfigDeps): Promise<SeedConfigResult> {
  const faker = getFaker();
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);

  const channels: SeededChannel[] = [
    {
      id: randomUUID(),
      type: 'whatsapp',
      name: 'WhatsApp Support',
    },
    {
      id: randomUUID(),
      type: 'instagram',
      name: 'Instagram Inbox',
    },
    {
      id: randomUUID(),
      type: 'email',
      name: 'Email Support',
    },
  ];

  const channelRows: Prisma.ChannelCreateManyInput[] = channels.map(
    (channel) => ({
      id: channel.id,
      workspaceId,
      type: channel.type,
      name: channel.name,
      identifier:
        channel.type === 'email'
          ? `support@${faker.internet.domainName()}`
          : `${channel.type}-${faker.string.numeric(10)}`,
      status: 'connected',
      createdAt: dateInRange(oneYearAgo, now),
      credentials: {
        seeded: true,
        provider: channel.type,
        accountId: faker.string.uuid(),
      },
      config: {
        autoReply: channel.type !== 'email',
        businessHours: {
          timezone: 'Asia/Kolkata',
          weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
        },
      },
    }),
  );

  const teamDefinitions = [
    { id: randomUUID(), name: 'Support' },
    { id: randomUUID(), name: 'Sales' },
    { id: randomUUID(), name: 'Customer Success' },
  ];

  const teamRows: Prisma.TeamCreateManyInput[] = teamDefinitions.map(
    (team) => ({
      id: team.id,
      workspaceId,
      name: team.name,
      createdAt: dateInRange(oneYearAgo, now),
    }),
  );

  const teamMemberRows: Prisma.TeamMemberCreateManyInput[] = [];
  agentIds.forEach((userId, index) => {
    teamMemberRows.push({
      id: randomUUID(),
      teamId: teamDefinitions[index % teamDefinitions.length].id,
      userId,
    });

    if (index < 6 && index % teamDefinitions.length !== 0) {
      teamMemberRows.push({
        id: randomUUID(),
        teamId: teamDefinitions[0].id,
        userId,
      });
    }
  });

  const tagDefinitions = [
    {
      name: 'VIP',
      color: 'tag-amber',
      description: 'High-value accounts and strategic customers',
    },
    {
      name: 'Trial',
      color: 'tag-blue',
      description: 'Contacts evaluating the product',
    },
    {
      name: 'Billing',
      color: 'tag-emerald',
      description: 'Billing, renewal, and invoice conversations',
    },
    {
      name: 'Bug Report',
      color: 'tag-rose',
      description: 'Product issue reports',
    },
    {
      name: 'Feature Request',
      color: 'tag-purple',
      description: 'Product enhancement requests',
    },
    {
      name: 'Escalated',
      color: 'tag-red',
      description: 'Needs senior agent attention',
    },
    {
      name: 'Renewal',
      color: 'tag-green',
      description: 'Upcoming renewal discussions',
    },
    {
      name: 'Onboarding',
      color: 'tag-cyan',
      description: 'Implementation and setup support',
    },
    {
      name: 'Enterprise',
      color: 'tag-slate',
      description: 'Enterprise prospects and customers',
    },
    {
      name: 'Churn Risk',
      color: 'tag-orange',
      description: 'Accounts showing churn risk signals',
    },
  ];

  const tagIds = tagDefinitions.map(() => randomUUID());
  const tagRows: Prisma.TagCreateManyInput[] = tagDefinitions.map(
    (tag, index) => ({
      id: tagIds[index],
      workspaceId,
      name: tag.name,
      createdAt: dateInRange(oneYearAgo, now),
      updatedAt: now,
      color: tag.color,
      description: tag.description,
      createdBy: 'seed',
      createdById: agentIds[index % agentIds.length],
      updatedById: agentIds[(index + 1) % agentIds.length],
    }),
  );

  const lifecycleDefinitions = [
    {
      name: 'New Lead',
      description: 'Recently created or imported contact',
      isDefault: true,
      isWon: false,
    },
    {
      name: 'Qualified',
      description: 'Good-fit lead with active need',
      isDefault: false,
      isWon: false,
    },
    {
      name: 'Proposal',
      description: 'Commercial discussion in progress',
      isDefault: false,
      isWon: false,
    },
    {
      name: 'Customer',
      description: 'Active paying customer',
      isDefault: false,
      isWon: true,
    },
    {
      name: 'Lost',
      description: 'Not moving forward right now',
      isDefault: false,
      isWon: false,
    },
  ];

  const lifecycleStageIds = lifecycleDefinitions.map(() => randomUUID());
  const lifecycleRows: Prisma.LifecycleStageCreateManyInput[] =
    lifecycleDefinitions.map((stage, index) => ({
      id: lifecycleStageIds[index],
      workspaceId,
      name: stage.name,
      description: stage.description,
      type:
        index === lifecycleDefinitions.length - 1
          ? StageType.lost
          : StageType.lifecycle,
      order: index + 1,
      isDefault: stage.isDefault,
      isWon: stage.isWon,
      createdAt: dateInRange(oneYearAgo, now),
      updatedAt: now,
    }));

  await batchInsert<Prisma.ChannelCreateManyInput>(prisma.channel, channelRows);
  await batchInsert<Prisma.TeamCreateManyInput>(prisma.team, teamRows);
  await batchInsert<Prisma.TeamMemberCreateManyInput>(
    prisma.teamMember,
    teamMemberRows,
  );
  await batchInsert<Prisma.TagCreateManyInput>(prisma.tag, tagRows);
  await batchInsert<Prisma.LifecycleStageCreateManyInput>(
    prisma.lifecycleStage,
    lifecycleRows,
  );

  return {
    channels,
    teamIds: teamDefinitions.map((team) => team.id),
    tagIds,
    lifecycleStageIds,
  };
}
