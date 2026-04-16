import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import axios from 'axios';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';
import { OutboundService } from '../../../outbound/outbound.service';
import { ActivityService } from '../../../activity/activity.service';
import { WorkflowEngineService } from '../../../workflows/workflow-engine.service';

const FB_GRAPH = 'https://graph.facebook.com/v22.0';
const IG_GRAPH = 'https://graph.instagram.com/v22.0';

type SupportedAutomationChannel = 'messenger' | 'instagram';
type MenuActionKind = 'payload' | 'quick_reply';
type PrivateReplyScope = 'all' | 'selected';

export interface PrivateRepliesConfig {
  enabled: boolean;
  scope: PrivateReplyScope;
  selectedPostIds: string[];
  message: string;
  updatedAt?: string | null;
}

export interface StoryRepliesConfig {
  enabled: boolean;
  message: string;
  updatedAt?: string | null;
}

export interface MenuActionConfig {
  kind: MenuActionKind;
  title?: string;
  replyText?: string;
}

export interface MetaAutomationTarget {
  id: string;
  title: string;
  subtitle?: string | null;
  type: string;
  permalink?: string | null;
  thumbnailUrl?: string | null;
  createdAt?: string | null;
}

interface ChannelAutomationConfig {
  privateReplies?: PrivateRepliesConfig;
  storyReplies?: StoryRepliesConfig;
  menuActions?: Record<string, MenuActionConfig>;
}

interface CommentEventPayload {
  channelType: SupportedAutomationChannel;
  commentId: string;
  postId?: string | null;
  commentText?: string | null;
  commenterId?: string | null;
  commenterName?: string | null;
  raw: any;
}

@Injectable()
export class MetaAutomationService {
  private readonly logger = new Logger(MetaAutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly outbound: OutboundService,
    private readonly activity: ActivityService,
    private readonly workflowEngine: WorkflowEngineService,
    private readonly events: EventEmitter2,
  ) {}

  async getPrivateRepliesConfig(channelId: string, workspaceId: string) {
    const channel = await this.findChannel(channelId, workspaceId);
    return this.normalisePrivateReplies(this.getAutomationConfig(channel).privateReplies);
  }

  async savePrivateRepliesConfig(
    channelId: string,
    workspaceId: string,
    input: Partial<PrivateRepliesConfig>,
  ) {
    const channel = await this.findChannel(channelId, workspaceId);
    const automation = this.getAutomationConfig(channel);
    const next: PrivateRepliesConfig = {
      enabled: Boolean(input.enabled),
      scope: input.scope === 'selected' ? 'selected' : 'all',
      selectedPostIds: Array.isArray(input.selectedPostIds)
        ? input.selectedPostIds.filter(Boolean)
        : [],
      message: String(input.message ?? '').trim(),
      updatedAt: new Date().toISOString(),
    };

    automation.privateReplies = next;
    await this.updateAutomationConfig(channel.id, channel.config, automation);
    return next;
  }

  async getStoryRepliesConfig(channelId: string, workspaceId: string) {
    const channel = await this.findChannel(channelId, workspaceId, ['instagram']);
    return this.normaliseStoryReplies(this.getAutomationConfig(channel).storyReplies);
  }

  async saveStoryRepliesConfig(
    channelId: string,
    workspaceId: string,
    input: Partial<StoryRepliesConfig>,
  ) {
    const channel = await this.findChannel(channelId, workspaceId, ['instagram']);
    const automation = this.getAutomationConfig(channel);
    const next: StoryRepliesConfig = {
      enabled: Boolean(input.enabled),
      message: String(input.message ?? '').trim(),
      updatedAt: new Date().toISOString(),
    };

    automation.storyReplies = next;
    await this.updateAutomationConfig(channel.id, channel.config, automation);
    return next;
  }

