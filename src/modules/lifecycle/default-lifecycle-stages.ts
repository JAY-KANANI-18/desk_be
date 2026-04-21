import { Prisma } from '@prisma/client';

type DefaultLifecycleStage = Omit<Prisma.LifecycleStageCreateManyInput, 'workspaceId'>;

export const DEFAULT_LIFECYCLE_STAGES: DefaultLifecycleStage[] = [
  {
    name: 'New Lead',
    description: '',
    emoji: '\u{1F195}',
    type: 'lifecycle',
    order: 1,
    isDefault: true,
    isWon: false,
  },
  {
    name: 'Hot Lead',
    description: '',
    emoji: '\u{1F525}',
    type: 'lifecycle',
    order: 2,
    isDefault: false,
    isWon: false,
  },
  {
    name: 'Payment',
    description: '',
    emoji: '\u{1F4B5}',
    type: 'lifecycle',
    order: 3,
    isDefault: false,
    isWon: false,
  },
  {
    name: 'Customer',
    description: '',
    emoji: '\u{1F929}',
    type: 'lifecycle',
    order: 4,
    isDefault: false,
    isWon: true,
  },
];

type LifecycleSeedClient = {
  lifecycleStage: {
    count(args: Prisma.LifecycleStageCountArgs): Promise<number>;
    createMany(args: Prisma.LifecycleStageCreateManyArgs): Promise<Prisma.BatchPayload>;
  };
};

export async function seedDefaultLifecycleStages(client: LifecycleSeedClient, workspaceId: string) {
  const existingLifecycleStages = await client.lifecycleStage.count({
    where: { workspaceId, type: 'lifecycle' },
  });

  if (existingLifecycleStages > 0) {
    return { created: 0, skipped: true };
  }

  const result = await client.lifecycleStage.createMany({
    data: DEFAULT_LIFECYCLE_STAGES.map((stage) => ({
      ...stage,
      workspaceId,
    })),
  });

  return { created: result.count, skipped: false };
}
