import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';
import { OutboundService } from '../../../outbound/outbound.service';
import { ActivityService } from '../../../activity/activity.service';
import { WorkflowEngineService } from '../../../workflows/workflow-engine.service';
import {
  buildCommonVariableContext,
  renderVariableTemplate,
} from '../../../../common/variables/variable-metadata';

const FB_GRAPH = 'https://graph.facebook.com/v22.0';
const IG_GRAPH = 'https://graph.instagram.com/v22.0';
const ENGAGEMENT_ACTIVITY_TTL_SECONDS = 60 * 60 * 24;
const ENGAGEMENT_ACTIVITY_LIMIT = 100;
const COMMENT_DM_START_PAYLOAD_PREFIX = 'AXO_COMMENT_DM_START';
const COMMENT_DM_FOLLOW_CHECK_PAYLOAD_PREFIX = 'AXO_COMMENT_DM_FOLLOW_CHECK';
const LINK_FOLLOW_UP_DUE_SET = 'meta:auto:link-followup:due';
const LINK_FOLLOW_UP_TTL_SECONDS = 60 * 60 * 24 * 14;
const LINK_FOLLOW_UP_SCAN_LIMIT = 50;
const LINK_FOLLOW_UP_SENT_MARKER_SECONDS = 60 * 30;

type SupportedAutomationChannel = 'messenger' | 'instagram';
type MenuActionKind = 'payload' | 'quick_reply';
type PrivateReplyScope = 'all' | 'selected';
type EngagementActivityType =
  | 'comment_received'
  | 'automation_triggered'
  | 'public_comment_reply_sent'
  | 'private_reply_sent'
  | 'dm_button_clicked'
  | 'follow_gate_sent'
  | 'final_message_sent'
  | 'link_clicked'
  | 'link_follow_up_sent'
  | 'conversation_created';
type EngagementActivityStatus =
  | 'received'
  | 'triggered'
  | 'sent'
  | 'created'
  | 'failed'
  | 'skipped';

export interface PrivateRepliesConfig {
  enabled: boolean;
  scope: PrivateReplyScope;
  keywordFilter: PrivateReplyKeywordFilter;
  commentReply: PrivateReplyCommentReply;
  followGate: PrivateReplyFollowGate;
  dmFlow: PrivateReplyDmFlow;
  selectedPostIds: string[];
  message: string;
  postMessages: PrivateReplyPostMessage[];
  updatedAt?: string | null;
}

type PrivateReplyKeywordMode = 'any' | 'all' | 'exclude';

export interface PrivateReplyKeywordFilter {
  enabled: boolean;
  mode: PrivateReplyKeywordMode;
  keywords: string[];
}

export interface PrivateReplyCommentReply {
  enabled: boolean;
  variants: string[];
}

export interface PrivateReplyFollowGate {
  enabled: boolean;
  prompt: string;
  visitProfileButtonLabel: string;
  confirmButtonLabel: string;
}

type PrivateReplyButtonType = 'url' | 'postback';

export interface PrivateReplyButton {
  type: PrivateReplyButtonType;
  label: string;
  url?: string;
  payload?: string;
}

export interface PrivateReplyDmFlow {
  introMessage: string;
  startButtonLabel: string;
  buttons: PrivateReplyButton[];
  linkFollowUp: PrivateReplyLinkFollowUp;
}

export interface PrivateReplyLinkFollowUp {
  enabled: boolean;
  delayMinutes: number;
  message: string;
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

export interface PrivateReplyPostMessage {
  postId: string;
  message: string;
  keywordFilter?: PrivateReplyKeywordFilter;
  commentReply?: PrivateReplyCommentReply;
  followGate?: PrivateReplyFollowGate;
  dmFlow?: PrivateReplyDmFlow;
  target?: MetaAutomationTarget | null;
  updatedAt?: string | null;
  commentsReceived?: number;
  automatedRepliesSent?: number;
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
  commenterUsername?: string | null;
  raw: any;
}

interface CommentDmPayloadContext {
  ruleKey: string;
  commentId?: string | null;
}

export interface MetaEngagementActivityEvent {
  id: string;
  lifecycleId?: string | null;
  commentId?: string | null;
  type: EngagementActivityType;
  workspaceId: string;
  channelId: string;
  channelType: SupportedAutomationChannel;
  pageName: string;
  pagePictureUrl?: string | null;
  postId?: string | null;
  postSnippet?: string | null;
  postThumbnailUrl?: string | null;
  postPermalink?: string | null;
  postCreatedAt?: string | null;
  commenterName?: string | null;
  commentText?: string | null;
  activityText?: string | null;
  activityLabel?: string | null;
  publicReplyText?: string | null;
  publicReplySentAt?: string | null;
  status: EngagementActivityStatus;
  timestamp: string;
  commentReceivedAt?: string | null;
  replyStatus?: 'pending' | 'sent' | 'failed' | null;
  replySentAt?: string | null;
  conversationId?: string | null;
}

export interface MetaEngagementActivitySummary {
  commentsReceived: number;
  automatedRepliesSent: number;
  activePostAutomations: number;
  engagementEventsToday: number;
}

export interface MetaEngagementActivityPost {
  id: string | null;
  pageName: string;
  pagePictureUrl?: string | null;
  postThumbnailUrl?: string | null;
  postSnippet?: string | null;
  createdAt?: string | null;
  permalink?: string | null;
  commentsReceived: number;
  automatedRepliesSent: number;
  identity: string;
}

export interface MetaEngagementActivityState {
  summary: MetaEngagementActivitySummary;
  selectedPost: MetaEngagementActivityPost | null;
  posts: MetaEngagementActivityPost[];
  events: MetaEngagementActivityEvent[];
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
    const current = this.normalisePrivateReplies(automation.privateReplies);
    const scope = input.scope === 'selected' ? 'selected' : 'all';
    const postMessages = this.preservePrivateReplyPostStats(
      scope === 'selected'
        ? this.normalisePrivateReplyPostMessages(
            input.postMessages,
            input.selectedPostIds,
            input.message,
            true,
          )
        : [],
      current.postMessages,
    );
    const next: PrivateRepliesConfig = {
      enabled: Boolean(input.enabled),
      scope,
      keywordFilter: this.normaliseKeywordFilter(input.keywordFilter),
      commentReply: this.normaliseCommentReply(input.commentReply),
      followGate: this.normaliseFollowGate(input.followGate),
      dmFlow: this.normaliseDmFlow(input.dmFlow),
      selectedPostIds: postMessages.map((item) => item.postId),
      message: String(input.message ?? '').trim(),
      postMessages,
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

   const { data } = await axios.get(`${FB_GRAPH}/${channel.identifier}/posts`, {
  params: {
    fields: 'id,message,story,permalink_url,full_picture,created_time', // ✅ uncommented
    access_token: token, // ✅ page token instead of user token
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

  async getEngagementActivity(
    channelId: string,
    workspaceId: string,
  ): Promise<MetaEngagementActivityState> {
    const channel = await this.findChannel(channelId, workspaceId);
    let config = this.normalisePrivateReplies(
      this.getAutomationConfig(channel).privateReplies,
    );
    const targets = await this.safeListTargets(channelId, workspaceId);
    const events = await this.loadEngagementActivityEvents(channel.id);
    config = await this.backfillPrivateReplyCountersFromEvents(channel, config, events);
    const posts = this.buildEngagementPosts(channel, config, targets);

    return {
      summary: this.buildEngagementSummary(events, config, targets),
      selectedPost: posts[0] ?? null,
      posts,
      events,
    };
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
          commenterName: value.from?.name ?? value.from?.username ?? null,
          commenterUsername: value.from?.username ?? null,
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
          commenterName: value.from?.name ?? value.from?.username ?? null,
          commenterUsername: value.from?.username ?? null,
          raw: change,
        });
      }
    }

    return results;
  }

