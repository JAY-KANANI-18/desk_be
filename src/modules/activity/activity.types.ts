// src/activity/activity.types.ts
// Shared types for the ConversationActivity system.

export type ActivityEventType =
  // Conversation lifecycle
  | 'open'
  | 'close'
  | 'reopen'
  | 'pending'
  // Assignment
  | 'assign_user'
  | 'unassign_user'
  | 'assign_team'
  | 'unassign_team'
  // Contact
  | 'merge_contact'
  | 'channel_added'
  // Internal comms
  | 'note'
  // Labels
  | 'label_added'
  | 'label_removed'
  // Priority
  | 'priority_changed'
  // SLA
  | 'sla_breached';

export type ActorType = 'user' | 'system' | 'automation' | 'bot';

// ─── Per-event metadata shapes ────────────────────────────────────────────────

export interface OpenActivityMeta {
  previousStatus?: string;
  source?: string; // 'inbound' | 'agent' | 'automation'
}

export interface CloseActivityMeta {
  previousStatus?: string;
  source?: string;
}

export interface AssignUserActivityMeta {
  previousUserId: string | null;
  previousUserName: string | null;
  newUserId: string;
  newUserName: string;
}

export interface UnassignUserActivityMeta {
  previousUserId: string;
  previousUserName: string;
}

export interface AssignTeamActivityMeta {
  previousTeamId: string | null;
  previousTeamName: string | null;
  newTeamId: string;
  newTeamName: string;
}

export interface UnassignTeamActivityMeta {
  previousTeamId: string;
  previousTeamName: string;
}

export interface MergeContactActivityMeta {
  mergedContactId: string;
  mergedContactName: string;
  survivorContactId: string;
  survivorContactName?: string;
  mergedConversationIds?: string[];
  survivorConversationId?: string;
}

export interface ChannelAddedActivityMeta {
  channelType: string;
  identifier: string;
  channelName?: string;
  channelId: string;
}

export interface NoteActivityMeta {
  text: string;
  mentionedUserIds?: string[];
  attachments?: { url: string; name: string; type: string }[];
}

export interface LabelActivityMeta {
  labelName: string;
  color?: string;
}

export interface PriorityChangedActivityMeta {
  previousPriority: string;
  newPriority: string;
}

export interface SlaBreachedActivityMeta {
  slaPolicy: string;
  dueAt: string;
}

// ─── Union discriminator ──────────────────────────────────────────────────────

export type ActivityMetadata =
  | OpenActivityMeta
  | CloseActivityMeta
  | AssignUserActivityMeta
  | UnassignUserActivityMeta
  | AssignTeamActivityMeta
  | UnassignTeamActivityMeta
  | MergeContactActivityMeta
  | ChannelAddedActivityMeta
  | NoteActivityMeta
  | LabelActivityMeta
  | PriorityChangedActivityMeta
  | SlaBreachedActivityMeta;

// ─── Create activity DTO ──────────────────────────────────────────────────────

export interface CreateActivityDto {
  workspaceId: string;
  conversationId: string;
  eventType: ActivityEventType;
  actorId?: string;          // null for system events
  actorType?: ActorType;
  subjectUserId?: string;
  subjectTeamId?: string;
  metadata?: ActivityMetadata;
}

// ─── API response shapes ──────────────────────────────────────────────────────

export interface ActivityActor {
  id: string;
  name: string;
  avatarUrl?: string;
  type: ActorType;
}

export interface ActivityResponse {
  id: string;
  conversationId: string;
  eventType: ActivityEventType;
  actorType: ActorType;
  actor?: ActivityActor;
  subjectUser?: { id: string; name: string; avatarUrl?: string };
  subjectTeam?: { id: string; name: string };
  metadata?: ActivityMetadata;
  createdAt: string; // ISO string
  // Synthesized human-readable description (built server-side)
  description: string;
}

// ─── Timeline item (message OR activity) ─────────────────────────────────────
// Used by GET /conversations/:id/timeline

export type TimelineItemType = 'message' | 'activity';

export interface TimelineItem {
  id: string;
  type: TimelineItemType;
  timestamp: string;           // ISO string — used for sorting
  // Only one of these will be set depending on `type`
  message?: any;               // your existing Message shape
  activity?: ActivityResponse;
}
