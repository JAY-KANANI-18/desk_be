import type { Prisma } from '@prisma/client';
import type { Faker } from '@faker-js/faker';

export type BatchInsertModel<T> = {
  createMany(args: {
    data: T[];
    skipDuplicates?: boolean;
  }): Promise<Prisma.BatchPayload> | Prisma.PrismaPromise<Prisma.BatchPayload>;
};

export type WeightedOption<T> = {
  value: T;
  weight: number;
};

type FakerModule = {
  faker: Faker;
};

let fakerInstance: Faker | null = null;

export async function loadFaker(): Promise<Faker> {
  if (fakerInstance) {
    return fakerInstance;
  }

  const importFaker = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<FakerModule>;
  const module = await importFaker('@faker-js/faker');

  fakerInstance = module.faker;
  return fakerInstance;
}

export function getFaker(): Faker {
  if (!fakerInstance) {
    throw new Error('Faker must be loaded before running seeders');
  }

  return fakerInstance;
}

export async function batchInsert<T>(
  model: BatchInsertModel<T>,
  data: T[],
  chunkSize = 500,
): Promise<number> {
  if (chunkSize < 1) {
    throw new Error('chunkSize must be at least 1');
  }

  let inserted = 0;

  for (let index = 0; index < data.length; index += chunkSize) {
    const chunk = data.slice(index, index + chunkSize);
    const result = await model.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    inserted += result.count;
  }

  return inserted;
}

export function weightedPick<T>(options: WeightedOption<T>[]): T {
  if (options.length === 0) {
    throw new Error('weightedPick requires at least one option');
  }

  const totalWeight = options.reduce((total, option) => {
    if (option.weight <= 0) {
      throw new Error('weightedPick options must have positive weights');
    }

    return total + option.weight;
  }, 0);

  let cursor = Math.random() * totalWeight;

  for (const option of options) {
    cursor -= option.weight;
    if (cursor <= 0) {
      return option.value;
    }
  }

  return options[options.length - 1].value;
}

export function randBetween(min: number, max: number): number {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);

  if (upper < lower) {
    throw new Error(
      'randBetween requires max to be greater than or equal to min',
    );
  }

  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

export function dateInRange(from: Date, to: Date): Date {
  const fromMs = from.getTime();
  const toMs = to.getTime();

  if (toMs < fromMs) {
    throw new Error('dateInRange requires to to be after from');
  }

  return new Date(randBetween(fromMs, toMs));
}