  async listTargets(channelId: string, workspaceId: string): Promise<MetaAutomationTarget[]> {
    const channel = await this.findChannel(channelId, workspaceId);
    const token = this.getAccessToken(channel);

    if (channel.type === 'instagram') {
      const accountId =
        (channel.config as any)?.igUserId ??
        (channel.credentials as any)?.igUserId ??
        channel.identifier;

      const { data } = await axios.get(`${IG_GRAPH}/${accountId}/media`, {
        params: {
          fields:
            'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp',
          access_token: token,
          limit: 25,
        },
      });

      return (data.data ?? []).map((item: any) => ({
        id: item.id,
        title: this.toTargetTitle(item.caption, item.media_product_type ?? item.media_type),
        subtitle: item.caption ?? null,
        type: String(item.media_product_type ?? item.media_type ?? 'media').toLowerCase(),
        permalink: item.permalink ?? null,
        thumbnailUrl: item.thumbnail_url ?? item.media_url ?? null,
        createdAt: item.timestamp ?? null,
      }));
    }

    const { data } = await axios.get(`${FB_GRAPH}/${channel.identifier}/feed`, {
      params: {
        fields: 'id,message,story,permalink_url,full_picture,created_time',
        access_token: token,
        limit: 25,
      },
    });

    return (data.data ?? []).map((item: any) => ({
      id: item.id,
      title: this.toTargetTitle(item.message ?? item.story, 'post'),
      subtitle: item.message ?? item.story ?? null,
      type: 'post',
      permalink: item.permalink_url ?? null,
      thumbnailUrl: item.full_picture ?? null,
      createdAt: item.created_time ?? null,
    }));
  }

  extractCommentEvents(body: any, channelType: SupportedAutomationChannel): CommentEventPayload[] {
    const results: CommentEventPayload[] = [];

    for (const entry of body?.entry ?? []) {
      if (entry?.field === 'comments' || entry?.field === 'live_comments') {
        const value = entry.value ?? {};
        const commentId = value.id ?? value.comment_id ?? null;
        if (!commentId) continue;

        results.push({
          channelType,
          commentId,
          postId: value.media?.id ?? value.post_id ?? value.post?.id ?? null,
          commentText: value.text ?? value.message ?? null,
          commenterId: value.from?.id ?? null,
          commenterName: value.from?.username ?? value.from?.name ?? null,
          raw: entry,
        });
        continue;
      }

      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        const isCommentEvent =
          change?.field === 'comments' ||
          change?.field === 'feed' ||
          value.item === 'comment';

        if (!isCommentEvent) continue;

        const commentId = value.id ?? value.comment_id ?? null;
        if (!commentId) continue;

        results.push({
          channelType,
          commentId,
          postId: value.post_id ?? value.post?.id ?? value.media?.id ?? null,
          commentText: value.text ?? value.message ?? null,
          commenterId: value.from?.id ?? null,
          commenterName: value.from?.username ?? value.from?.name ?? null,
          raw: change,
        });
      }
    }

