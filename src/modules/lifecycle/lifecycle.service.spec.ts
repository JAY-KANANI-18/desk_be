import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LifecycleService } from './lifecycle.service';

type WorkspaceDelegateMock = {
  findUnique: jest.Mock;
  update: jest.Mock;
};

type PrismaMock = {
  workspace: WorkspaceDelegateMock;
  lifecycleStage: {
    findMany: jest.Mock;
  };
};

function createService() {
  const prisma: PrismaMock = {
    workspace: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    lifecycleStage: {
      findMany: jest.fn(),
    },
  };

  return {
    prisma,
    service: new LifecycleService(prisma as unknown as PrismaService),
  };
}

describe('LifecycleService visibility', () => {
  it('returns no stages when lifecycle is disabled', async () => {
    const { prisma, service } = createService();
    prisma.workspace.findUnique.mockResolvedValue({ lifecycleEnabled: false });

    await expect(service.findAll('workspace-1')).resolves.toEqual([]);

    expect(prisma.lifecycleStage.findMany).not.toHaveBeenCalled();
  });

  it('returns stages when disabled stages are explicitly included', async () => {
    const { prisma, service } = createService();
    const stages = [{ id: 'stage-1', name: 'Lead' }];
    prisma.lifecycleStage.findMany.mockResolvedValue(stages);

    await expect(
      service.findAll('workspace-1', { includeDisabled: true }),
    ).resolves.toBe(stages);

    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(prisma.lifecycleStage.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-1' },
      orderBy: [{ type: 'asc' }, { order: 'asc' }],
    });
  });

  it('returns the persisted lifecycle visibility flag', async () => {
    const { prisma, service } = createService();
    prisma.workspace.findUnique.mockResolvedValue({ lifecycleEnabled: false });

    await expect(service.getVisibility('workspace-1')).resolves.toEqual({
      enabled: false,
    });

    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'workspace-1' },
      select: { lifecycleEnabled: true },
    });
  });

  it('throws when visibility is requested for a missing workspace', async () => {
    const { prisma, service } = createService();
    prisma.workspace.findUnique.mockResolvedValue(null);

    await expect(service.getVisibility('missing-workspace')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('persists lifecycle visibility updates', async () => {
    const { prisma, service } = createService();
    prisma.workspace.update.mockResolvedValue({ lifecycleEnabled: true });

    await expect(service.toggleVisibility('workspace-1', true)).resolves.toEqual({
      enabled: true,
    });

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'workspace-1' },
      data: { lifecycleEnabled: true },
      select: { lifecycleEnabled: true },
    });
  });
});
