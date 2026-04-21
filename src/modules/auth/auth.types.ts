export interface AuthenticatedSessionUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  language?: string | null;
  status?: string | null;
  emailVerifiedAt?: string | null;
  lastLoginAt?: string | null;
}

export interface SessionContext {
  sessionId: string;
  userId: string;
  user: AuthenticatedSessionUser;
  passwordSet: boolean;
  sessionVersion: number;
  currentOrganizationId?: string | null;
  currentWorkspaceId?: string | null;
  rememberMe: boolean;
  csrfToken: string;
  orgRoles: Record<string, string>;
  workspaceRoles: Record<string, string>;
  trustedDeviceId?: string | null;
  expiresAt: string;
  idleExpiresAt: string;
  lastRefreshedAt: string;
  authProvider: 'local' | 'oauth' | 'magic_link' | 'otp' | 'invite' | 'legacy_supabase';
}

export interface RequestMeta {
  ipAddress: string | null;
  ipHash: string | null;
  userAgent: string | null;
  deviceId: string | null;
  deviceName: string | null;
  deviceFingerprint: string | null;
}

export interface SessionEnvelope {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  session: {
    access_token: string;
    expires_at: number;
    expires_in: number;
    token_type: 'Bearer';
    user: {
      id: string;
      email: string;
      user_metadata: {
        full_name: string;
        name: string;
        firstName?: string | null;
        lastName?: string | null;
        avatarUrl?: string | null;
        language?: string | null;
        role: string;
        emailVerified: boolean;
        passwordSet: boolean;
        currentOrganizationId?: string | null;
        currentWorkspaceId?: string | null;
      };
    };
  };
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}
