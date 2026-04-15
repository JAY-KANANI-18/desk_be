export type ChannelOAuthProvider = 'instagram' | 'messenger' | 'whatsapp';
export type ChannelOAuthEventName = 'channel:connected' | 'channel:error';

export interface PendingChannelOAuthEvent {
  event: ChannelOAuthEventName;
  payload: Record<string, unknown>;
}

export const getPendingChannelOAuthEventsKey = (userId: string) =>
  `channel-oauth:pending:${userId}`;
