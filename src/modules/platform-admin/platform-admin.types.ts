export interface PlatformPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PlatformPaginatedResponse<T> {
  items: T[];
  pagination: PlatformPagination;
}

export interface PlatformMetric {
  id: string;
  label: string;
  value: string;
  delta: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

export interface OrganizationRow {
  id: string;
  name: string;
  ownerEmail: string;
  plan: string;
  status: 'active' | 'review' | 'suspended';
  workspaces: number;
  users: number;
  monthlyMessages: number;
  lastActivity: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  status: 'active' | 'review' | 'suspended';
  members: number;
  channels: number;
  monthlyMessages: number;
  featureFlags: string[];
  lastActivity: string;
}

export interface PlatformUserRow {
  id: string;
  name: string;
  email: string;
  organizationName: string;
  workspaceCount: number;
  roleSummary: string;
  status: 'active' | 'invited' | 'disabled';
  lastSeen: string;
}

export interface BillingRow {
  id: string;
  organizationName: string;
  plan: string;
  seats: number;
  amount: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  renewsAt: string;
}

export interface UsageRow {
  id: string;
  organizationName: string;
  metric: string;
  used: number;
  limit: number;
  period: string;
}

export interface ChannelHealthRow {
  id: string;
  organizationName: string;
  workspaceName: string;
  provider: string;
  status: 'healthy' | 'warning' | 'critical';
  connectedAccount: string;
  lastInboundAt: string;
  lastError: string;
}

export interface SystemHealthRow {
  id: string;
  area: string;
  status: 'healthy' | 'warning' | 'critical';
  signal: string;
  volume: string;
  lastCheckedAt: string;
}

export interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  target: string;
  status: 'success' | 'failed';
  reason: string;
  createdAt: string;
}

export interface PlatformDashboard {
  metrics: PlatformMetric[];
  organizations: OrganizationRow[];
  workspaces: WorkspaceRow[];
  users: PlatformUserRow[];
  billing: BillingRow[];
  usage: UsageRow[];
  channels: ChannelHealthRow[];
  system: SystemHealthRow[];
  audit: AuditLogRow[];
}
