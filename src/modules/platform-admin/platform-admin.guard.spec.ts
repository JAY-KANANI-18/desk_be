import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_ADMIN_ACCESS_KEY } from './platform-admin-access.decorator';
import { PlatformAdminGuard, PlatformAdminRequest } from './platform-admin.guard';
import {
  PlatformPermission,
  PlatformRole,
} from './platform-admin.permissions';

function createContext(
  request: PlatformAdminRequest,
  requiredPermissions: PlatformPermission[] = [],
): ExecutionContext {
  const handler = function platformAdminTestHandler() {};
  class PlatformAdminTestController {}

  Reflect.defineMetadata(
    PLATFORM_ADMIN_ACCESS_KEY,
    requiredPermissions,
    handler,
  );

  return {
    getClass: () => PlatformAdminTestController,
    getHandler: () => handler,
    getArgs: () => [request],
    getArgByIndex: () => request,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => undefined,
      getNext: () => undefined,
    }),
    switchToRpc: () => ({
      getData: () => undefined,
      getContext: () => undefined,
    }),
    switchToWs: () => ({
      getClient: () => undefined,
      getData: () => undefined,
      getPattern: () => undefined,
    }),
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

describe('PlatformAdminGuard', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PLATFORM_ADMIN_EMAILS;
    delete process.env.PLATFORM_OWNER_EMAILS;
    delete process.env.PLATFORM_OPERATOR_EMAILS;
    delete process.env.PLATFORM_SUPPORT_EMAILS;
    delete process.env.PLATFORM_BILLING_EMAILS;
    delete process.env.PLATFORM_READONLY_EMAILS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('allows configured platform owners and stamps the request admin context', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'owner@example.com';
    const request: PlatformAdminRequest = {
      user: {
        id: 'user-1',
        email: 'owner@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
    };
    const guard = new PlatformAdminGuard(new Reflector());

    expect(
      guard.canActivate(
        createContext(request, [PlatformPermission.DASHBOARD_VIEW]),
      ),
    ).toBe(true);
    expect(request.platformAdmin).toMatchObject({
      id: 'user-1',
      email: 'owner@example.com',
      role: PlatformRole.OWNER,
    });
    expect(request.platformAdmin?.permissions).toContain(
      PlatformPermission.SETTINGS_MANAGE,
    );
  });

  it('rejects authenticated users that are not configured as platform admins', () => {
    const request: PlatformAdminRequest = {
      user: {
        id: 'user-2',
        email: 'customer@example.com',
      },
    };
    const guard = new PlatformAdminGuard(new Reflector());

    expect(() => guard.canActivate(createContext(request))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects configured roles that do not have the required route permission', () => {
    process.env.PLATFORM_BILLING_EMAILS = 'billing@example.com';
    const request: PlatformAdminRequest = {
      user: {
        id: 'user-3',
        email: 'billing@example.com',
      },
    };
    const guard = new PlatformAdminGuard(new Reflector());

    expect(() =>
      guard.canActivate(
        createContext(request, [PlatformPermission.SYSTEM_MANAGE]),
      ),
    ).toThrow(ForbiddenException);
  });
});
