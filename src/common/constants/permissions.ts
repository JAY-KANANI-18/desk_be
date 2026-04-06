// ── Org roles ─────────────────────────────────────────────
export enum OrgRole {
  ADMIN         = 'ORG_ADMIN',
  BILLING_ADMIN = 'ORG_BILLING_ADMIN',
  USER_ADMIN    = 'ORG_USER_ADMIN',
  MEMBER        = 'ORG_MEMBER',
}

export enum OrgPermission {
  ORG_SETTINGS_MANAGE = 'org:settings:manage',
  ORG_SETTINGS_VIEW   = 'org:settings:view',
  ORG_DELETE          = 'org:delete',
  BILLING_MANAGE      = 'org:billing:manage',
  BILLING_VIEW        = 'org:billing:view',
  SUBSCRIPTION_CANCEL = 'org:subscription:cancel',
  USERS_MANAGE        = 'org:users:manage',
  USERS_VIEW          = 'org:users:view',
  WORKSPACES_MANAGE   = 'org:workspaces:manage',
  WORKSPACES_VIEW     = 'org:workspaces:view',
}

export const ORG_ROLE_PERMISSIONS: Record<OrgRole, OrgPermission[]> = {
  [OrgRole.ADMIN]: Object.values(OrgPermission),

  [OrgRole.BILLING_ADMIN]: [
    OrgPermission.ORG_SETTINGS_VIEW,
    OrgPermission.BILLING_MANAGE,
    OrgPermission.BILLING_VIEW,
    OrgPermission.USERS_VIEW,
    OrgPermission.WORKSPACES_VIEW,
  ],

  [OrgRole.USER_ADMIN]: [
    OrgPermission.ORG_SETTINGS_VIEW,
    OrgPermission.BILLING_VIEW,
    OrgPermission.USERS_MANAGE,
    OrgPermission.USERS_VIEW,
    OrgPermission.WORKSPACES_MANAGE,
    OrgPermission.WORKSPACES_VIEW,
  ],

  [OrgRole.MEMBER]: [],
};

// ── Workspace roles ────────────────────────────────────────
export enum WorkspaceRole {
  OWNER   = 'WS_OWNER',
  MANAGER = 'WS_MANAGER',
  AGENT   = 'WS_AGENT',
}

export enum WorkspacePermission {
  DASHBOARD_VIEW       = 'ws:dashboard:view',
  CONTACTS_VIEW        = 'ws:contacts:view',
  CONTACTS_MANAGE      = 'ws:contacts:manage',
  MESSAGES_VIEW        = 'ws:messages:view',
  MESSAGES_SEND        = 'ws:messages:send',
  SHORTCUTS_USE        = 'ws:shortcuts:use',
  SHORTCUTS_MANAGE     = 'ws:shortcuts:manage',
  BROADCASTS_VIEW      = 'ws:broadcasts:view',
  BROADCASTS_SEND      = 'ws:broadcasts:send',
  REPORTS_VIEW         = 'ws:reports:view',
  SETTINGS_VIEW        = 'ws:settings:view',
  SETTINGS_MANAGE      = 'ws:settings:manage',
  SETTINGS_LIMITED     = 'ws:settings:limited',
  PROFILE_MANAGE       = 'ws:profile:manage',
  NOTIFICATIONS_MANAGE = 'ws:notifications:manage',
  TEAMS_MANAGE         = 'ws:teams:manage',
  WORKFLOWS_VIEW       = 'ws:workflows:view',
  WORKFLOWS_MANAGE     = 'ws:workflows:manage',
  CHANNELS_MANAGE      = 'ws:channels:manage',
  FILES_ACCESS         = 'ws:files:access',
}

export const WS_ROLE_PERMISSIONS: Record<WorkspaceRole, WorkspacePermission[]> = {
  [WorkspaceRole.OWNER]: Object.values(WorkspacePermission),

  [WorkspaceRole.MANAGER]: [
    WorkspacePermission.DASHBOARD_VIEW,
    WorkspacePermission.CONTACTS_VIEW,
    WorkspacePermission.CONTACTS_MANAGE,
    WorkspacePermission.MESSAGES_VIEW,
    WorkspacePermission.MESSAGES_SEND,
    WorkspacePermission.SHORTCUTS_USE,
    WorkspacePermission.SHORTCUTS_MANAGE,
    WorkspacePermission.BROADCASTS_VIEW,
    WorkspacePermission.BROADCASTS_SEND,
    WorkspacePermission.REPORTS_VIEW,
    WorkspacePermission.SETTINGS_VIEW,
    WorkspacePermission.SETTINGS_LIMITED,
    WorkspacePermission.PROFILE_MANAGE,
    WorkspacePermission.NOTIFICATIONS_MANAGE,
    WorkspacePermission.WORKFLOWS_VIEW,
    WorkspacePermission.FILES_ACCESS,
  ],

  [WorkspaceRole.AGENT]: [
    WorkspacePermission.MESSAGES_VIEW,
    WorkspacePermission.MESSAGES_SEND,
    WorkspacePermission.SHORTCUTS_USE,
    WorkspacePermission.PROFILE_MANAGE,
    WorkspacePermission.NOTIFICATIONS_MANAGE,
  ],
};