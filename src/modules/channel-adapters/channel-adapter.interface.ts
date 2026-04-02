// ─── Core provider interface ──────────────────────────────────────────────────

export interface ChannelProvider {
  readonly type: string;

  parseWebhook(body: any, headers?: Record<string, string>): Promise<ParsedInbound[]>;

  downloadMedia?(channel: any, mediaId: string): Promise<DownloadResult>;

  getContactProfile?(identifier: string, channel: any): Promise<ContactProfile>;

  sendMessage?(channel: any, payload: any): Promise<{ externalId: string }>;

  uploadMedia?(channel: any, opts: { url: string; mimeType: string; type?: string }): Promise<string>;

  markRead?(channel: any, externalId: string): Promise<void>;

  /** Pre-send validation — throws BadRequestException with SendError body */
  validateOutbound?(opts: ValidateOutboundOpts): void;

  /** Map raw provider error → structured BadRequestException */
  normaliseError?(err: any): never;

  /** Template features — undefined if provider has no template system */
  templates?: ProviderTemplateCapability;
}

// ─── Inbound ──────────────────────────────────────────────────────────────────


export interface ParsedInbound {
  externalId: string;
  contactIdentifier: string;
  recipientIdentifier?: string;
  direction: 'incoming' | 'outgoing';
  messageType: string;
  text?: string;
  subject?: string;
  attachments: ParsedAttachment[];
  replyToChannelMsgId?: string;
  metadata?: Record<string, any>;
  raw?: any;
}

export interface ContactProfile {
  name?: string;
  avatarUrl?: string;
  raw?: any;
}

export interface DownloadResult {
  buffer: ArrayBuffer;
  mimeType: string;
  filename?: string;
}


// modules/channels/channel-provider.interface.ts

export type MediaType =
  | 'image' | 'video' | 'audio' | 'voice' | 'document'
  | 'sticker' | 'gif' | 'location' | 'contact' | 'reaction'
  | 'story_mention' | 'unsupported';

// ─── Outbound validation ──────────────────────────────────────────────────────

export interface ValidateOutboundOpts {
  channel: any;
  contactChannel: { identifier: string } | null;
  contact: { phone?: string | null; email?: string | null };
  payload: { text?: string; attachments?: any[]; template?: any };
}

export interface ParsedAttachment {
  type: MediaType;
  mimeType?: string;
  url?: string;
  externalMediaId?: string;
  filename?: string;
  caption?: string;
  size?: number;
  duration?: number;
  width?: number;
  height?: number;
  latitude?: number;
  longitude?: number;
  locationName?: string;
  locationAddress?: string;
  contactVcard?: string;
  reactionEmoji?: string;
  reactionTargetMsgId?: string;
  stickerId?: string;
  thumbnailUrl?: string;
}


// ─── Template capability ──────────────────────────────────────────────────────
// Attached as provider.templates — undefined means provider has no templates.

export interface ProviderTemplateCapability {
  sync(channel: any): Promise<{ synced: number; errors: number }>;
  list(channelId: string, workspaceId: string, filters?: Record<string, any>): Promise<any[]>;
  getVariables?(templateId: string): Promise<string[]>;
  preview?(templateId: string, variables: Record<string, string>): Promise<any>;
  build?(templateId: string, variables: Record<string, string>): Promise<any>;
}

