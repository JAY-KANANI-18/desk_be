export enum PlatformRole {
  OWNER = 'PLATFORM_OWNER',
  ADMIN = 'PLATFORM_ADMIN',
  SUPPORT = 'PLATFORM_SUPPORT',
  BILLING = 'PLATFORM_BILLING',
  READONLY = 'PLATFORM_READONLY',
}

export enum PlatformPermission {
  DASHBOARD_VIEW = 'platform:dashboard:view',
  ORGANIZATIONS_VIEW = 'platform:organizations:view',
  ORGANIZATIONS_MANAGE = 'platform:organizations:manage',
  WORKSPACES_VIEW = 'platform:workspaces:view',
  WORKSPACES_MANAGE = 'platform:workspaces:manage',
  USERS_VIEW = 'platform:users:view',
  USERS_MANAGE = 'platform:users:manage',
  BILLING_VIEW = 'platform:billing:view',
  BILLING_MANAGE = 'platform:billing:manage',
  USAGE_VIEW = 'platform:usage:view',
  CHANNELS_VIEW = 'platform:channels:view',
  CHANNELS_REPAIR = 'platform:channels:repair',
  SYSTEM_VIEW = 'platform:system:view',
  SYSTEM_MANAGE = 'platform:system:manage',
  AUDIT_VIEW = 'platform:audit:view',
  SETTINGS_VIEW = 'platform:settings:view',
  SETTINGS_MANAGE = 'platform:settings:manage',
  IMPERSONATION_START = 'platform:impersonation:start',
}

export const PLATFORM_ROLE_PERMISSIONS: Record<
  PlatformRole,
  PlatformPermission[]
> = {
  [PlatformRole.OWNER]: Object.values(PlatformPermission),
  [PlatformRole.ADMIN]: [
    PlatformPermission.DASHBOARD_VIEW,
    PlatformPermission.ORGANIZATIONS_VIEW,
    PlatformPermission.ORGANIZATIONS_MANAGE,
    PlatformPermission.WORKSPACES_VIEW,
    PlatformPermission.WORKSPACES_MANAGE,
    PlatformPermission.USERS_VIEW,
    PlatformPermission.USERS_MANAGE,
    PlatformPermission.BILLING_VIEW,
    PlatformPermission.BILLING_MANAGE,
    PlatformPermission.USAGE_VIEW,
    PlatformPermission.CHANNELS_VIEW,
    PlatformPermission.CHANNELS_REPAIR,
    PlatformPermission.SYSTEM_VIEW,
    PlatformPermission.SYSTEM_MANAGE,
    PlatformPermission.AUDIT_VIEW,
    PlatformPermission.SETTINGS_VIEW,
  ],
  [PlatformRole.SUPPORT]: [
    PlatformPermission.DASHBOARD_VIEW,
    PlatformPermission.ORGANIZATIONS_VIEW,
    PlatformPermission.WORKSPACES_VIEW,
    PlatformPermission.USERS_VIEW,
    PlatformPermission.USAGE_VIEW,
    PlatformPermission.CHANNELS_VIEW,
    PlatformPermission.CHANNELS_REPAIR,
    PlatformPermission.SYSTEM_VIEW,
    PlatformPermission.AUDIT_VIEW,
  ],
  [PlatformRole.BILLING]: [
    PlatformPermission.DASHBOARD_VIEW,
    PlatformPermission.ORGANIZATIONS_VIEW,
    PlatformPermission.WORKSPACES_VIEW,
    PlatformPermission.USERS_VIEW,
    PlatformPermission.BILLING_VIEW,
    PlatformPermission.BILLING_MANAGE,
    PlatformPermission.USAGE_VIEW,
    PlatformPermission.AUDIT_VIEW,
  ],
  [PlatformRole.READONLY]: [
    PlatformPermission.DASHBOARD_VIEW,
    PlatformPermission.ORGANIZATIONS_VIEW,
    PlatformPermission.WORKSPACES_VIEW,
    PlatformPermission.USERS_VIEW,
    PlatformPermission.BILLING_VIEW,
    PlatformPermission.USAGE_VIEW,
    PlatformPermission.CHANNELS_VIEW,
    PlatformPermission.SYSTEM_VIEW,
    PlatformPermission.AUDIT_VIEW,
    PlatformPermission.SETTINGS_VIEW,
  ],
};

const ROLE_EMAIL_ENV: Record<PlatformRole, string[]> = {
  [PlatformRole.OWNER]: ['PLATFORM_OWNER_EMAILS', 'PLATFORM_ADMIN_EMAILS'],
  [PlatformRole.ADMIN]: ['PLATFORM_OPERATOR_EMAILS'],
  [PlatformRole.SUPPORT]: ['PLATFORM_SUPPORT_EMAILS'],
  [PlatformRole.BILLING]: ['PLATFORM_BILLING_EMAILS'],
  [PlatformRole.READONLY]: ['PLATFORM_READONLY_EMAILS'],
};

function readCsvSet(envNames: string[]) {
  return new Set(
    envNames
      .flatMap((name) => (process.env[name] ?? '').split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function resolvePlatformRoleForEmail(email?: string | null) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return null;

  const entries = Object.values(PlatformRole).map((role) => ({
    role,
    emails: readCsvSet(ROLE_EMAIL_ENV[role]),
  }));

  return entries.find((entry) => entry.emails.has(normalizedEmail))?.role ?? null;
}

export function getPlatformPermissions(role: PlatformRole) {
  return PLATFORM_ROLE_PERMISSIONS[role] ?? [];
}
