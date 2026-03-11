// src/channels/channel-provider.interface.ts
export interface ChannelProvider {
    readonly type: string;
    /** Send a message; returns provider message ID */
    sendMessage?(channel: any, payload: any): Promise<{ externalId: string }>;

    /** Fetch contact profile (name, avatar) */
    getContactProfile?(identifier: string, channelId: string): Promise<ContactProfile>;
  /** Parse raw webhook → normalized array (most channels send 1, but be safe) */
  parseWebhook(body: any, headers?: Record<string, string>): Promise<ParsedInbound[]>;

  /** Download media that requires provider auth */
  downloadMedia?(channel: any, mediaId: string): Promise<DownloadResult>;



  /** Mark a message read (WhatsApp, Messenger) */
  markRead?(channel: any, externalId: string): Promise<void>;
}

export interface OutboundPayload {
    channelId: string;
    conversationId: string;

    to: string;
    text?: string;
    metadata?: any;
    attachments?: OutboundAttachment[];

    template?: any;
}
export interface ParsedAttachment {
    type: MediaType;
    externalMediaId?: string;   // for WhatsApp / IG
    name?: string;
    url?: string;               // for channels that give direct URL
    mimeType?: string;
}

export interface OutboundAttachment {
    name?: string;
    // type: 'image' | 'video' | 'audio' | 'document';
    url: string;          // always our storage URL
    mimeType: string;
}

// The normalized output every provider.parseWebhook() must return
export interface ParsedInbound {
  // The provider message ID
  externalId: string;

  // Contact identifier on this channel
  // WA: phone number  |  IG/Messenger: PSID or scoped ID  |  email: address
  contactIdentifier: string;

  direction: 'incoming';

  // The primary message type (matches Message.type in DB)
  messageType: string;

  text?: string;
  subject?: string;       // email

  attachments: ParsedAttachment[];

  // For replies
  replyToChannelMsgId?: string;

  // Provider-specific extras (reaction, order, interactive, etc.)
  metadata?: Record<string, any>;

  // Full raw provider payload (stored in Message.rawPayload)
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

export type MediaType =
  | 'image' | 'video' | 'audio' | 'voice' | 'document'
  | 'sticker' | 'gif' | 'location' | 'contact' | 'reaction'
  | 'story_mention' | 'unsupported';

export interface ParsedAttachment {
  type: MediaType;
  mimeType?: string;
  url?: string;              // direct download URL (may expire — always re-fetch)
  externalMediaId?: string;  // provider media ID (WA/IG require auth download)
  filename?: string;
  caption?: string;
  size?: number;
  duration?: number;
  width?: number;
  height?: number;
  // location
  latitude?: number;
  longitude?: number;
  locationName?: string;
  locationAddress?: string;
  // contact
  contactVcard?: string;
  // reaction
  reactionEmoji?: string;
  reactionTargetMsgId?: string;
  // sticker
  stickerId?: string;
  // story
  thumbnailUrl?: string;
}