    return results;
  }

  async processCommentEvent(channelId: string, workspaceId: string, payload: CommentEventPayload) {
    const channel = await this.findChannel(channelId, workspaceId);
    const config = this.normalisePrivateReplies(this.getAutomationConfig(channel).privateReplies);

    if (!config.enabled || !config.message) {
      return false;
    }

    if (
      config.scope === 'selected' &&
      config.selectedPostIds.length > 0 &&
      (!payload.postId || !config.selectedPostIds.includes(payload.postId))
    ) {
      return false;
    }

    const dedupeKey = `meta:auto:comment:${channel.id}:${payload.commentId}`;
    const accepted = await this.redis.client.set(dedupeKey, '1', 'EX', 60 * 60 * 24, 'NX');
    if (!accepted) {
      return false;
    }

    const recipientKey = payload.commenterId ?? payload.commentId;
    const withinLimit = await this.allowRateLimitedSend(channel.id, recipientKey);
    if (!withinLimit) {
      await this.emitAutomationError(channel.workspaceId, {
        channelId: channel.id,
        triggerType: 'comment',
        error: 'Automation rate limit reached. Retry in a moment.',
        payload,
      });
      return false;
    }

    const message = this.interpolateAutomationText(config.message, {
      comment_text: payload.commentText ?? '',
      post_id: payload.postId ?? '',
      commenter_name: payload.commenterName ?? '',
    });

    try {
      if (channel.type === 'instagram') {
        await this.sendInstagramCommentReply(channel, payload.commentId, message);
      } else {
        await this.sendMessengerCommentReply(channel, payload.commentId, message);
      }

      this.logger.log(
        `Processed ${channel.type} private reply for channel=${channel.id} comment=${payload.commentId}`,
      );

      this.events.emit('automation.triggered', {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        channelType: channel.type,
        triggerType: 'comment',
        recipientId: payload.commenterId ?? null,
        externalId: payload.commentId,
        message,
      });

      return true;
    } catch (error: any) {
      await this.emitAutomationError(channel.workspaceId, {
        channelId: channel.id,
        triggerType: 'comment',
        error: this.getErrorMessage(error),
        payload,
      });
      return false;
    }
  }

  @OnEvent('message.inbound')
  async handleInboundMessage(event: {
    workspaceId: string;
    conversationId: string;
    message: any;
  }) {
    const message = await this.prisma.message.findUnique({
      where: { id: event.message?.id ?? '' },
      include: {
        channel: true,
        conversation: {
          include: {
            contact: true,
          },
        },
      },
    });

    if (!message?.channel || !message.conversation) {
      return;
    }

    if (!['messenger', 'instagram'].includes(message.channel.type)) {
      return;
    }

    const automation = this.getAutomationConfig(message.channel);
    const metadata = (message.metadata ?? {}) as Record<string, any>;

    await this.handleStoryReplyTrigger(message, automation, metadata);
    await this.handleMenuClickTrigger(message, automation, metadata);
  }

  @OnEvent('message.outbound')
  async handleOutboundMessage(event: {
    workspaceId: string;
    conversationId: string;
    message?: any;
  }) {
    if (!event.message?.id || event.message?.type !== 'template') {
      return;
    }

    const metadata = (event.message.metadata ?? {}) as Record<string, any>;
    if (!metadata.template?.name) {
      return;
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: event.conversationId },
      select: { contactId: true },
    });
    if (!conversation?.contactId) {
      return;
    }

    await this.workflowEngine.trigger({
      workspaceId: event.workspaceId,
      eventType: 'template_send',
      contactId: conversation.contactId,
      conversationId: event.conversationId,
      triggerData: {
        template: metadata.template,
        templateName: metadata.template?.name ?? null,
        templateLanguage: metadata.template?.language ?? null,
        templateCategory: metadata.template?.category ?? null,
        templateStatus: metadata.template?.status ?? null,
        messageId: event.message.id,
        channelId: event.message.channelId,
      },
    });

    this.events.emit('automation.triggered', {
      workspaceId: event.workspaceId,
      channelId: event.message.channelId,
      channelType: event.message.channelType,
      conversationId: event.conversationId,
      triggerType: 'template_send',
      messageId: event.message.id,
      template: metadata.template,
    });
  }

  private async handleStoryReplyTrigger(
    message: any,
    automation: ChannelAutomationConfig,
    metadata: Record<string, any>,
  ) {
    if (message.channel.type !== 'instagram') {
      return;
    }

    const storyReply = metadata.storyReply;
    const config = this.normaliseStoryReplies(automation.storyReplies);
    if (!storyReply || !config.enabled || !config.message) {
      return;
    }

    const dedupeKey = `meta:auto:story:${message.channelId}:${message.channelMsgId ?? message.id}`;
    const accepted = await this.redis.client.set(dedupeKey, '1', 'EX', 60 * 60 * 24, 'NX');
    if (!accepted) {
      return;
    }

    try {
      const text = this.interpolateAutomationText(config.message, {
        story_id: storyReply.storyId ?? '',
        story_url: storyReply.storyUrl ?? '',
        reply_text: message.text ?? '',
        contact_name:
          [message.conversation.contact.firstName, message.conversation.contact.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() || '',
      });

      await this.outbound.sendMessage({
        workspaceId: message.workspaceId,
        conversationId: message.conversationId,
        channelId: message.channelId,
        text,
        metadata: {
          automation: {
            triggerType: 'story_reply',
            sourceMessageId: message.id,
            story: storyReply,
          },
        },
      });

      await this.activity.record({
        workspaceId: message.workspaceId,
        conversationId: message.conversationId,
        eventType: 'note',
        actorType: 'automation',
        metadata: {
          text: `Automation replied to an Instagram story interaction.\nStory: ${storyReply.storyUrl ?? storyReply.storyId ?? 'unknown'}\nTrigger message: ${message.text ?? '(no text)'}`,
        },
      });

      await this.workflowEngine.trigger({
        workspaceId: message.workspaceId,
        eventType: 'story_reply',
        contactId: message.conversation.contactId,
        conversationId: message.conversationId,
        triggerData: {
          storyId: storyReply.storyId ?? null,
          storyUrl: storyReply.storyUrl ?? null,
          sourceMessageId: message.id,
          text: message.text ?? null,
          channelId: message.channelId,
        },
      });

      this.events.emit('automation.triggered', {
        workspaceId: message.workspaceId,
        channelId: message.channelId,
        channelType: message.channelType,
        conversationId: message.conversationId,
        triggerType: 'story_reply',
        messageId: message.id,
        story: storyReply,
      });
    } catch (error: any) {
      await this.emitAutomationError(message.workspaceId, {
        channelId: message.channelId,
        conversationId: message.conversationId,
        triggerType: 'story_reply',
        error: this.getErrorMessage(error),
        payload: { messageId: message.id, storyReply },
      });
    }
  }

  private async handleMenuClickTrigger(
    message: any,
    automation: ChannelAutomationConfig,
    metadata: Record<string, any>,
  ) {
    const payload =
      metadata.postback?.payload ??
      metadata.quickReply?.payload ??
      metadata.interactive?.payload ??
      null;

    if (!payload || !automation.menuActions?.[payload]) {
      return;
    }

    const action = automation.menuActions[payload];
    const dedupeKey = `meta:auto:menu:${message.channelId}:${message.channelMsgId ?? message.id}:${payload}`;
    const accepted = await this.redis.client.set(dedupeKey, '1', 'EX', 60 * 60, 'NX');
    if (!accepted) {
      return;
    }

    try {
      if (action.kind === 'quick_reply' && action.replyText?.trim()) {
        const text = this.interpolateAutomationText(action.replyText, {
          contact_name:
            [message.conversation.contact.firstName, message.conversation.contact.lastName]
              .filter(Boolean)
              .join(' ')
              .trim() || '',
          payload,
          menu_title: action.title ?? metadata.postback?.title ?? '',
        });

        await this.outbound.sendMessage({
          workspaceId: message.workspaceId,
          conversationId: message.conversationId,
          channelId: message.channelId,
          text,
          metadata: {
            automation: {
              triggerType: 'menu_click',
              payload,
              title: action.title ?? metadata.postback?.title ?? null,
            },
          },
        });
      }

      await this.activity.record({
        workspaceId: message.workspaceId,
        conversationId: message.conversationId,
        eventType: 'note',
        actorType: 'automation',
        metadata: {
          text: `Automation handled a menu click.\nPayload: ${payload}${action.replyText ? `\nReply sent: ${action.replyText}` : ''}`,
        },
      });

      await this.workflowEngine.trigger({
        workspaceId: message.workspaceId,
        eventType: 'menu_click',
        contactId: message.conversation.contactId,
        conversationId: message.conversationId,
        triggerData: {
          payload,
          title: action.title ?? metadata.postback?.title ?? null,
          sourceMessageId: message.id,
          channelId: message.channelId,
        },
      });

      this.events.emit('automation.triggered', {
        workspaceId: message.workspaceId,
        channelId: message.channelId,
        channelType: message.channelType,
        conversationId: message.conversationId,
        triggerType: 'menu_click',
        payload,
        action,
        messageId: message.id,
      });
    } catch (error: any) {
      await this.emitAutomationError(message.workspaceId, {
        channelId: message.channelId,
        conversationId: message.conversationId,
        triggerType: 'menu_click',
        error: this.getErrorMessage(error),
        payload: { payload, messageId: message.id },
      });
    }
  }

  private async sendInstagramCommentReply(channel: any, commentId: string, text: string) {
    const token = this.getAccessToken(channel);
    const senderId =
      (channel.config as any)?.igUserId ??
      (channel.credentials as any)?.igUserId ??
      channel.identifier;

    await axios.post(
      `${IG_GRAPH}/${senderId}/messages`,
      {
        recipient: { comment_id: commentId },
        message: { text },
      },
      {
        params: { access_token: token },
      },
    );
  }

  private async sendMessengerCommentReply(channel: any, commentId: string, text: string) {
    const token = this.getAccessToken(channel);

    await axios.post(
      `${FB_GRAPH}/${commentId}/private_replies`,
      { message: text },
      {
        params: { access_token: token },
      },
    );
  }

  private getAutomationConfig(channel: any): ChannelAutomationConfig {
    const config = (channel.config ?? {}) as Record<string, any>;
    return (config.automation ?? {}) as ChannelAutomationConfig;
  }

  async updateMenuActions(
    channelId: string,
    config: any,
    menuActions: Record<string, MenuActionConfig>,
  ) {
    const automation = this.getAutomationConfig({ config });
    automation.menuActions = menuActions;
    await this.updateAutomationConfig(channelId, config, automation);
  }

  private async updateAutomationConfig(
    channelId: string,
    existingConfig: any,
    automation: ChannelAutomationConfig,
  ) {
    const nextConfig = {
      ...(existingConfig ?? {}),
      automation,
    };

    const channel = await this.prisma.channel.update({
      where: { id: channelId },
      data: { config: nextConfig },
    });

    this.events.emit('channel.config.updated', {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      feature: 'meta_automation',
      config: automation,
    });
  }

  private normalisePrivateReplies(
    input: PrivateRepliesConfig | undefined,
  ): PrivateRepliesConfig {
    return {
      enabled: Boolean(input?.enabled),
      scope: input?.scope === 'selected' ? 'selected' : 'all',
      selectedPostIds: Array.isArray(input?.selectedPostIds)
        ? input!.selectedPostIds.filter(Boolean)
        : [],
      message: String(input?.message ?? ''),
      updatedAt: input?.updatedAt ?? null,
    };
  }

  private normaliseStoryReplies(
    input: StoryRepliesConfig | undefined,
  ): StoryRepliesConfig {
    return {
      enabled: Boolean(input?.enabled),
      message: String(input?.message ?? ''),
      updatedAt: input?.updatedAt ?? null,
    };
  }

  private async findChannel(
    channelId: string,
    workspaceId: string,
    allowedTypes: SupportedAutomationChannel[] = ['messenger', 'instagram'],
  ) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });

    if (
      !channel ||
      channel.workspaceId !== workspaceId ||
      !allowedTypes.includes(channel.type as SupportedAutomationChannel)
    ) {
      throw new NotFoundException('Meta automation channel not found');
    }

    return channel;
  }

  private getAccessToken(channel: any) {
    const token = (channel.credentials as any)?.accessToken;
    if (!token) {
      throw new BadRequestException('Channel access token is missing');
    }
    return token;
  }

  private async allowRateLimitedSend(channelId: string, recipientKey: string) {
    const key = `meta:auto:rate:${channelId}:${recipientKey}`;
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, 60);
    }
    return count <= 10;
  }

  private interpolateAutomationText(
    template: string,
    values: Record<string, string>,
  ) {
    return String(template ?? '').replace(
      /{{\s*([a-zA-Z0-9_]+)\s*}}/g,
      (_match, key: string) => values[key] ?? '',
    );
  }

  private toTargetTitle(text: string | undefined, fallback: string) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
      return fallback;
    }

    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
  }

  private getErrorMessage(error: any) {
    return (
      error?.response?.data?.error?.message ??
      error?.response?.data?.message ??
      error?.message ??
      'Automation request failed'
    );
  }

  private async emitAutomationError(
    workspaceId: string,
    payload: {
      channelId: string;
      conversationId?: string;
      triggerType: string;
      error: string;
      payload?: any;
    },
  ) {
    this.logger.warn(
      `Automation error channel=${payload.channelId} trigger=${payload.triggerType}: ${payload.error}`,
    );

    this.events.emit('automation.error', {
      workspaceId,
      ...payload,
    });
  }
}
