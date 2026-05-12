import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SnippetsService } from './snippets.service';

type PrismaMock = {
  snippet: {
    create: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
};

function createPrismaMock(): PrismaMock {
  return {
    snippet: {
      create: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function createSnippetRow(overrides: Partial<{
  id: string;
  workspaceId: string;
  shortcut: string;
  name: string;
  content: string;
  topic: string | null;
  attachments: unknown;
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    workspaceId: 'workspace-1',
    shortcut: '/hello',
    name: 'Hello',
    content: 'Hi {{contact_name}}',
    topic: 'Support',
    attachments: null,
    createdById: 'user-1',
    updatedById: null,
    createdAt: new Date('2026-05-08T08:00:00.000Z'),
    updatedAt: new Date('2026-05-08T08:00:00.000Z'),
    ...overrides,
  };
}

describe('SnippetsService', () => {
  it('creates a workspace-scoped snippet with a normalized shortcut', async () => {
    const prisma = createPrismaMock();
    prisma.snippet.findFirst.mockResolvedValue(null);
    prisma.snippet.create.mockResolvedValue(createSnippetRow());
    const service = new SnippetsService(prisma as unknown as PrismaService);

    const result = await service.create(
      'workspace-1',
      {
        name: '  Hello  ',
        shortcut: 'Hello',
        content: ' Hi {{contact_name}} ',
        topic: ' Support ',
      },
      'user-1',
    );

    expect(prisma.snippet.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'workspace-1',
          shortcut: '/hello',
          name: 'Hello',
          content: 'Hi {{contact_name}}',
          topic: 'Support',
          createdById: 'user-1',
        }),
      }),
    );
    expect(result).toMatchObject({
      id: '11111111-1111-1111-1111-111111111111',
      shortcut: '/hello',
      name: 'Hello',
      title: 'Hello',
    });
  });

  it('rejects duplicate snippet IDs inside the same workspace', async () => {
    const prisma = createPrismaMock();
    prisma.snippet.findFirst.mockResolvedValue({ id: 'existing-snippet' });
    const service = new SnippetsService(prisma as unknown as PrismaService);

    await expect(
      service.create('workspace-1', {
        name: 'Hello',
        shortcut: '/HELLO',
        content: 'Hi',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('does not update snippets outside the current workspace', async () => {
    const prisma = createPrismaMock();
    prisma.snippet.findFirst.mockResolvedValue(null);
    const service = new SnippetsService(prisma as unknown as PrismaService);

    await expect(
      service.update('workspace-1', 'snippet-2', { name: 'New name' }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.snippet.update).not.toHaveBeenCalled();
  });
});
