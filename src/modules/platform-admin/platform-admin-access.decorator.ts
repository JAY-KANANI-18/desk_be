import { SetMetadata } from '@nestjs/common';
import { PlatformPermission } from './platform-admin.permissions';

export const PLATFORM_ADMIN_ACCESS_KEY = 'platform_admin_access';

export const PlatformAdminRoute = (...permissions: PlatformPermission[]) =>
  SetMetadata(PLATFORM_ADMIN_ACCESS_KEY, permissions);
