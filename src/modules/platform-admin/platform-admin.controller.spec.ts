import { NotFoundException } from '@nestjs/common';

jest.mock(
  'src/common/auth/route-access.decorator',
  () => ({
    JwtOnly: () => () => undefined,
  }),
  { virtual: true },
);
jest.mock(
  'src/prisma/prisma.service',
  () => ({
    PrismaService: class PrismaService {},
  }),
  { virtual: true },
);

import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminService } from './platform-admin.service';
import type {
  OrganizationRow,
  PlatformUserRow,
  WorkspaceRow,
} from './platform-admin.types';

describe('PlatformAdminController', () => {
  it('throws a not found response when an organization detail row is missing', async () => {
    const controller = new PlatformAdminController({
      getOrganization: jest.fn().mockResolvedValue(null),
    } as unknown as PlatformAdminService);

    await expect(controller.getOrganization('missing-org')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns an organization detail row when found', async () => {
    const organization: OrganizationRow = {
      id: 'org-1',
      name: 'AxoDesk',
      ownerEmail: 'owner@example.com',
      plan: 'Scale',
      status: 'active',
      workspaces: 2,
      users: 8,
      monthlyMessages: 1200,
      lastActivity: 'Today',
    };
    const controller = new PlatformAdminController({
      getOrganization: jest.fn().mockResolvedValue(organization),
    } as unknown as PlatformAdminService);

    await expect(controller.getOrganization('org-1')).resolves.toBe(
      organization,
    );
  });

  it('throws a not found response when a workspace detail row is missing', async () => {
    const controller = new PlatformAdminController({
      getWorkspace: jest.fn().mockResolvedValue(null),
    } as unknown as PlatformAdminService);

    await expect(controller.getWorkspace('missing-workspace')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws a not found response when a user detail row is missing', async () => {
    const controller = new PlatformAdminController({
      getUser: jest.fn().mockResolvedValue(null),
    } as unknown as PlatformAdminService);

    await expect(controller.getUser('missing-user')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns workspace and user detail rows when found', async () => {
    const workspace: WorkspaceRow = {
      id: 'workspace-1',
      name: 'Support',
      organizationId: 'org-1',
      organizationName: 'AxoDesk',
      status: 'active',
      members: 4,
      channels: 3,
      monthlyMessages: 900,
      featureFlags: ['aiAgents'],
      lastActivity: 'Today',
    };
    const user: PlatformUserRow = {
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      organizationName: 'AxoDesk',
      workspaceCount: 1,
      roleSummary: 'ORG_ADMIN',
      status: 'active',
      lastSeen: 'Today',
    };
    const controller = new PlatformAdminController({
      getWorkspace: jest.fn().mockResolvedValue(workspace),
      getUser: jest.fn().mockResolvedValue(user),
    } as unknown as PlatformAdminService);

    await expect(controller.getWorkspace('workspace-1')).resolves.toBe(
      workspace,
    );
    await expect(controller.getUser('user-1')).resolves.toBe(user);
  });
});