  async processCommentEvent(channelId: string, workspaceId: string, payload: CommentEventPayload) {
    const channel = await this.findChannel(channelId, workspaceId);
    const config = this.normalisePrivateReplies(this.getAutomationConfig(channel).privateReplies);
    const selectedRule =
      config.scope === 'selected'
        ? this.findMatchingPrivateReplyPostMessage(config, payload.postId)
        : null;
    const messageTemplate =
      config.scope === 'selected' ? selectedRule?.message ?? '' : config.message;
    const keywordFilter =
      config.scope === 'selected'
        ? selectedRule?.keywordFilter ?? this.normaliseKeywordFilter(undefined)
        : config.keywordFilter;
    const commentReply =
      config.scope === 'selected'
        ? selectedRule?.commentReply ?? this.normaliseCommentReply(undefined)
        : config.commentReply;
    const followGate =
      config.scope === 'selected'
        ? selectedRule?.followGate ?? this.normaliseFollowGate(undefined)
        : config.followGate;
    const dmFlow =
      config.scope === 'selected'
        ? selectedRule?.dmFlow ?? this.normaliseDmFlow(undefined)
        : config.dmFlow;

    this.logger.log(
      `Private reply event channel=${channel.id} type=${channel.type} comment=${payload.commentId} post=${payload.postId ?? 'none'} commenter=${payload.commenterId ?? 'unknown'} enabled=${config.enabled} scope=${config.scope} postRules=${config.postMessages.length} hasMessage=${Boolean(messageTemplate)}`,
    );

    if (this.isSelfAuthoredComment(channel, payload)) {
      this.logger.warn(
        `Private reply skipped reason=self_authored_comment channel=${channel.id} comment=${payload.commentId} commenter=${payload.commenterUsername ?? payload.commenterId ?? 'unknown'}`,
      );
      return false;
    }

    await this.recordCommentEngagementActivity(
      channel,
      payload,
      config,
      selectedRule,
      'comment_received',
      'received',
    );

    if (!config.enabled) {
      this.logger.warn(
        `Private reply skipped reason=disabled channel=${channel.id} comment=${payload.commentId}`,
      );
      return false;
    }

    if (config.scope === 'selected') {
      if (!payload.postId || !selectedRule) {
        this.logger.warn(
          `Private reply skipped reason=post_not_selected channel=${channel.id} comment=${payload.commentId} post=${payload.postId ?? 'none'} selected=${config.selectedPostIds.join(',')}`,
        );
        return false;
      }

      if (!selectedRule.message.trim()) {
        this.logger.warn(
          `Private reply skipped reason=empty_post_message channel=${channel.id} comment=${payload.commentId} post=${payload.postId}`,
        );
        return false;
      }
    } else if (!messageTemplate.trim()) {
      this.logger.warn(
        `Private reply skipped reason=empty_message channel=${channel.id} comment=${payload.commentId}`,
      );
      return false;
    }

    if (!this.commentMatchesKeywordFilter(payload.commentText, keywordFilter)) {
      this.logger.warn(
        `Private reply skipped reason=keyword_filter channel=${channel.id} comment=${payload.commentId}`,
      );
      return false;
    }

    const dedupeKey = `meta:auto:comment:${channel.id}:${payload.commentId}`;
    const accepted = await this.redis.client.set(dedupeKey, '1', 'EX', 60 * 60 * 24, 'NX');
    if (!accepted) {
      this.logger.warn(
        `Private reply skipped reason=duplicate channel=${channel.id} comment=${payload.commentId}`,
      );
      return false;
    }

    const recipientKey = payload.commenterId ?? payload.commentId;
    const withinLimit = await this.allowRateLimitedSend(channel.id, recipientKey);
    if (!withinLimit) {
      this.logger.warn(
        `Private reply skipped reason=rate_limited channel=${channel.id} recipient=${recipientKey}`,
      );
      await this.emitAutomationError(channel.workspaceId, {
        channelId: channel.id,
        triggerType: 'comment',
        error: 'Automation rate limit reached. Retry in a moment.',
        payload,
      });
      return false;
    }

    const message = renderVariableTemplate(messageTemplate, {
      comment: { text: payload.commentText ?? '' },
      post: { id: payload.postId ?? '' },
      commenter: {
        name: payload.commenterName ?? payload.commenterUsername ?? '',
        username: payload.commenterUsername ?? payload.commenterName ?? '',
      },
    }) ?? '';

    try {
      await this.recordCommentEngagementActivity(
        channel,
        payload,
        config,
        selectedRule,
        'automation_triggered',
        'triggered',
      );

      this.logger.log(
        `Private reply sending channel=${channel.id} type=${channel.type} comment=${payload.commentId} textLength=${message.length}`,
      );
      const ruleKey = selectedRule?.postId ?? 'all';
      if (channel.type === 'instagram') {
        const publicReplyText = await this.sendPublicCommentReplyIfEnabled(
          channel,
          payload,
          commentReply,
          ruleKey,
        );
        if (publicReplyText) {
          await this.recordPublicCommentReplyEngagementActivity(
            channel,
            payload,
            config,
            selectedRule,
            publicReplyText,
          );
        }
        if (followGate.enabled) {
          await this.sendInstagramCommentReplyWithQuickReplies(
            channel,
            payload.commentId,
            this.renderCommentTemplate(dmFlow.introMessage, payload),
            [
              {
                label: dmFlow.startButtonLabel,
                payload: this.buildCommentDmPayload(
                  COMMENT_DM_START_PAYLOAD_PREFIX,
                  ruleKey,
                  payload.commentId,
                ),
              },
            ],
          );
        } else {
          await this.sendInstagramCommentReplyMessage(
            channel,
            payload.commentId,
            await this.buildTrackedInstagramButtonMessage({
              channel,
              recipientId: payload.commenterId ?? payload.commentId,
              text: message,
              buttons: this.getFinalMessageButtons(dmFlow, followGate),
          linkFollowUp: dmFlow.linkFollowUp,
          context: {
            workspaceId: channel.workspaceId,
            channelId: channel.id,
            ruleKey,
            commentId: payload.commentId,
          },
        }),
      );
        }
      } else {
        const publicReplyText = await this.sendPublicCommentReplyIfEnabled(
          channel,
          payload,
          commentReply,
          ruleKey,
        );
        if (publicReplyText) {
          await this.recordPublicCommentReplyEngagementActivity(
            channel,
            payload,
            config,
            selectedRule,
            publicReplyText,
          );
        }
        await this.sendMessengerCommentReply(channel, payload.commentId, message);
      }

      this.logger.log(
        `Processed ${channel.type} private reply for channel=${channel.id} comment=${payload.commentId}`,
      );

      await this.recordCommentEngagementActivity(
        channel,
        payload,
        config,
        selectedRule,
        'private_reply_sent',
        'sent',
      );

      this.events.emit('automation.triggered', {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        channelType: channel.type,
        triggerType: 'comment',
        recipientId: payload.commenterId ?? null,
        externalId: payload.commentId,
        postId: payload.postId ?? null,
        replyRulePostId: selectedRule?.postId ?? null,
        message,
      });

      return true;
    } catch (error: any) {
      this.logger.error(
        `Private reply failed channel=${channel.id} type=${channel.type} comment=${payload.commentId}: ${this.getErrorMessage(error)}`,
        this.getProviderErrorDebug(error),
      );
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
    const hasStoryReply = Boolean(metadata.storyReply);
    const menuPayload =
      metadata.postback?.payload ??
      metadata.quickReply?.payload ??
      metadata.interactive?.payload ??
      null;

    this.logger.log(
      `Inbound automation check channel=${message.channelId} type=${message.channel.type} message=${message.id} storyReply=${hasStoryReply} menuPayload=${menuPayload ?? 'none'}`,
    );

    await this.recordConversationCreatedEngagementActivity(message);
    await this.handleStoryReplyTrigger(message, automation, metadata);
    await this.handleCommentDmButtonTrigger(message, automation, metadata);
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
    if (!storyReply) {
      return;
    }

    this.logger.log(
      `Story reply event channel=${message.channelId} message=${message.id} story=${storyReply.storyId ?? storyReply.storyUrl ?? 'unknown'} enabled=${config.enabled} hasMessage=${Boolean(config.message)}`,
    );

    if (!config.enabled) {
      this.logger.warn(
        `Story reply skipped reason=disabled channel=${message.channelId} message=${message.id}`,
      );
      return;
    }

    if (!config.message) {
      this.logger.warn(
        `Story reply skipped reason=empty_message channel=${message.channelId} message=${message.id}`,
      );
      return;
    }

    const dedupeKey = `meta:auto:story:${message.channelId}:${message.channelMsgId ?? message.id}`;
    const accepted = await this.redis.client.set(dedupeKey, '1', 'EX', 60 * 60 * 24, 'NX');
    if (!accepted) {
      this.logger.warn(
        `Story reply skipped reason=duplicate channel=${message.channelId} message=${message.id}`,
      );
      return;
    }

    try {
      const text = renderVariableTemplate(config.message, {
        ...buildCommonVariableContext({
          contact: message.conversation.contact,
        }),
        story: {
          id: storyReply.storyId ?? '',
          url: storyReply.storyUrl ?? '',
        },
        message: { text: message.text ?? '' },
      }) ?? '';

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
      this.logger.log(
        `Story reply sent channel=${message.channelId} message=${message.id} textLength=${text.length}`,
      );

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
      this.logger.error(
        `Story reply failed channel=${message.channelId} message=${message.id}: ${this.getErrorMessage(error)}`,
        this.getProviderErrorDebug(error),
      );
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
        const text = renderVariableTemplate(action.replyText, {
          ...buildCommonVariableContext({
            contact: message.conversation.contact,
          }),
          menu: {
            payload,
            title: action.title ?? metadata.postback?.title ?? '',
          },
        }) ?? '';

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

  private async handleCommentDmButtonTrigger(
    message: any,
    automation: ChannelAutomationConfig,
    metadata: Record<string, any>,
  ) {
    if (message.channel.type !== 'instagram') {
      return;
    }

    const payload =
      metadata.postback?.payload ??
      metadata.quickReply?.payload ??
      metadata.interactive?.payload ??
      null;
    if (
      !payload ||
      (!String(payload).startsWith(COMMENT_DM_START_PAYLOAD_PREFIX) &&
        !String(payload).startsWith(COMMENT_DM_FOLLOW_CHECK_PAYLOAD_PREFIX))
    ) {
      return;
    }

    try {
      const payloadContext = this.parseCommentDmPayload(payload);
      const ruleKey = payloadContext.ruleKey;
      const sourceCommentId = payloadContext.commentId ?? null;
      const config = this.normalisePrivateReplies(automation.privateReplies);
      const selectedRule =
        ruleKey && ruleKey !== 'all'
          ? this.findMatchingPrivateReplyPostMessage(config, ruleKey)
          : null;
      const messageTemplate =
        config.scope === 'selected' ? selectedRule?.message ?? '' : config.message;
      const followGate =
        config.scope === 'selected'
          ? selectedRule?.followGate ?? this.normaliseFollowGate(undefined)
          : config.followGate;
      const dmFlow =
        config.scope === 'selected'
          ? selectedRule?.dmFlow ?? this.normaliseDmFlow(undefined)
          : config.dmFlow;

      if (!config.enabled || !messageTemplate.trim()) {
        this.logger.warn(
          `Comment DM button skipped reason=disabled_or_empty channel=${message.channelId} payload=${payload}`,
        );
        return;
      }

      const contactChannel = await this.getConversationContactChannel(message);
      if (!contactChannel?.identifier) {
        this.logger.warn(
          `Comment DM button skipped reason=missing_contact_channel channel=${message.channelId} conversation=${message.conversationId}`,
        );
        return;
      }

      const follows = await this.isInstagramScopedIdFollowingBusiness(
        message.channel,
        contactChannel.identifier,
      );

      if (followGate.enabled && !follows) {
        await this.sendInstagramFollowGatePrompt({
          message,
          contactIdentifier: contactChannel.identifier,
          contactDisplayName: contactChannel.displayName,
          followGate,
          ruleKey,
          sourceCommentId,
        });
        await this.recordCommentDmFlowEngagementActivity({
          message,
          type: 'follow_gate_sent',
          status: 'sent',
          activityLabel: 'Follow gate sent',
          activityText:
            renderVariableTemplate(followGate.prompt, {
              ...buildCommonVariableContext({
                contact: message.conversation.contact,
              }),
              commenter: {
                name: message.conversation.contact?.firstName ?? '',
                username:
                  contactChannel.displayName ?? contactChannel.identifier,
              },
            }) ?? followGate.prompt,
          ruleKey,
          sourceCommentId,
          selectedRule,
        });
        this.logger.log(
          `Comment DM follow gate prompt sent channel=${message.channelId} contact=${contactChannel.identifier} payload=${payload}`,
        );
        return;
      }

      const finalMessageText =
        renderVariableTemplate(messageTemplate, {
          ...buildCommonVariableContext({
            contact: message.conversation.contact,
          }),
          commenter: {
            name: message.conversation.contact?.firstName ?? '',
            username: contactChannel.displayName ?? contactChannel.identifier,
          },
        }) ?? messageTemplate;

      await this.sendInstagramMessageToRecipient(
        message.channel,
        contactChannel.identifier,
        await this.buildTrackedInstagramButtonMessage({
          channel: message.channel,
          recipientId: contactChannel.identifier,
          text: finalMessageText,
          buttons: this.getFinalMessageButtons(dmFlow, followGate),
          linkFollowUp: dmFlow.linkFollowUp,
          context: {
            workspaceId: message.workspaceId,
            channelId: message.channelId,
            conversationId: message.conversationId,
            ruleKey,
            commentId: sourceCommentId,
          },
        }),
      );
      await this.recordCommentDmFlowEngagementActivity({
        message,
        type: 'final_message_sent',
        status: 'sent',
        activityLabel: 'Final DM sent',
        activityText: finalMessageText,
        ruleKey,
        sourceCommentId,
        selectedRule,
      });
      this.logger.log(
        `Comment DM final message sent channel=${message.channelId} contact=${contactChannel.identifier} payload=${payload}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Comment DM button flow failed channel=${message.channelId} message=${message.id}: ${this.getErrorMessage(error)}`,
        this.getProviderErrorDebug(error),
      );
      await this.emitAutomationError(message.workspaceId, {
        channelId: message.channelId,
        conversationId: message.conversationId,
        triggerType: 'comment_dm_button',
        error: this.getErrorMessage(error),
        payload: { payload, messageId: message.id },
      });
    }
  }

  private async sendInstagramFollowGatePrompt({
    message,
    contactIdentifier,
    contactDisplayName,
    followGate,
    ruleKey,
    sourceCommentId,
  }: {
    message: any;
    contactIdentifier: string;
    contactDisplayName?: string | null;
    followGate: PrivateReplyFollowGate;
    ruleKey: string;
    sourceCommentId?: string | null;
  }) {
    await this.sendInstagramMessageToRecipient(
      message.channel,
      contactIdentifier,
      this.buildInstagramButtonMessage(
        renderVariableTemplate(followGate.prompt, {
          ...buildCommonVariableContext({
            contact: message.conversation.contact,
          }),
          commenter: {
            name: message.conversation.contact?.firstName ?? '',
            username: contactDisplayName ?? contactIdentifier,
          },
        }) ?? followGate.prompt,
        [
          {
            type: 'url',
            label: followGate.visitProfileButtonLabel,
            url: this.getInstagramProfileUrl(message.channel),
          },
          {
            type: 'postback',
            label: followGate.confirmButtonLabel,
            payload: this.buildCommentDmPayload(
              COMMENT_DM_FOLLOW_CHECK_PAYLOAD_PREFIX,
              ruleKey,
              sourceCommentId,
            ),
          },
        ],
      ),
    );
  }

  private async sendInstagramCommentReply(channel: any, commentId: string, text: string) {
    return this.sendInstagramCommentReplyMessage(channel, commentId, { text });
  }

  private async sendInstagramCommentReplyWithQuickReplies(
    channel: any,
    commentId: string,
    text: string,
    quickReplies: Array<{ label: string; payload: string }>,
  ) {
    return this.sendInstagramCommentReplyMessage(channel, commentId, {
      text,
      quick_replies: quickReplies.map((reply) => ({
        content_type: 'text',
        title: reply.label.slice(0, 20),
        payload: reply.payload,
      })),
    });
  }

  private async sendInstagramCommentReplyMessage(
    channel: any,
    commentId: string,
    message: Record<string, unknown>,
  ) {
    const token = this.getAccessToken(channel);
    const senderId =
      (channel.config as any)?.igUserId ??
      (channel.credentials as any)?.igUserId ??
      channel.identifier;
    const url = `${IG_GRAPH}/${senderId}/messages`;
    const textLength =
      typeof message.text === 'string' ? message.text.length : 0;

    this.logger.log(
      `Instagram private reply API request sender=${senderId} comment=${commentId} textLength=${textLength}`,
    );
    const { data } = await axios.post(
      url,
      {
        recipient: { comment_id: commentId },
        message,
        messaging_type: 'RESPONSE',
      },
      {
        params: { access_token: token },
      },
    );
    this.logger.log(
      `Instagram private reply API accepted sender=${senderId} comment=${commentId} response=${this.safeJson(data)}`,
    );
    return data;
  }

  private async sendInstagramMessageToRecipient(
    channel: any,
    recipientId: string,
    message: Record<string, unknown>,
  ) {
    const token = this.getAccessToken(channel);
    const senderId =
      (channel.config as any)?.igUserId ??
      (channel.credentials as any)?.igUserId ??
      channel.identifier;
    const { data } = await axios.post(
      `${IG_GRAPH}/${senderId}/messages`,
      {
        recipient: { id: recipientId },
        message,
        messaging_type: 'RESPONSE',
      },
      { params: { access_token: token } },
    );
    return data;
  }

  private async sendPublicCommentReplyIfEnabled(
    channel: any,
    payload: CommentEventPayload,
    config: PrivateReplyCommentReply,
    ruleKey: string,
  ): Promise<string | null> {
    if (!config.enabled || config.variants.length === 0) {
      return null;
    }

    const replyLockKey = `meta:auto:comment-public-reply:${channel.id}:${payload.commentId}`;
    const replyLockAccepted = await this.redis.client.set(
      replyLockKey,
      '1',
      'EX',
      60 * 60 * 24,
      'NX',
    );
    if (!replyLockAccepted) {
      this.logger.warn(
        `Public comment reply skipped reason=duplicate_public_reply channel=${channel.id} comment=${payload.commentId}`,
      );
      return null;
    }

    const counterKey = `meta:auto:comment-reply:variant:${channel.id}:${ruleKey}`;
    const count = await this.redis.client.incr(counterKey);
    if (count === 1) {
      await this.redis.client.expire(counterKey, 60 * 60 * 24 * 30);
    }
    const template = config.variants[(count - 1) % config.variants.length];
    const text = this.renderCommentTemplate(template, payload);

    if (!text.trim()) {
      return null;
    }

    try {
      if (channel.type === 'instagram') {
        await this.sendInstagramPublicCommentReply(channel, payload.commentId, text);
      } else {
        await this.sendMessengerPublicCommentReply(channel, payload.commentId, text);
      }
      return text;
    } catch (error: any) {
      this.logger.warn(
        `Public comment reply failed channel=${channel.id} type=${channel.type} comment=${payload.commentId}: ${this.getErrorMessage(error)}`,
      );
      return null;
    }
  }

  private isSelfAuthoredComment(channel: any, payload: CommentEventPayload) {
    const ownIds = [
      channel.identifier,
      (channel.config as any)?.igUserId,
      (channel.config as any)?.pageId,
      (channel.config as any)?.businessAccountId,
      (channel.credentials as any)?.igUserId,
      (channel.credentials as any)?.pageId,
      (channel.credentials as any)?.businessAccountId,
    ]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
    const commenterId = String(payload.commenterId ?? '').trim();
    if (commenterId && ownIds.includes(commenterId)) {
      return true;
    }

    const ownUsernames = [
      channel.name,
      (channel.config as any)?.userName,
      (channel.config as any)?.username,
      (channel.config as any)?.igUsername,
      (channel.config as any)?.instagramUsername,
      (channel.config as any)?.accountUsername,
      (channel.config as any)?.profileUsername,
      (channel.config as any)?.pageName,
      (channel.credentials as any)?.userName,
      (channel.credentials as any)?.username,
      (channel.credentials as any)?.igUsername,
      (channel.credentials as any)?.instagramUsername,
    ]
      .map((value) => this.normaliseInstagramUsername(value))
      .filter(Boolean);
    const commenterUsername = this.normaliseInstagramUsername(
      payload.commenterUsername ?? payload.commenterName,
    );

    return Boolean(
      commenterUsername && ownUsernames.includes(commenterUsername),
    );
  }

  private normaliseInstagramUsername(value: unknown) {
    return String(value ?? '')
      .trim()
      .replace(/^@/, '')
      .toLocaleLowerCase();
  }

  private async isInstagramScopedIdFollowingBusiness(
    channel: any,
    scopedId: string,
  ) {
    const token = this.getAccessToken(channel);
    try {
      const { data } = await axios.get(`${IG_GRAPH}/${scopedId}`, {
        params: {
          fields: 'username,is_user_follow_business',
          access_token: token,
        },
      });
      return Boolean(data?.is_user_follow_business);
    } catch (error: any) {
      this.logger.warn(
        `Instagram follow gate profile check failed channel=${channel.id} scopedId=${scopedId}: ${this.getErrorMessage(error)}`,
      );
      return false;
    }
  }

  private async getConversationContactChannel(message: any) {
    return this.prisma.contactChannel.findFirst({
      where: {
        workspaceId: message.workspaceId,
        channelId: message.channelId,
        contactId: message.conversation.contactId,
      },
    });
  }

  private getInstagramProfileUrl(channel: any) {
    const username =
      (channel.config as any)?.userName ??
      (channel.config as any)?.username ??
      channel.name;
    const cleanUsername = String(username ?? '').replace(/^@/, '').trim();
    return cleanUsername
      ? `https://www.instagram.com/${cleanUsername}/`
      : 'https://www.instagram.com/';
  }

  async resolveTrackedLink(channelId: string, token: string) {
    const tokenKey = this.linkFollowUpTokenKey(token);
    const tokenPayload = await this.redis.client.get(tokenKey);
    if (!tokenPayload) {
      return null;
    }

    const tokenState = this.safeParseJson(tokenPayload);
    const url = String(tokenState.url ?? '').trim();
    const groupId = String(tokenState.groupId ?? '').trim();
    if (!url || !groupId) {
      return null;
    }

    const groupKey = this.linkFollowUpGroupKey(groupId);
    const groupPayload = await this.redis.client.get(groupKey);
    if (groupPayload) {
      const groupState = this.safeParseJson(groupPayload);
      if (String(groupState.channelId ?? '') === String(channelId)) {
        groupState.clickedAt = new Date().toISOString();
        await this.redis.client.set(
          groupKey,
          JSON.stringify(groupState),
          'EX',
          LINK_FOLLOW_UP_TTL_SECONDS,
        );
        await this.redis.client.zrem(LINK_FOLLOW_UP_DUE_SET, groupId);
        await this.clearActiveTrackedLinkFollowUp(groupState, groupId);
        await this.removeTrackedLinkFollowUpFromIndex(groupState, groupId);
        await this.recordTrackedLinkEngagementActivity(
          groupState,
          'link_clicked',
          'Tracked link opened',
          url,
        );
      }
    }

    return url;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processTrackedLinkFollowUps() {
    const dueGroupIds = await this.redis.client.zrangebyscore(
      LINK_FOLLOW_UP_DUE_SET,
      '-inf',
      Date.now(),
      'LIMIT',
      0,
      LINK_FOLLOW_UP_SCAN_LIMIT,
    );

    for (const groupId of dueGroupIds) {
      const lockKey = `${this.linkFollowUpGroupKey(groupId)}:lock`;
      const locked = await this.redis.client.set(lockKey, '1', 'EX', 120, 'NX');
      if (!locked) {
        continue;
      }

      try {
        await this.processTrackedLinkFollowUp(groupId);
      } catch (error: any) {
        this.logger.error(
          `Tracked link follow-up failed group=${groupId}: ${this.getErrorMessage(error)}`,
          this.getProviderErrorDebug(error),
        );
      }
    }
  }

  private async processTrackedLinkFollowUp(groupId: string) {
    const groupKey = this.linkFollowUpGroupKey(groupId);
    const payload = await this.redis.client.get(groupKey);
    if (!payload) {
      await this.redis.client.zrem(LINK_FOLLOW_UP_DUE_SET, groupId);
      return;
    }

    const state = this.safeParseJson(payload);
    const activeGroupId = await this.getActiveTrackedLinkFollowUpGroupId(state);
    if (activeGroupId && activeGroupId !== groupId) {
      await this.redis.client.zrem(LINK_FOLLOW_UP_DUE_SET, groupId);
      await this.removeTrackedLinkFollowUpFromIndex(state, groupId);
      return;
    }

    if (state.clickedAt || state.sentAt || state.supersededAt) {
      await this.redis.client.zrem(LINK_FOLLOW_UP_DUE_SET, groupId);
      await this.removeTrackedLinkFollowUpFromIndex(state, groupId);
      return;
    }

    const channel = await this.prisma.channel.findFirst({
      where: {
        id: String(state.channelId ?? ''),
        workspaceId: String(state.workspaceId ?? ''),
      },
    });
    const recipientId = String(state.recipientId ?? '').trim();
    const followUpMessage = String(state.followUpMessage ?? '').trim();

    if (!channel || channel.type !== 'instagram' || !recipientId || !followUpMessage) {
      await this.redis.client.zrem(LINK_FOLLOW_UP_DUE_SET, groupId);
      await this.removeTrackedLinkFollowUpFromIndex(state, groupId);
      return;
    }

    const sentMarkerKey = this.linkFollowUpSentMarkerKey(state);
    const sendAccepted = await this.redis.client.set(
      sentMarkerKey,
      '1',
      'EX',
      LINK_FOLLOW_UP_SENT_MARKER_SECONDS,
      'NX',
    );
    if (!sendAccepted) {
      await this.redis.client.zrem(LINK_FOLLOW_UP_DUE_SET, groupId);
      await this.removeTrackedLinkFollowUpFromIndex(state, groupId);
      return;
    }

    try {
      await this.sendInstagramMessageToRecipient(channel, recipientId, {
        text: followUpMessage,
      });
    } catch (error) {
      await this.redis.client.del(sentMarkerKey);
      throw error;
    }

    state.sentAt = new Date().toISOString();
    await this.redis.client.set(
      groupKey,
      JSON.stringify(state),
      'EX',
      LINK_FOLLOW_UP_TTL_SECONDS,
    );
    await this.redis.client.zrem(LINK_FOLLOW_UP_DUE_SET, groupId);
    await this.clearActiveTrackedLinkFollowUp(state, groupId);
    await this.removeTrackedLinkFollowUpFromIndex(state, groupId);
    await this.recordTrackedLinkEngagementActivity(
      state,
      'link_follow_up_sent',
      'Link follow-up sent',
      followUpMessage,
    );
    this.logger.log(
      `Tracked link follow-up sent channel=${channel.id} recipient=${recipientId} group=${groupId}`,
    );
  }

  private buildTrackedLinkUrl(channelId: string, token: string) {
    return `${this.getPublicApiBaseUrl()}/api/channels/${encodeURIComponent(
      channelId,
    )}/meta/automation/link/${encodeURIComponent(token)}`;
  }

  private async recordTrackedLinkEngagementActivity(
    state: Record<string, any>,
    type: Extract<EngagementActivityType, 'link_clicked' | 'link_follow_up_sent'>,
    activityLabel: string,
    activityText?: string | null,
  ) {
    const workspaceId = String(state.workspaceId ?? '').trim();
    const channelId = String(state.channelId ?? '').trim();
    if (!workspaceId || !channelId) {
      return;
    }

    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
    });
    if (!channel || !['instagram', 'messenger'].includes(channel.type)) {
      return;
    }

    let commenterName = 'Customer';
    const conversationId = this.toOptionalString(state.conversationId);
    if (conversationId) {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: conversationId, workspaceId },
        select: {
          contact: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
            },
          },
        },
      });
      commenterName =
        [
          conversation?.contact?.firstName,
          conversation?.contact?.lastName,
        ]
          .filter(Boolean)
          .join(' ')
          .trim() ||
        conversation?.contact?.email ||
        conversation?.contact?.phone ||
        commenterName;
    }

    const ruleKey = String(state.ruleKey ?? 'all');
    await this.persistEngagementActivity(
      {
        id: randomUUID(),
        lifecycleId: this.toOptionalString(state.lifecycleId),
        commentId: this.toOptionalString(state.commentId),
        type,
        workspaceId,
        channelId,
        channelType: channel.type as SupportedAutomationChannel,
        pageName: this.getMetaPageName(channel),
        pagePictureUrl: this.getMetaPagePictureUrl(channel),
        postId: ruleKey !== 'all' ? ruleKey : null,
        postSnippet: null,
        postThumbnailUrl: null,
        postPermalink: null,
        postCreatedAt: null,
        commenterName,
        commentText: null,
        activityText: this.toSnippet(activityText, 220),
        activityLabel,
        status: type === 'link_follow_up_sent' ? 'sent' : 'triggered',
        timestamp: new Date().toISOString(),
        conversationId,
      },
      `meta:engagement:tracked-link:${channelId}:${state.id ?? state.groupId ?? state.signature}:${type}`,
    );
  }

  private getPublicApiBaseUrl() {
    return (
      process.env.PUBLIC_API_BASE_URL ??
      process.env.BACKEND_PUBLIC_URL ??
      process.env.AUTH_API_BASE_URL ??
      process.env.API_BASE_URL ??
      process.env.APP_URL ??
      'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  private linkFollowUpTokenKey(token: string) {
    return `meta:auto:link-followup:token:${token}`;
  }

  private linkFollowUpGroupKey(groupId: string) {
    return `meta:auto:link-followup:group:${groupId}`;
  }

  private linkFollowUpSignature(input: {
    workspaceId: string;
    channelId: string;
    recipientId: string;
    ruleKey: string;
  }) {
    return Buffer.from(
      JSON.stringify([
        input.workspaceId,
        input.channelId,
        input.recipientId,
        input.ruleKey,
      ]),
    ).toString('base64url');
  }

  private linkFollowUpActiveKey(input: {
    workspaceId: string;
    channelId: string;
    recipientId: string;
    ruleKey: string;
  }) {
    return `meta:auto:link-followup:active:${this.linkFollowUpSignature(input)}`;
  }

  private linkFollowUpIndexKey(input: {
    workspaceId: string;
    channelId: string;
    recipientId: string;
    ruleKey: string;
  }) {
    return `meta:auto:link-followup:index:${this.linkFollowUpSignature(input)}`;
  }

  private linkFollowUpKeyFromState(
    state: Record<string, any>,
    kind: 'active' | 'index' | 'sent',
  ) {
    const signature =
      String(state.signature ?? '').trim() ||
      this.linkFollowUpSignature({
        workspaceId: String(state.workspaceId ?? ''),
        channelId: String(state.channelId ?? ''),
        recipientId: String(state.recipientId ?? ''),
        ruleKey: String(state.ruleKey ?? 'all'),
      });

    return `meta:auto:link-followup:${kind}:${signature}`;
  }

  private linkFollowUpSentMarkerKey(state: Record<string, any>) {
    return this.linkFollowUpKeyFromState(state, 'sent');
  }

  private async cancelActiveTrackedLinkFollowUps(input: {
    workspaceId: string;
    channelId: string;
    recipientId: string;
    ruleKey: string;
    reason: string;
  }) {
    const activeKey = this.linkFollowUpActiveKey(input);
    const indexKey = this.linkFollowUpIndexKey(input);
    const activeGroupId = await this.redis.client.get(activeKey);
    const indexedGroupIds = await this.redis.client.smembers(indexKey);
    const groupIds = Array.from(
      new Set([activeGroupId, ...indexedGroupIds].filter(Boolean) as string[]),
    );

    for (const groupId of groupIds) {
      await this.redis.client.zrem(LINK_FOLLOW_UP_DUE_SET, groupId);
      await this.markTrackedLinkFollowUpSuperseded(groupId, input.reason);
    }

    await this.redis.client.del(activeKey);
    await this.redis.client.del(indexKey);
  }

  private async markTrackedLinkFollowUpSuperseded(
    groupId: string,
    reason: string,
  ) {
    const groupKey = this.linkFollowUpGroupKey(groupId);
    const payload = await this.redis.client.get(groupKey);
    if (!payload) {
      return;
    }

    const state = this.safeParseJson(payload);
    state.supersededAt = new Date().toISOString();
    state.supersededReason = reason;
    await this.redis.client.set(
      groupKey,
      JSON.stringify(state),
      'EX',
      LINK_FOLLOW_UP_TTL_SECONDS,
    );
  }

  private async getActiveTrackedLinkFollowUpGroupId(
    state: Record<string, any>,
  ) {
    return this.redis.client.get(this.linkFollowUpKeyFromState(state, 'active'));
  }

  private async clearActiveTrackedLinkFollowUp(
    state: Record<string, any>,
    groupId: string,
  ) {
    const activeKey = this.linkFollowUpKeyFromState(state, 'active');
    const activeGroupId = await this.redis.client.get(activeKey);
    if (activeGroupId === groupId) {
      await this.redis.client.del(activeKey);
    }
  }

  private async removeTrackedLinkFollowUpFromIndex(
    state: Record<string, any>,
    groupId: string,
  ) {
    await this.redis.client.srem(
      this.linkFollowUpKeyFromState(state, 'index'),
      groupId,
    );
  }

  private safeParseJson(value: string): Record<string, any> {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private async sendInstagramPublicCommentReply(
    channel: any,
    commentId: string,
    text: string,
  ) {
    const token = this.getAccessToken(channel);
    const { data } = await axios.post(
      `${IG_GRAPH}/${commentId}/replies`,
      { message: text },
      { params: { access_token: token } },
    );
    return data;
  }

  private async sendMessengerPublicCommentReply(
    channel: any,
    commentId: string,
    text: string,
  ) {
    const token = this.getAccessToken(channel);
    const { data } = await axios.post(
      `${FB_GRAPH}/${commentId}/comments`,
      { message: text },
      { params: { access_token: token } },
    );
    return data;
  }

 private async sendMessengerCommentReply(channel: any, commentId: string, text: string) {
  const token = this.getAccessToken(channel);
  const pageId = channel.identifier;

  // ✅ Use Send API with recipient.comment_id — NOT /private_replies endpoint
  const url = `${FB_GRAPH}/${pageId}/messages`;

  this.logger.log(
    `Messenger private reply API request page=${pageId} comment=${commentId} textLength=${text.length}`,
  );

  const { data } = await axios.post(
    url,
    {
      recipient: { comment_id: commentId }, // ✅ full comment_id here
      message: { text },
      messaging_type: 'RESPONSE',
    },
    {
      params: { access_token: token },
    },
  );

  this.logger.log(
    `Messenger private reply API accepted page=${pageId} comment=${commentId} response=${this.safeJson(data)}`,
  );

  return data;
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
    const postMessages = this.normalisePrivateReplyPostMessages(
      input?.postMessages,
      input?.selectedPostIds,
      input?.message,
      false,
    );
    const selectedPostIds =
      postMessages.length > 0
        ? postMessages.map((item) => item.postId)
        : Array.isArray(input?.selectedPostIds)
          ? input!.selectedPostIds.filter(Boolean)
          : [];

    return {
      enabled: Boolean(input?.enabled),
      scope: input?.scope === 'selected' ? 'selected' : 'all',
      keywordFilter: this.normaliseKeywordFilter(input?.keywordFilter),
      commentReply: this.normaliseCommentReply(input?.commentReply),
      followGate: this.normaliseFollowGate(input?.followGate),
      dmFlow: this.normaliseDmFlow(input?.dmFlow),
      selectedPostIds,
      message: String(input?.message ?? ''),
      postMessages,
      updatedAt: input?.updatedAt ?? null,
    };
  }

  private normalisePrivateReplyPostMessages(
    input: unknown,
    selectedPostIds: unknown,
    fallbackMessage: unknown,
    rejectDuplicates: boolean,
  ): PrivateReplyPostMessage[] {
    const seen = new Set<string>();
    const result: PrivateReplyPostMessage[] = [];

    if (Array.isArray(input) && input.length > 0) {
      for (const item of input) {
        const record =
          item && typeof item === 'object'
            ? (item as Record<string, unknown>)
            : {};
        const postId = String(record.postId ?? '').trim();
        if (!postId) continue;

        if (seen.has(postId)) {
          if (rejectDuplicates) {
            throw new BadRequestException(
              'Only one private reply message is allowed per post',
            );
          }
          continue;
        }

        seen.add(postId);
        result.push({
          postId,
          message: String(record.message ?? '').trim(),
          keywordFilter: this.normaliseKeywordFilter(record.keywordFilter),
          commentReply: this.normaliseCommentReply(record.commentReply),
          followGate: this.normaliseFollowGate(record.followGate),
          dmFlow: this.normaliseDmFlow(record.dmFlow),
          target: this.normaliseTargetSnapshot(record.target),
          updatedAt: String(record.updatedAt ?? '').trim() || null,
          commentsReceived: this.toNonNegativeInteger(record.commentsReceived),
          automatedRepliesSent: this.toNonNegativeInteger(
            record.automatedRepliesSent,
          ),
        });
      }

      return result;
    }

    if (Array.isArray(selectedPostIds)) {
      const message = String(fallbackMessage ?? '').trim();
      for (const value of selectedPostIds) {
        const postId = String(value ?? '').trim();
        if (!postId || seen.has(postId)) continue;
        seen.add(postId);
        result.push({
          postId,
          message,
          keywordFilter: this.normaliseKeywordFilter(undefined),
          commentReply: this.normaliseCommentReply(undefined),
          followGate: this.normaliseFollowGate(undefined),
          dmFlow: this.normaliseDmFlow(undefined),
          target: null,
          updatedAt: null,
          commentsReceived: 0,
          automatedRepliesSent: 0,
        });
      }
    }

    return result;
  }

  private preservePrivateReplyPostStats(
    postMessages: PrivateReplyPostMessage[],
    existingPostMessages: PrivateReplyPostMessage[],
  ) {
    return postMessages.map((item) => {
      const existing = existingPostMessages.find((candidate) =>
        this.postIdsMatch(candidate.postId, item.postId),
      );

      return {
        ...item,
        commentsReceived:
          existing?.commentsReceived ?? item.commentsReceived ?? 0,
        automatedRepliesSent:
          existing?.automatedRepliesSent ?? item.automatedRepliesSent ?? 0,
      };
    });
  }

  private normaliseKeywordFilter(input: unknown): PrivateReplyKeywordFilter {
    const record = this.asRecord(input);
    const modeValue = String(record.mode ?? 'any');
    const mode: PrivateReplyKeywordMode =
      modeValue === 'all' || modeValue === 'exclude' ? modeValue : 'any';
    const keywords = Array.isArray(record.keywords)
      ? Array.from(
          new Set(
            record.keywords
              .map((keyword) => String(keyword ?? '').trim())
              .filter(Boolean),
          ),
        ).slice(0, 25)
      : [];

    return {
      enabled: Boolean(record.enabled) && keywords.length > 0,
      mode,
      keywords,
    };
  }

  private normaliseCommentReply(input: unknown): PrivateReplyCommentReply {
    const record = this.asRecord(input);
    const variants = Array.isArray(record.variants)
      ? record.variants
          .map((variant) => String(variant ?? '').trim())
          .filter(Boolean)
          .slice(0, 10)
      : [];

    return {
      enabled: Boolean(record.enabled) && variants.length >= 5,
      variants,
    };
  }

  private normaliseFollowGate(input: unknown): PrivateReplyFollowGate {
    const record = this.asRecord(input);
    return {
      enabled: Boolean(record.enabled),
      prompt:
        String(record.prompt ?? '').trim() ||
        'Follow us first, then comment again and we will send the details in DM.',
      visitProfileButtonLabel:
        String(record.visitProfileButtonLabel ?? '').trim() || 'Visit Profile',
      confirmButtonLabel:
        String(record.confirmButtonLabel ?? '').trim() || "I'm following",
    };
  }

  private normaliseDmFlow(input: unknown): PrivateReplyDmFlow {
    const record = this.asRecord(input);
    const buttons = Array.isArray(record.buttons)
      ? record.buttons
          .map((value) => {
            const button = this.asRecord(value);
            const type: PrivateReplyButtonType =
              button.type === 'postback' ? 'postback' : 'url';
            return {
              type,
              label: String(button.label ?? '').trim(),
              url: String(button.url ?? '').trim(),
              payload: String(button.payload ?? '').trim(),
            };
          })
          .filter(
            (button) =>
              button.label && (button.type === 'postback' || button.url),
          )
          .slice(0, 3)
      : [];

    return {
      introMessage:
        String(record.introMessage ?? '').trim() ||
        "Hi {{commenter.username}}. Tap below and I'll send you access shortly.",
      startButtonLabel:
        String(record.startButtonLabel ?? '').trim() || 'Send me access',
      buttons,
      linkFollowUp: this.normaliseLinkFollowUp(record.linkFollowUp),
    };
  }

  private normaliseLinkFollowUp(input: unknown): PrivateReplyLinkFollowUp {
    const record = this.asRecord(input);
    const delayMinutes = Number(record.delayMinutes ?? 30);
    return {
      enabled: Boolean(record.enabled),
      delayMinutes:
        Number.isFinite(delayMinutes) && delayMinutes > 0
          ? Math.min(Math.floor(delayMinutes), 1440)
          : 30,
      message:
        String(record.message ?? '').trim() ||
        'Just checking in. The link is still ready when you want to open it.',
    };
  }

  private renderCommentTemplate(template: string, payload: CommentEventPayload) {
    return renderVariableTemplate(template, {
      comment: { text: payload.commentText ?? '' },
      post: { id: payload.postId ?? '' },
      commenter: {
        name: payload.commenterName ?? payload.commenterUsername ?? '',
        username: payload.commenterUsername ?? payload.commenterName ?? '',
      },
    }) ?? '';
  }

  private buildInstagramButtonMessage(
    text: string,
    buttons: PrivateReplyButton[],
  ): Record<string, unknown> {
    const cleanButtons = buttons
      .map((button) => ({
        ...button,
        label: button.label.trim().slice(0, 20),
        url: button.url?.trim(),
        payload: button.payload?.trim(),
      }))
      .filter(
        (button) =>
          button.label && (button.type === 'postback' || Boolean(button.url)),
      )
      .slice(0, 3);

    if (cleanButtons.length === 0) {
      return { text };
    }

    return {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text,
          buttons: cleanButtons.map((button) =>
            button.type === 'postback'
              ? {
                  type: 'postback',
                  title: button.label,
                  payload: button.payload || button.label,
                }
              : {
                  type: 'web_url',
                  title: button.label,
                  url: button.url,
                },
          ),
        },
      },
    };
  }

  private getFinalMessageButtons(
    dmFlow: PrivateReplyDmFlow,
    followGate: PrivateReplyFollowGate,
  ) {
    const reservedLabels = new Set(
      [
        followGate.confirmButtonLabel,
        followGate.visitProfileButtonLabel,
        "I'm following",
        'Visit Profile',
      ]
        .map((label) => label.trim().toLocaleLowerCase())
        .filter(Boolean),
    );

    return dmFlow.buttons.filter((button) => {
      const label = button.label.trim().toLocaleLowerCase();
      const payload = button.payload?.trim() ?? '';
      if (reservedLabels.has(label)) {
        return false;
      }

      return (
        !payload.startsWith(COMMENT_DM_START_PAYLOAD_PREFIX) &&
        !payload.startsWith(COMMENT_DM_FOLLOW_CHECK_PAYLOAD_PREFIX)
      );
    });
  }

  private async buildTrackedInstagramButtonMessage({
    channel,
    recipientId,
    text,
    buttons,
    linkFollowUp,
    context,
  }: {
    channel: any;
    recipientId: string;
    text: string;
    buttons: PrivateReplyButton[];
    linkFollowUp: PrivateReplyLinkFollowUp;
    context: {
      workspaceId: string;
      channelId: string;
      conversationId?: string | null;
      ruleKey: string;
      commentId?: string | null;
    };
  }) {
    const hasTrackableLinks =
      linkFollowUp.enabled &&
      buttons.some((button) => button.type === 'url' && button.url?.trim());

    if (!hasTrackableLinks) {
      return this.buildInstagramButtonMessage(text, buttons);
    }

    const groupId = randomUUID();
    const dueAt = Date.now() + linkFollowUp.delayMinutes * 60 * 1000;
    await this.cancelActiveTrackedLinkFollowUps({
      workspaceId: context.workspaceId,
      channelId: context.channelId,
      recipientId,
      ruleKey: context.ruleKey,
      reason: 'replaced_by_new_link_message',
    });

    const trackedButtons = await Promise.all(
      buttons.map(async (button) => {
        if (button.type !== 'url' || !button.url?.trim()) {
          return button;
        }

        const token = randomUUID();
        await this.redis.client.set(
          this.linkFollowUpTokenKey(token),
          JSON.stringify({
            groupId,
            url: button.url.trim(),
          }),
          'EX',
          LINK_FOLLOW_UP_TTL_SECONDS,
        );

        return {
          ...button,
          url: this.buildTrackedLinkUrl(channel.id, token),
        };
      }),
    );

    await this.redis.client.set(
      this.linkFollowUpGroupKey(groupId),
      JSON.stringify({
        id: groupId,
        workspaceId: context.workspaceId,
        channelId: context.channelId,
        conversationId: context.conversationId ?? null,
        recipientId,
        ruleKey: context.ruleKey,
        commentId: context.commentId ?? null,
        lifecycleId: context.commentId
          ? `comment:${context.channelId}:${context.commentId}`
          : null,
        signature: this.linkFollowUpSignature({
          workspaceId: context.workspaceId,
          channelId: context.channelId,
          recipientId,
          ruleKey: context.ruleKey,
        }),
        followUpMessage: linkFollowUp.message,
        dueAt,
        createdAt: new Date().toISOString(),
        clickedAt: null,
        sentAt: null,
      }),
      'EX',
      LINK_FOLLOW_UP_TTL_SECONDS,
    );
    await this.redis.client.zadd(LINK_FOLLOW_UP_DUE_SET, dueAt, groupId);
    await this.redis.client.set(
      this.linkFollowUpActiveKey({
        workspaceId: context.workspaceId,
        channelId: context.channelId,
        recipientId,
        ruleKey: context.ruleKey,
      }),
      groupId,
      'EX',
      LINK_FOLLOW_UP_TTL_SECONDS,
    );
    await this.redis.client.sadd(
      this.linkFollowUpIndexKey({
        workspaceId: context.workspaceId,
        channelId: context.channelId,
        recipientId,
        ruleKey: context.ruleKey,
      }),
      groupId,
    );
    await this.redis.client.expire(
      this.linkFollowUpIndexKey({
        workspaceId: context.workspaceId,
        channelId: context.channelId,
        recipientId,
        ruleKey: context.ruleKey,
      }),
      LINK_FOLLOW_UP_TTL_SECONDS,
    );

    return this.buildInstagramButtonMessage(text, trackedButtons);
  }

  private buildCommentDmPayload(
    prefix: string,
    ruleKey: string,
    commentId?: string | null,
  ) {
    const payload: CommentDmPayloadContext = {
      ruleKey: ruleKey || 'all',
      commentId: commentId ?? null,
    };
    return `${prefix}:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  }

  private parseCommentDmPayload(payload: string): CommentDmPayloadContext {
    const encoded = payload.split(':')[1];
    if (!encoded) {
      return { ruleKey: 'all', commentId: null };
    }

    try {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      const parsed = this.safeParseJson(decoded);
      if (Object.keys(parsed).length > 0) {
        return {
          ruleKey: String(parsed.ruleKey ?? 'all').trim() || 'all',
          commentId: this.toOptionalString(parsed.commentId),
        };
      }

      return { ruleKey: decoded || 'all', commentId: null };
    } catch {
      return { ruleKey: 'all', commentId: null };
    }
  }

  private parseCommentDmRuleKey(payload: string) {
    return this.parseCommentDmPayload(payload).ruleKey;
  }

  private commentMatchesKeywordFilter(
    commentText: string | null | undefined,
    filter: PrivateReplyKeywordFilter,
  ) {
    if (!filter.enabled || filter.keywords.length === 0) {
      return true;
    }

    const text = String(commentText ?? '').toLocaleLowerCase();
    const matches = filter.keywords.map((keyword) =>
      text.includes(keyword.toLocaleLowerCase()),
    );

    if (filter.mode === 'all') {
      return matches.every(Boolean);
    }

    if (filter.mode === 'exclude') {
      return matches.every((matched) => !matched);
    }

    return matches.some(Boolean);
  }

  private normaliseTargetSnapshot(input: unknown): MetaAutomationTarget | null {
    if (!input || typeof input !== 'object') {
      return null;
    }

    const record = input as Record<string, unknown>;
    const id = String(record.id ?? record.postId ?? '').trim();
    if (!id) {
      return null;
    }

    return {
      id,
      title: String(record.title ?? 'Post').trim() || 'Post',
      subtitle:
        record.subtitle === null || record.subtitle === undefined
          ? null
          : String(record.subtitle),
      type: String(record.type ?? 'post').trim() || 'post',
      permalink:
        record.permalink === null || record.permalink === undefined
          ? null
          : String(record.permalink),
      thumbnailUrl:
        record.thumbnailUrl === null || record.thumbnailUrl === undefined
          ? null
          : String(record.thumbnailUrl),
      createdAt:
        record.createdAt === null || record.createdAt === undefined
          ? null
          : String(record.createdAt),
    };
  }

  private async safeListTargets(channelId: string, workspaceId: string) {
    try {
      return await this.listTargets(channelId, workspaceId);
    } catch (error: any) {
      this.logger.warn(
        `Engagement activity target refresh skipped channel=${channelId}: ${this.getErrorMessage(error)}`,
      );
      return [];
    }
  }

  private async loadEngagementActivityEvents(channelId: string) {
    const entries = await this.redis.client.lrange(
      this.getEngagementActivityKey(channelId),
      0,
      ENGAGEMENT_ACTIVITY_LIMIT - 1,
    );

    return entries
      .map((entry) => this.parseEngagementActivityEvent(entry))
      .filter((event): event is MetaEngagementActivityEvent => Boolean(event))
      .reverse();
  }

  private async backfillPrivateReplyCountersFromEvents(
    channel: any,
    config: PrivateRepliesConfig,
    events: MetaEngagementActivityEvent[],
  ) {
    if (
      config.postMessages.length === 0 ||
      config.postMessages.some(
        (item) =>
          (item.commentsReceived ?? 0) > 0 ||
          (item.automatedRepliesSent ?? 0) > 0,
      )
    ) {
      return config;
    }

    const postMessages = config.postMessages.map((item) => {
      const lifecycles = new Map<
        string,
        { commentReceived: boolean; replySent: boolean }
      >();

      for (const event of events) {
        if (!event.postId || !this.postIdsMatch(item.postId, event.postId)) {
          continue;
        }

        const lifecycleKey =
          event.lifecycleId ??
          event.commentId ??
          [event.postId, event.commenterName, event.commentText]
            .filter(Boolean)
            .join(':');
        if (!lifecycleKey) {
          continue;
        }

        const lifecycle =
          lifecycles.get(lifecycleKey) ?? {
            commentReceived: false,
            replySent: false,
          };
        lifecycle.commentReceived =
          lifecycle.commentReceived ||
          event.type === 'comment_received' ||
          Boolean(event.commentId);
        lifecycle.replySent =
          lifecycle.replySent ||
          event.type === 'private_reply_sent' ||
          event.replyStatus === 'sent';
        lifecycles.set(lifecycleKey, lifecycle);
      }

      return {
        ...item,
        commentsReceived: [...lifecycles.values()].filter(
          (lifecycle) => lifecycle.commentReceived,
        ).length,
        automatedRepliesSent: [...lifecycles.values()].filter(
          (lifecycle) => lifecycle.replySent,
        ).length,
      };
    });

    const hasBackfilledCounters = postMessages.some(
      (item) =>
        (item.commentsReceived ?? 0) > 0 ||
        (item.automatedRepliesSent ?? 0) > 0,
    );
    if (!hasBackfilledCounters) {
      return config;
    }

    const automation = this.getAutomationConfig(channel);
    const next: PrivateRepliesConfig = {
      ...config,
      selectedPostIds: postMessages.map((item) => item.postId),
      postMessages,
    };
    automation.privateReplies = next;
    await this.updateAutomationConfig(channel.id, channel.config, automation);
    return next;
  }

  private buildEngagementSummary(
    events: MetaEngagementActivityEvent[],
    config: PrivateRepliesConfig,
    targets: MetaAutomationTarget[],
  ): MetaEngagementActivitySummary {
    return {
      commentsReceived: config.postMessages.reduce(
        (total, item) => total + (item.commentsReceived ?? 0),
        0,
      ),
      automatedRepliesSent: config.postMessages.reduce(
        (total, item) => total + (item.automatedRepliesSent ?? 0),
        0,
      ),
      activePostAutomations: this.countActivePostAutomations(config, targets),
      engagementEventsToday: events.filter((event) =>
        this.isToday(event.timestamp),
      ).length,
    };
  }

  private countActivePostAutomations(
    config: PrivateRepliesConfig,
    targets: MetaAutomationTarget[],
  ) {
    if (!config.enabled) {
      return 0;
    }

    if (config.scope === 'selected') {
      return config.postMessages.filter((item) => item.message.trim()).length;
    }

    return Math.max(targets.length, 1);
  }

  private buildEngagementPosts(
    channel: any,
    config: PrivateRepliesConfig,
    targets: MetaAutomationTarget[],
  ): MetaEngagementActivityPost[] {
    const pageName = this.getMetaPageName(channel);
    const pagePictureUrl = this.getMetaPagePictureUrl(channel);

    if (config.scope === 'selected') {
      return config.postMessages
        .filter((item) => item.message.trim())
        .map((item) => {
          const target =
            targets.find((candidate) =>
              this.postIdsMatch(candidate.id, item.postId),
            ) ??
            item.target ??
            null;

          return this.buildEngagementPost(channel, {
            pageName,
            pagePictureUrl,
            postId: target?.id ?? item.postId,
            target,
            commentsReceived: item.commentsReceived ?? 0,
            automatedRepliesSent: item.automatedRepliesSent ?? 0,
          });
        });
    }

    if (!config.enabled || !config.message.trim()) {
      return [];
    }

    return targets.map((target) =>
      this.buildEngagementPost(channel, {
        pageName,
        pagePictureUrl,
        postId: target.id,
        target,
        commentsReceived: 0,
        automatedRepliesSent: 0,
      }),
    );
  }

  private buildEngagementPost(
    channel: any,
    input: {
      pageName: string;
      pagePictureUrl?: string | null;
      postId: string | null;
      target?: MetaAutomationTarget | null;
      commentsReceived: number;
      automatedRepliesSent: number;
    },
  ): MetaEngagementActivityPost {
    return {
      id: input.postId,
      pageName: input.pageName,
      pagePictureUrl: input.pagePictureUrl,
      postThumbnailUrl: input.target?.thumbnailUrl ?? null,
      postSnippet:
        this.toSnippet(input.target?.subtitle ?? input.target?.title) ??
        (input.postId ? 'Selected Page post is being monitored.' : null),
      createdAt: input.target?.createdAt ?? null,
      permalink: input.target?.permalink ?? null,
      commentsReceived: input.commentsReceived,
      automatedRepliesSent: input.automatedRepliesSent,
      identity: this.buildPostIdentity(channel, input.postId),
    };
  }

  private async recordCommentEngagementActivity(
    channel: any,
    payload: CommentEventPayload,
    config: PrivateRepliesConfig,
    selectedRule: PrivateReplyPostMessage | null,
    type: EngagementActivityType,
    status: EngagementActivityStatus,
  ) {
    const target =
      selectedRule?.target ??
      this.findMatchingPrivateReplyPostMessage(config, payload.postId)?.target ??
      null;

    const now = new Date().toISOString();
    const lifecycleId = `comment:${channel.id}:${payload.commentId}`;

    const result = await this.upsertCommentEngagementActivity({
      id: lifecycleId,
      lifecycleId,
      commentId: payload.commentId,
      type: 'comment_received',
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      channelType: channel.type as SupportedAutomationChannel,
      pageName: this.getMetaPageName(channel),
      pagePictureUrl: this.getMetaPagePictureUrl(channel),
      postId: payload.postId ?? target?.id ?? null,
      postSnippet:
        this.extractPostSnippetFromRaw(payload.raw) ??
        this.toSnippet(target?.subtitle ?? target?.title),
      postThumbnailUrl: target?.thumbnailUrl ?? null,
      postPermalink: target?.permalink ?? null,
      postCreatedAt: target?.createdAt ?? null,
      commenterName: payload.commenterName ?? 'Facebook user',
      commentText: this.toSnippet(payload.commentText, 220),
      status,
      timestamp: now,
      commentReceivedAt: type === 'comment_received' ? now : null,
      replyStatus:
        type === 'private_reply_sent'
          ? 'sent'
          : type === 'automation_triggered'
            ? 'pending'
            : null,
      replySentAt: type === 'private_reply_sent' ? now : null,
      conversationId: null,
    });

    if (result?.commentCounted || result?.replyCounted) {
      await this.incrementPrivateReplyPostCounters(channel, {
        postId: selectedRule?.postId ?? payload.postId ?? target?.id ?? null,
        commentsReceived: result.commentCounted ? 1 : 0,
        automatedRepliesSent: result.replyCounted ? 1 : 0,
      });
    }
  }

  private async recordPublicCommentReplyEngagementActivity(
    channel: any,
    payload: CommentEventPayload,
    config: PrivateRepliesConfig,
    selectedRule: PrivateReplyPostMessage | null,
    text: string,
  ) {
    const target =
      selectedRule?.target ??
      this.findMatchingPrivateReplyPostMessage(config, payload.postId)?.target ??
      null;
    const now = new Date().toISOString();
    const lifecycleId = `comment:${channel.id}:${payload.commentId}`;

    await this.upsertCommentEngagementActivity({
      id: lifecycleId,
      lifecycleId,
      commentId: payload.commentId,
      type: 'public_comment_reply_sent',
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      channelType: channel.type as SupportedAutomationChannel,
      pageName: this.getMetaPageName(channel),
      pagePictureUrl: this.getMetaPagePictureUrl(channel),
      postId: payload.postId ?? target?.id ?? null,
      postSnippet:
        this.extractPostSnippetFromRaw(payload.raw) ??
        this.toSnippet(target?.subtitle ?? target?.title),
      postThumbnailUrl: target?.thumbnailUrl ?? null,
      postPermalink: target?.permalink ?? null,
      postCreatedAt: target?.createdAt ?? null,
      commenterName: payload.commenterName ?? payload.commenterUsername ?? null,
      commentText: this.toSnippet(payload.commentText, 220),
      activityText: this.toSnippet(text, 220),
      publicReplyText: this.toSnippet(text, 220),
      publicReplySentAt: now,
      status: 'sent',
      timestamp: now,
      commentReceivedAt: null,
      replyStatus: null,
      replySentAt: null,
      conversationId: null,
    });
  }

  private async recordCommentDmFlowEngagementActivity({
    message,
    type,
    status,
    activityLabel,
    activityText,
    ruleKey,
    sourceCommentId,
    selectedRule,
  }: {
    message: any;
    type: Extract<
      EngagementActivityType,
      'follow_gate_sent' | 'final_message_sent'
    >;
    status: EngagementActivityStatus;
    activityLabel: string;
    activityText: string;
    ruleKey: string;
    sourceCommentId?: string | null;
    selectedRule?: PrivateReplyPostMessage | null;
  }) {
    const target = selectedRule?.target ?? null;
    const commenterName =
      [
        message.conversation?.contact?.firstName,
        message.conversation?.contact?.lastName,
      ]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      message.conversation?.contact?.email ||
      message.conversation?.contact?.phone ||
      'Customer';

    await this.persistEngagementActivity(
      {
        id: randomUUID(),
        lifecycleId: sourceCommentId
          ? `comment:${message.channelId}:${sourceCommentId}`
          : null,
        commentId: sourceCommentId ?? null,
        type,
        workspaceId: message.workspaceId,
        channelId: message.channelId,
        channelType: message.channel.type as SupportedAutomationChannel,
        pageName: this.getMetaPageName(message.channel),
        pagePictureUrl: this.getMetaPagePictureUrl(message.channel),
        postId: target?.id ?? (ruleKey !== 'all' ? ruleKey : null),
        postSnippet: this.toSnippet(target?.subtitle ?? target?.title),
        postThumbnailUrl: target?.thumbnailUrl ?? null,
        postPermalink: target?.permalink ?? null,
        postCreatedAt: target?.createdAt ?? null,
        commenterName,
        commentText: null,
        activityText: this.toSnippet(activityText, 220),
        activityLabel,
        status,
        timestamp: new Date().toISOString(),
        conversationId: message.conversationId,
      },
      `meta:engagement:comment-dm-flow:${message.channelId}:${message.id}:${type}`,
    );
  }

  private async recordConversationCreatedEngagementActivity(message: any) {
    if (!message.conversationId || !message.channel?.id) {
      return;
    }

    const metadata = this.asRecord(message.metadata);
    const storyReply = this.asRecord(metadata.storyReply);
    const postback = this.asRecord(metadata.postback);
    const quickReply = this.asRecord(metadata.quickReply);
    const interactive = this.asRecord(metadata.interactive);
    const commentDmPayload = this.toOptionalString(
      postback.payload ?? quickReply.payload ?? interactive.payload,
    );
    const commenterName =
      [
        message.conversation?.contact?.firstName,
        message.conversation?.contact?.lastName,
      ]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      message.conversation?.contact?.email ||
      message.conversation?.contact?.phone ||
      'Customer';
    const postId =
      this.toOptionalString(metadata.postId) ??
      this.toOptionalString(metadata.mediaId) ??
      this.toOptionalString(storyReply.storyId);

    if (
      commentDmPayload?.startsWith(COMMENT_DM_START_PAYLOAD_PREFIX) ||
      commentDmPayload?.startsWith(COMMENT_DM_FOLLOW_CHECK_PAYLOAD_PREFIX)
    ) {
      const payloadContext = this.parseCommentDmPayload(commentDmPayload);
      const sourceCommentId = payloadContext.commentId ?? null;
      const isFollowCheck = commentDmPayload.startsWith(
        COMMENT_DM_FOLLOW_CHECK_PAYLOAD_PREFIX,
      );
      const ruleKey = payloadContext.ruleKey;
      const buttonLabel =
        this.toOptionalString(postback.title) ??
        this.toOptionalString(quickReply.title) ??
        this.toOptionalString(message.text) ??
        (isFollowCheck ? "I'm following" : 'Send me access');

      await this.persistEngagementActivity(
        {
          id: randomUUID(),
          lifecycleId: sourceCommentId
            ? `comment:${message.channelId}:${sourceCommentId}`
            : null,
          commentId: sourceCommentId,
          type: 'dm_button_clicked',
          workspaceId: message.workspaceId,
          channelId: message.channelId,
          channelType: message.channel.type as SupportedAutomationChannel,
          pageName: this.getMetaPageName(message.channel),
          pagePictureUrl: this.getMetaPagePictureUrl(message.channel),
          postId: ruleKey && ruleKey !== 'all' ? ruleKey : postId,
          postSnippet:
            this.toSnippet(metadata.postSnippet) ??
            this.toSnippet(storyReply.storyUrl) ??
            null,
          postThumbnailUrl: this.toOptionalString(metadata.thumbnailUrl),
          postPermalink: this.toOptionalString(metadata.postPermalink),
          postCreatedAt: null,
          commenterName,
          commentText: null,
          activityText: buttonLabel,
          activityLabel: isFollowCheck
            ? 'Follow check clicked'
            : 'Access button clicked',
          status: 'triggered',
          timestamp: this.toIsoTimestamp(message.createdAt),
          conversationId: message.conversationId,
        },
        `meta:engagement:comment-dm-button:${message.channelId}:${message.id ?? commentDmPayload}`,
      );
      return;
    }

    await this.persistEngagementActivity(
      {
        id: randomUUID(),
        type: 'conversation_created',
        workspaceId: message.workspaceId,
        channelId: message.channelId,
        channelType: message.channel.type as SupportedAutomationChannel,
        pageName: this.getMetaPageName(message.channel),
        pagePictureUrl: this.getMetaPagePictureUrl(message.channel),
        postId,
        postSnippet:
          this.toSnippet(metadata.postSnippet) ??
          this.toSnippet(storyReply.storyUrl) ??
          null,
        postThumbnailUrl: this.toOptionalString(metadata.thumbnailUrl),
        postPermalink: this.toOptionalString(metadata.postPermalink),
        postCreatedAt: null,
        commenterName,
        commentText: this.toSnippet(message.text, 220),
        status: 'created',
        timestamp: this.toIsoTimestamp(message.createdAt),
        conversationId: message.conversationId,
      },
      `meta:engagement:conversation:${message.channelId}:${message.conversationId}`,
    );
  }

  private async incrementPrivateReplyPostCounters(
    channel: any,
    delta: {
      postId: string | null;
      commentsReceived: number;
      automatedRepliesSent: number;
    },
  ) {
    if (
      !delta.postId ||
      (delta.commentsReceived <= 0 && delta.automatedRepliesSent <= 0)
    ) {
      return;
    }

    const freshChannel = await this.findChannel(channel.id, channel.workspaceId);
    const automation = this.getAutomationConfig(freshChannel);
    const config = this.normalisePrivateReplies(automation.privateReplies);
    let matched = false;

    const postMessages = config.postMessages.map((item) => {
      if (!this.postIdsMatch(item.postId, delta.postId!)) {
        return item;
      }

      matched = true;
      return {
        ...item,
        commentsReceived:
          (item.commentsReceived ?? 0) + delta.commentsReceived,
        automatedRepliesSent:
          (item.automatedRepliesSent ?? 0) + delta.automatedRepliesSent,
      };
    });

    if (!matched) {
      return;
    }

    automation.privateReplies = {
      ...config,
      selectedPostIds: postMessages.map((item) => item.postId),
      postMessages,
    };

    await this.updateAutomationConfig(
      freshChannel.id,
      freshChannel.config,
      automation,
    );
  }

  private async persistEngagementActivity(
    event: MetaEngagementActivityEvent,
    dedupeKey?: string,
  ) {
    try {
      if (dedupeKey) {
        const accepted = await this.redis.client.set(
          dedupeKey,
          '1',
          'EX',
          ENGAGEMENT_ACTIVITY_TTL_SECONDS,
          'NX',
        );
        if (!accepted) {
          return;
        }
      }

      const key = this.getEngagementActivityKey(event.channelId);
      await this.redis.client.lpush(key, JSON.stringify(event));
      await this.redis.client.ltrim(key, 0, ENGAGEMENT_ACTIVITY_LIMIT - 1);
      await this.redis.client.expire(key, ENGAGEMENT_ACTIVITY_TTL_SECONDS);

      this.events.emit('meta.engagement.activity', event);
    } catch (error: any) {
      this.logger.warn(
        `Failed to record engagement activity channel=${event.channelId}: ${this.getErrorMessage(error)}`,
      );
    }
  }

  private async upsertCommentEngagementActivity(
    event: MetaEngagementActivityEvent,
  ): Promise<
    | {
        event: MetaEngagementActivityEvent;
        commentCounted: boolean;
        replyCounted: boolean;
      }
    | null
  > {
    try {
      const key = this.getEngagementActivityKey(event.channelId);
      const entries = await this.redis.client.lrange(
        key,
        0,
        ENGAGEMENT_ACTIVITY_LIMIT - 1,
      );
      const existingIndex = entries.findIndex((entry) => {
        const parsed = this.parseEngagementActivityEvent(entry);
        return Boolean(
          parsed &&
            ((event.lifecycleId && parsed.lifecycleId === event.lifecycleId) ||
              (event.commentId && parsed.commentId === event.commentId)),
        );
      });
      const existing =
        existingIndex >= 0
          ? this.parseEngagementActivityEvent(entries[existingIndex])
          : null;
      const commentCounted = Boolean(
        event.commentReceivedAt && !existing?.commentReceivedAt,
      );
      const replyCounted = Boolean(
        event.replyStatus === 'sent' && existing?.replyStatus !== 'sent',
      );
      const replyStatus =
        existing?.replyStatus === 'sent'
          ? 'sent'
          : event.replyStatus ?? existing?.replyStatus ?? null;
      const next: MetaEngagementActivityEvent = {
        ...(existing ?? event),
        ...event,
        type: 'comment_received',
        timestamp: event.timestamp,
        commentReceivedAt:
          existing?.commentReceivedAt ?? event.commentReceivedAt ?? event.timestamp,
        replyStatus,
        replySentAt: event.replySentAt ?? existing?.replySentAt ?? null,
        activityText: event.activityText ?? existing?.activityText ?? null,
        activityLabel: event.activityLabel ?? existing?.activityLabel ?? null,
        publicReplyText:
          event.publicReplyText ?? existing?.publicReplyText ?? null,
        publicReplySentAt:
          event.publicReplySentAt ?? existing?.publicReplySentAt ?? null,
        postSnippet: event.postSnippet ?? existing?.postSnippet ?? null,
        postThumbnailUrl: event.postThumbnailUrl ?? existing?.postThumbnailUrl ?? null,
        postPermalink: event.postPermalink ?? existing?.postPermalink ?? null,
        postCreatedAt: event.postCreatedAt ?? existing?.postCreatedAt ?? null,
      };

      if (existingIndex >= 0) {
        await this.redis.client.lrem(key, 1, entries[existingIndex]);
      }

      await this.redis.client.lpush(key, JSON.stringify(next));
      await this.redis.client.ltrim(key, 0, ENGAGEMENT_ACTIVITY_LIMIT - 1);
      await this.redis.client.expire(key, ENGAGEMENT_ACTIVITY_TTL_SECONDS);

      this.events.emit('meta.engagement.activity', next);
      return {
        event: next,
        commentCounted,
        replyCounted,
      };
    } catch (error: any) {
      this.logger.warn(
        `Failed to upsert engagement activity channel=${event.channelId}: ${this.getErrorMessage(error)}`,
      );
      return null;
    }
  }

  private getEngagementActivityKey(channelId: string) {
    return `meta:engagement:activity:${channelId}`;
  }

  private getEngagementDedupeKey(
    channelId: string,
    type: EngagementActivityType,
    externalId: string,
  ) {
    return `meta:engagement:dedupe:${channelId}:${type}:${externalId}`;
  }

  private parseEngagementActivityEvent(
    value: string,
  ): MetaEngagementActivityEvent | null {
    try {
      const parsed = JSON.parse(value) as Partial<MetaEngagementActivityEvent>;
      if (
        !parsed.id ||
        !parsed.type ||
        !parsed.workspaceId ||
        !parsed.channelId ||
        !parsed.channelType ||
        !parsed.timestamp
      ) {
        return null;
      }

      return {
        id: parsed.id,
        lifecycleId: parsed.lifecycleId ?? null,
        commentId: parsed.commentId ?? null,
        type: parsed.type,
        workspaceId: parsed.workspaceId,
        channelId: parsed.channelId,
        channelType: parsed.channelType,
        pageName: parsed.pageName ?? 'Connected Page',
        pagePictureUrl: parsed.pagePictureUrl ?? null,
        postId: parsed.postId ?? null,
        postSnippet: parsed.postSnippet ?? null,
        postThumbnailUrl: parsed.postThumbnailUrl ?? null,
        postPermalink: parsed.postPermalink ?? null,
        postCreatedAt: parsed.postCreatedAt ?? null,
        commenterName: parsed.commenterName ?? null,
        commentText: parsed.commentText ?? null,
        activityText: parsed.activityText ?? null,
        activityLabel: parsed.activityLabel ?? null,
        publicReplyText: parsed.publicReplyText ?? null,
        publicReplySentAt: parsed.publicReplySentAt ?? null,
        status: parsed.status ?? 'received',
        timestamp: parsed.timestamp,
        commentReceivedAt: parsed.commentReceivedAt ?? null,
        replyStatus: parsed.replyStatus ?? null,
        replySentAt: parsed.replySentAt ?? null,
        conversationId: parsed.conversationId ?? null,
      };
    } catch {
      return null;
    }
  }

  private getMetaPageName(channel: any) {
    const config = this.asRecord(channel.config);
    return (
      this.toOptionalString(config.pageName) ??
      this.toOptionalString(config.userName) ??
      this.toOptionalString(channel.name) ??
      'Connected Page'
    );
  }

  private getMetaPagePictureUrl(channel: any) {
    const config = this.asRecord(channel.config);
    return (
      this.toOptionalString(config.pagePicture) ??
      this.toOptionalString(config.profilePicture) ??
      this.toOptionalString(config.pictureUrl)
    );
  }

  private buildPostIdentity(channel: any, postId?: string | null) {
    if (channel.type === 'instagram') {
      return `Instagram account ${channel.identifier} - Media ${postId ?? 'not selected'}`;
    }

    return `Facebook Page ${channel.identifier} - Post ${postId ?? 'not selected'}`;
  }

  private extractPostSnippetFromRaw(raw: unknown) {
    const record = this.asRecord(raw);
    const value = this.asRecord(record.value);
    const post = this.asRecord(value.post);
    const media = this.asRecord(value.media);

    return (
      this.toSnippet(post.message) ??
      this.toSnippet(post.story) ??
      this.toSnippet(media.caption) ??
      this.toSnippet(value.post_message) ??
      this.toSnippet(value.caption)
    );
  }

  private isToday(timestamp: string) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return false;
    }

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return date >= start && date < end;
  }

  private toSnippet(value: unknown, maxLength = 160) {
    const text = this.toOptionalString(value);
    if (!text) {
      return null;
    }

    return text.length > maxLength
      ? `${text.slice(0, Math.max(0, maxLength - 3))}...`
      : text;
  }

  private toOptionalString(value: unknown) {
    if (value === null || value === undefined) {
      return null;
    }

    const text = String(value).trim();
    return text ? text : null;
  }

  private toIsoTimestamp(value: unknown) {
    if (value instanceof Date) {
      return value.toISOString();
    }

    const date = new Date(String(value ?? ''));
    return Number.isNaN(date.getTime())
      ? new Date().toISOString()
      : date.toISOString();
  }

  private toNonNegativeInteger(value: unknown) {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return 0;
    }

    return Math.floor(numeric);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  }

  private findMatchingPrivateReplyPostMessage(
    config: PrivateRepliesConfig,
    postId?: string | null,
  ): PrivateReplyPostMessage | null {
    if (!postId) {
      return null;
    }

    return (
      config.postMessages.find((item) => this.postIdsMatch(item.postId, postId)) ??
      null
    );
  }

  private postIdsMatch(configuredPostId: string, eventPostId: string) {
    if (configuredPostId === eventPostId) {
      return true;
    }

    const configuredSuffix = configuredPostId.split('_').pop();
    const eventSuffix = eventPostId.split('_').pop();
    return Boolean(
      configuredSuffix &&
        eventSuffix &&
        configuredSuffix === eventSuffix,
    );
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

  private getProviderErrorDebug(error: any) {
    const metaError = error?.response?.data?.error;
    return this.safeJson({
      status: error?.response?.status ?? null,
      code: metaError?.code ?? null,
      subcode: metaError?.error_subcode ?? null,
      type: metaError?.type ?? null,
      message: metaError?.message ?? error?.message ?? null,
      fbtraceId: metaError?.fbtrace_id ?? null,
    });
  }

  private safeJson(value: any) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
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
