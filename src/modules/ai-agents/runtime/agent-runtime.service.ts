import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { aiAgentsDebug } from '../ai-agents-debug.logger';
import { AgentGuardrailsService } from '../guardrails/agent-guardrails.service';
import { AiGatewayService } from '../gateway/ai-gateway.service';
import { HumanHandoffService } from '../handoff/human-handoff.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { AiToolRegistryService } from '../tools/ai-tool-registry.service';
import { AiAgentOutboundService } from './ai-agent-outbound.service';
import {
  AgentDecision,
  AgentRunMode,
  AgentRunResult,
  AgentVersionConfig,
  KnowledgeHit,
} from './agent-runtime.types';

@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly knowledge: KnowledgeService,
    private readonly tools: AiToolRegistryService,
    private readonly guardrails: AgentGuardrailsService,
    private readonly handoff: HumanHandoffService,
    private readonly outbound: AiAgentOutboundService,
  ) {}

  async runForConversation(input: {
    workspaceId: string;
    conversationId: string;
    messageId?: string;
    agentId?: string;
    mode?: AgentRunMode;
    sandboxMessage?: string;
    idempotencyKey?: string;
  }): Promise<AgentRunResult> {
    const mode = input.mode || 'auto';
    aiAgentsDebug.step(undefined, 'runForConversation:start', {
      input,
      mode,
    });
    const conversation = await this.loadConversation(input.workspaceId, input.conversationId);
    aiAgentsDebug.step(undefined, 'conversation:loaded', {
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      messageCount: conversation.messages.length,
      lastMessageId: conversation.lastMessageId,
      lastMessageDirection: conversation.lastMessage?.direction,
      contact: this.contactSnapshot(conversation.contact),
    });
    if (mode === 'auto' && (await this.isConversationAiPaused(input.workspaceId, conversation.id))) {
      aiAgentsDebug.warn('runtime', 'run skipped because conversation AI is paused', {
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        messageId: input.messageId,
      });
      return {
        runId: '',
        status: 'completed',
        reply: null,
        decision: null,
        actions: [],
      };
    }
    const latestCustomerText = input.sandboxMessage || this.latestCustomerText(conversation.messages);
    const channelType = conversation.lastMessage?.channelType || conversation.messages[0]?.channelType || null;
    const channelId = conversation.lastMessage?.channelId || conversation.messages[0]?.channelId || null;
    aiAgentsDebug.step(undefined, 'message:resolved', {
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      messageId: input.messageId,
      channelId,
      channelType,
      latestCustomerText,
      sandbox: Boolean(input.sandboxMessage),
    });
    const version = await this.loadAgentVersion({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      channelType,
      mode,
    });
    aiAgentsDebug.step(undefined, 'agentVersion:loaded', {
      workspaceId: input.workspaceId,
      agentId: version.agentId,
      agentVersionId: version.id,
      agentName: version.name,
      approvalMode: version.approvalMode,
      toolsAllowed: version.toolsAllowed,
      knowledgeSourceIds: version.knowledgeSourceIds,
      llmConfig: version.llmConfig,
      runtimeConfig: version.runtimeConfig,
      guardrails: version.guardrails,
    });
    const run = await this.createRun({
      workspaceId: input.workspaceId,
      agentId: version.agentId,
      agentVersionId: version.id,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      triggerMessageId: input.messageId,
      channelType,
      idempotencyKey:
        input.idempotencyKey || `${input.workspaceId}:${conversation.id}:${input.messageId || mode}:${version.id}`,
      mode,
    });
    aiAgentsDebug.step(run.id, 'run:created', {
      workspaceId: input.workspaceId,
      agentId: version.agentId,
      agentVersionId: version.id,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      messageId: input.messageId,
      idempotencyKey: input.idempotencyKey || `${input.workspaceId}:${conversation.id}:${input.messageId || mode}:${version.id}`,
      mode,
    });

    try {
      await this.logAiMessage(input.workspaceId, run.id, conversation.id, 'customer', latestCustomerText || '', {
        messageId: input.messageId,
      });
      aiAgentsDebug.step(run.id, 'aiMessage:customer_logged', {
        conversationId: conversation.id,
        messageId: input.messageId,
      });

      const autoReplyCount = await this.getRecentAutoReplyCount(input.workspaceId, conversation.id);
      aiAgentsDebug.step(run.id, 'autoReplyCount:loaded', { autoReplyCount });
      const memories = await this.loadMemories(input.workspaceId, conversation.contactId, conversation.id);
      aiAgentsDebug.step(run.id, 'memory:loaded', {
        count: memories.length,
        memories,
      });
      const intent = await this.classifyIntent(run.id, version, conversation, latestCustomerText, memories);
      aiAgentsDebug.step(run.id, 'intent:classified', { intent });
      const knowledgeHits = await this.knowledge.retrieve({
        workspaceId: input.workspaceId,
        runId: run.id,
        query: latestCustomerText || intent.intent || '',
        sourceIds: version.knowledgeSourceIds,
        limit: 6,
      });
      aiAgentsDebug.step(run.id, 'knowledge:retrieved', {
        count: knowledgeHits.length,
        hits: knowledgeHits.map((hit) => ({
          id: hit.id,
          sourceId: hit.sourceId,
          title: hit.title,
          score: hit.score,
          content: hit.content,
          metadata: hit.metadata,
        })),
      });
      const decision = await this.decideActions(run.id, version, conversation, latestCustomerText, memories, knowledgeHits, intent);
      aiAgentsDebug.step(run.id, 'decision:created', { decision });
      const preHandoff = this.handoff.shouldHandoff({
        decision,
        customerText: latestCustomerText,
        contact: conversation.contact,
        autoReplyCount,
        maxAutoReplies: Number(version.runtimeConfig.maxAutoReplies || 5),
      });
      aiAgentsDebug.step(run.id, 'handoff:precheck', { preHandoff });

      if (preHandoff.handoffRequired || decision.responseStrategy === 'handoff') {
        aiAgentsDebug.warn('runtime', 'handoff triggered before action execution', {
          runId: run.id,
          reasons: preHandoff.reasons,
          responseStrategy: decision.responseStrategy,
        });
        const summary = await this.summarizeForHuman(run.id, version, conversation, latestCustomerText, decision, knowledgeHits);
        aiAgentsDebug.step(run.id, 'handoff:summary_created', { summary });
        const escalation = await this.handoff.escalate({
          workspaceId: input.workspaceId,
          runId: run.id,
          conversationId: conversation.id,
          contactId: conversation.contactId,
          reason: preHandoff.reasons[0] || 'ai_decision_handoff',
          summary,
        });
        await this.finishRun(run.id, 'escalated', decision, null, Date.now() - run.startedAt.getTime(), {
          escalationId: escalation.id,
          reasons: preHandoff.reasons,
        });
        aiAgentsDebug.step(run.id, 'run:escalated_pre_action', {
          escalationId: escalation.id,
          reasons: preHandoff.reasons,
        });
        return {
          runId: run.id,
          status: 'escalated',
          reply: null,
          decision,
          handoffReason: preHandoff.reasons.join(', '),
          actions: [],
        };
      }

      const actionResults = await this.executeActions(run.id, version, conversation, decision);
      aiAgentsDebug.step(run.id, 'actions:executed', { actionResults });
      const reply = await this.generateReply(run.id, version, conversation, latestCustomerText, memories, knowledgeHits, decision, actionResults);
      aiAgentsDebug.step(run.id, 'reply:generated', { reply });
      const guardrailResult = this.guardrails.validate({
        customerText: latestCustomerText,
        draftedReply: reply,
        confidence: decision.confidence,
        autoReplyCount,
        maxAutoReplies: Number(version.runtimeConfig.maxAutoReplies || 5),
        groundedKnowledgeCount: knowledgeHits.length,
        guardrails: version.guardrails,
        contact: conversation.contact,
      });
      aiAgentsDebug.step(run.id, 'guardrails:validated', { guardrailResult });

      if (!guardrailResult.allowed || guardrailResult.handoffRequired) {
        aiAgentsDebug.warn('runtime', 'handoff triggered by guardrails', {
          runId: run.id,
          guardrailResult,
        });
        const summary = await this.summarizeForHuman(run.id, version, conversation, latestCustomerText, decision, knowledgeHits);
        aiAgentsDebug.step(run.id, 'guardrail_handoff:summary_created', { summary });
        await this.handoff.escalate({
          workspaceId: input.workspaceId,
          runId: run.id,
          conversationId: conversation.id,
          contactId: conversation.contactId,
          reason: guardrailResult.reasons[0] || 'guardrail_handoff',
          summary,
        });
        await this.finishRun(run.id, 'escalated', decision, reply, Date.now() - run.startedAt.getTime(), {
          guardrailResult,
        });
        aiAgentsDebug.step(run.id, 'run:escalated_guardrail', { guardrailResult });
        return {
          runId: run.id,
          status: 'escalated',
          reply: null,
          decision,
          handoffReason: guardrailResult.reasons.join(', '),
          actions: actionResults,
        };
      }

      if (version.approvalMode === 'all_replies' || mode === 'approval') {
        await this.finishRun(run.id, 'waiting_approval', decision, reply, Date.now() - run.startedAt.getTime(), {
          actionResults,
        });
        aiAgentsDebug.step(run.id, 'run:waiting_approval', {
          approvalMode: version.approvalMode,
          mode,
          reply,
          actionResults,
        });
        return { runId: run.id, status: 'waiting_approval', reply, decision, actions: actionResults };
      }

      if (mode === 'auto' && channelId && reply) {
        aiAgentsDebug.step(run.id, 'outbound:send_start', {
          channelId,
          channelType,
          conversationId: conversation.id,
          reply,
        });
        await this.outbound.sendReply({
          workspaceId: input.workspaceId,
          conversationId: conversation.id,
          channelId,
          text: reply,
          metadata: {
            source: 'ai_agent',
            agentId: version.agentId,
            agentVersionId: version.id,
            runId: run.id,
          },
        });
        aiAgentsDebug.step(run.id, 'outbound:send_queued', {
          channelId,
          conversationId: conversation.id,
        });
      } else {
        aiAgentsDebug.step(run.id, 'outbound:send_skipped', {
          mode,
          hasChannelId: Boolean(channelId),
          hasReply: Boolean(reply),
        });
      }

      await this.persistMemoryUpdates(input.workspaceId, conversation.contactId, conversation.id, decision);
      aiAgentsDebug.step(run.id, 'memory:persisted', {
        updates: decision.memoryUpdates,
      });
      await this.finishRun(run.id, 'completed', decision, reply, Date.now() - run.startedAt.getTime(), {
        actionResults,
        knowledgeChunkIds: knowledgeHits.map((hit) => hit.id),
      });
      aiAgentsDebug.step(run.id, 'run:completed', {
        latencyMs: Date.now() - run.startedAt.getTime(),
        status: 'completed',
      });

      return { runId: run.id, status: 'completed', reply, decision, actions: actionResults };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aiAgentsDebug.error('runtime', 'run:failed', error, {
        runId: run.id,
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        messageId: input.messageId,
      });
      this.logger.error(`AI run failed runId=${run.id}: ${message}`);
      await this.failRun(run.id, message, Date.now() - run.startedAt.getTime());
      return { runId: run.id, status: 'failed', reply: null, decision: null, actions: [] };
    }
  }

  private async loadConversation(workspaceId: string, conversationId: string) {
    aiAgentsDebug.log('runtime.db', 'loadConversation query start', { workspaceId, conversationId });
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      include: {
        contact: {
          include: {
            lifecycle: true,
            tags: { include: { tag: true } },
            contactChannels: true,
          },
        },
        lastMessage: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { author: true, channel: true },
        },
      },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    aiAgentsDebug.log('runtime.db', 'loadConversation query result', {
      workspaceId,
      conversationId,
      found: true,
      contactId: conversation.contactId,
      messagesLoaded: conversation.messages.length,
    });
    return {
      ...conversation,
      messages: [...conversation.messages].reverse(),
    };
  }

  private async loadAgentVersion(input: {
    workspaceId: string;
    agentId?: string;
    channelType?: string | null;
    mode: AgentRunMode;
  }): Promise<AgentVersionConfig> {
    aiAgentsDebug.log('runtime.db', 'loadAgentVersion start', input);
    if (input.mode === 'sandbox' && input.agentId) {
      const draftRows = await this.prisma.$queryRawUnsafe<any[]>(
        `
          SELECT v.*, a."id" AS "agent_id"
          FROM "ai_agent_versions" v
          JOIN "ai_agents" a ON a."id" = v."agent_id"
          WHERE a."workspace_id" = $1::uuid
            AND a."id" = $2::uuid
            AND a."status" <> 'archived'
          ORDER BY CASE WHEN v."status" = 'draft' THEN 0 ELSE 1 END, v."version" DESC
          LIMIT 1
        `,
        input.workspaceId,
        input.agentId,
      );

      if (!draftRows.length) throw new BadRequestException('AI agent has no testable version');
      const version = this.toVersionConfig(draftRows[0]);
      aiAgentsDebug.log('runtime.db', 'loadAgentVersion sandbox result', {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        agentVersionId: version.id,
        version,
      });
      return version;
    }

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT
          v.*,
          a."id" AS "agent_id"
        FROM "ai_agent_versions" v
        JOIN "ai_agents" a ON a."active_version_id" = v."id"
        WHERE a."workspace_id" = $1::uuid
          AND a."status" = 'active'
          AND v."status" = 'published'
          AND ($2::uuid IS NULL OR a."id" = $2::uuid)
          AND ($3::text IS NULL OR cardinality(v."channel_allowlist") = 0 OR $3 = ANY(v."channel_allowlist"))
        ORDER BY a."updated_at" DESC
        LIMIT 1
      `,
      input.workspaceId,
      input.agentId || null,
      input.channelType || null,
    );

    if (!rows.length) {
      aiAgentsDebug.warn('runtime.db', 'loadAgentVersion no active published agent found', input);
      throw new BadRequestException('No active published AI agent is available for this workspace/channel');
    }

    const version = this.toVersionConfig(rows[0]);
    aiAgentsDebug.log('runtime.db', 'loadAgentVersion result', {
      workspaceId: input.workspaceId,
      agentId: version.agentId,
      agentVersionId: version.id,
      version,
    });
    return version;
  }

  private async createRun(input: {
    workspaceId: string;
    agentId: string;
    agentVersionId: string;
    conversationId: string;
    contactId: string;
    triggerMessageId?: string;
    channelType?: string | null;
    idempotencyKey: string;
    mode: AgentRunMode;
  }) {
    aiAgentsDebug.log('runtime.db', 'createRun start', input);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        INSERT INTO "ai_runs"
          ("workspace_id", "agent_id", "agent_version_id", "conversation_id", "contact_id",
           "trigger_message_id", "idempotency_key", "mode", "status", "channel_type", "started_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, 'running', $9, CURRENT_TIMESTAMP)
        ON CONFLICT ("workspace_id", "idempotency_key")
        DO UPDATE SET "started_at" = COALESCE("ai_runs"."started_at", CURRENT_TIMESTAMP)
        RETURNING "id", "started_at"
      `,
      input.workspaceId,
      input.agentId,
      input.agentVersionId,
      input.conversationId,
      input.contactId,
      input.triggerMessageId || null,
      input.idempotencyKey,
      input.mode,
      input.channelType || null,
    );

    const result = { id: rows[0].id, startedAt: new Date(rows[0].started_at) };
    aiAgentsDebug.log('runtime.db', 'createRun result', result);
    return result;
  }

  private async classifyIntent(
    runId: string,
    version: AgentVersionConfig,
    conversation: any,
    customerText: string | null,
    memories: any[],
  ) {
    aiAgentsDebug.step(runId, 'intent:gateway_start', {
      provider: version.llmConfig.provider,
      model: version.llmConfig.model,
      customerText,
      memoryCount: memories.length,
    });
    const { data } = await this.gateway.completeJson<{ intent: string; confidence: number; sentiment?: string }>({
      workspaceId: conversation.workspaceId,
      runId,
      operation: 'intent',
      provider: version.llmConfig.provider,
      model: version.llmConfig.model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Classify the customer message for a customer-service AI agent.' },
        {
          role: 'user',
          content: JSON.stringify({
            customerText,
            contact: this.contactSnapshot(conversation.contact),
            memories,
            allowedIntents: ['pricing', 'support', 'sales_qualification', 'refund', 'handoff', 'booking', 'unknown'],
          }),
        },
      ],
    });

    const result = {
      intent: data.intent || 'unknown',
      confidence: Math.max(0, Math.min(1, Number(data.confidence ?? 0.5))),
      sentiment: data.sentiment,
    };
    aiAgentsDebug.step(runId, 'intent:gateway_result', result);
    return result;
  }

  private async decideActions(
    runId: string,
    version: AgentVersionConfig,
    conversation: any,
    customerText: string | null,
    memories: any[],
    knowledgeHits: KnowledgeHit[],
    intent: { intent: string; confidence: number; sentiment?: string },
  ): Promise<AgentDecision> {
    aiAgentsDebug.step(runId, 'decision:gateway_start', {
      provider: version.llmConfig.provider,
      model: version.llmConfig.model,
      customerText,
      intent,
      memoryCount: memories.length,
      knowledgeHitCount: knowledgeHits.length,
      toolsAllowed: version.toolsAllowed,
    });
    const { data } = await this.gateway.completeJson<AgentDecision>({
      workspaceId: conversation.workspaceId,
      runId,
      operation: 'decision',
      provider: version.llmConfig.provider,
      model: version.llmConfig.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Decide the next deterministic agent action. Use only allowed tools. Prefer handoff for unsafe, refund, legal, angry, or low-confidence cases.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            agent: {
              name: version.name,
              tone: version.tone,
              language: version.defaultLanguage,
              toolsAllowed: version.toolsAllowed,
              guardrails: version.guardrails,
            },
            customerText,
            intent,
            contact: this.contactSnapshot(conversation.contact),
            memories,
            knowledge: knowledgeHits.map((hit) => ({
              id: hit.id,
              title: hit.title,
              score: hit.score,
              content: hit.content.slice(0, 1200),
            })),
            requiredShape: {
              intent: 'string',
              confidence: '0..1',
              sentiment: 'positive|neutral|negative|angry',
              needsHuman: 'boolean',
              responseStrategy: 'answer|ask_clarifying_question|run_tools|handoff|no_reply',
              tools: [{ name: 'string', input: {}, reason: 'string' }],
              memoryUpdates: [{ scope: 'conversation|contact', key: 'string', value: {}, confidence: 0.8 }],
            },
          }),
        },
      ],
    });

    const decision = this.normalizeDecision(data, intent);
    aiAgentsDebug.step(runId, 'decision:gateway_result', { raw: data, normalized: decision });
    return decision;
  }

  private async executeActions(runId: string, version: AgentVersionConfig, conversation: any, decision: AgentDecision) {
    const results: AgentRunResult['actions'] = [];
    aiAgentsDebug.step(runId, 'actions:plan_start', {
      plannedCount: decision.tools?.length || 0,
      plannedTools: decision.tools,
      allowedTools: version.toolsAllowed,
      approvalMode: version.approvalMode,
    });

    for (const planned of decision.tools || []) {
      if (!version.toolsAllowed.includes(planned.name)) {
        aiAgentsDebug.warn('runtime.actions', 'planned tool skipped because not allowed', {
          runId,
          toolName: planned.name,
          allowedTools: version.toolsAllowed,
          planned,
        });
        results.push({ toolName: planned.name, status: 'skipped', error: 'tool_not_allowed' });
        continue;
      }

      aiAgentsDebug.step(runId, 'action:insert_start', planned);
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `
          INSERT INTO "ai_actions" ("workspace_id", "run_id", "tool_name", "status", "input")
          VALUES ($1::uuid, $2::uuid, $3, 'running', $4::jsonb)
          RETURNING "id"
        `,
        conversation.workspaceId,
        runId,
        planned.name,
        JSON.stringify(planned.input || {}),
      );

      try {
        aiAgentsDebug.step(runId, 'action:execute_start', {
          actionId: rows[0].id,
          toolName: planned.name,
          input: planned.input,
        });
        const result = await this.tools.execute(
          {
            workspaceId: conversation.workspaceId,
            runId,
            conversationId: conversation.id,
            contactId: conversation.contactId,
            allowedTools: version.toolsAllowed,
            approvalMode: version.approvalMode,
          },
          planned.name,
          planned.input || {},
        );

        const status = result.status === 'waiting_approval' ? 'waiting_approval' : 'succeeded';
        aiAgentsDebug.step(runId, 'action:execute_result', {
          actionId: rows[0].id,
          toolName: planned.name,
          status,
          result,
        });
        await this.prisma.$executeRawUnsafe(
          `
            UPDATE "ai_actions"
            SET "status" = $1, "output" = $2::jsonb, "completed_at" = CURRENT_TIMESTAMP
            WHERE "id" = $3::uuid
          `,
          status,
          JSON.stringify(result.output || {}),
          rows[0].id,
        );

        results.push({ toolName: planned.name, status: status as any, output: result.output });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        aiAgentsDebug.error('runtime.actions', 'action:execute_failed', error, {
          runId,
          actionId: rows[0].id,
          toolName: planned.name,
          input: planned.input,
        });
        await this.prisma.$executeRawUnsafe(
          `
            UPDATE "ai_actions"
            SET "status" = 'failed', "error_message" = $1, "completed_at" = CURRENT_TIMESTAMP
            WHERE "id" = $2::uuid
          `,
          message,
          rows[0].id,
        );
        results.push({ toolName: planned.name, status: 'failed', error: message });
      }
    }

    aiAgentsDebug.step(runId, 'actions:plan_finished', { results });
    return results;
  }

  private async generateReply(
    runId: string,
    version: AgentVersionConfig,
    conversation: any,
    customerText: string | null,
    memories: any[],
    knowledgeHits: KnowledgeHit[],
    decision: AgentDecision,
    actionResults: AgentRunResult['actions'],
  ) {
    if (decision.responseStrategy === 'no_reply') {
      aiAgentsDebug.step(runId, 'reply:skipped_no_reply_strategy', { decision });
      return null;
    }

    aiAgentsDebug.step(runId, 'reply:gateway_start', {
      provider: version.llmConfig.provider,
      model: version.llmConfig.model,
      temperature: Number(version.llmConfig.temperature ?? 0.2),
      customerText,
      memoryCount: memories.length,
      knowledgeHitCount: knowledgeHits.length,
      actionResultCount: actionResults.length,
    });
    const { data, raw } = await this.gateway.completeJson<{ reply: string }>({
      workspaceId: conversation.workspaceId,
      runId,
      operation: 'reply',
      provider: version.llmConfig.provider,
      model: version.llmConfig.model,
      temperature: Number(version.llmConfig.temperature ?? 0.2),
      messages: [
        {
          role: 'system',
          content: [
            version.systemPrompt,
            `You are ${version.name}. Tone: ${version.tone}. Language: ${version.defaultLanguage}.`,
            'Answer only from supplied knowledge, CRM facts, memories, and tool results.',
            'Do not invent pricing, refunds, commitments, legal/medical advice, or unsupported guarantees.',
            'If information is missing, ask one concise clarifying question or say a human will help.',
            'Return JSON: {"reply":"..."}',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            customerText,
            decision,
            contact: this.contactSnapshot(conversation.contact),
            recentMessages: conversation.messages.map((message: any) => ({
              direction: message.direction,
              text: message.text,
              createdAt: message.createdAt,
            })),
            memories,
            knowledge: knowledgeHits.map((hit) => ({
              id: hit.id,
              title: hit.title,
              score: hit.score,
              content: hit.content,
            })),
            actionResults,
          }),
        },
      ],
    });

    const reply = typeof data.reply === 'string' ? data.reply.trim() : '';
    aiAgentsDebug.step(runId, 'reply:gateway_result', {
      raw,
      data,
      reply,
    });
    await this.logAiMessage(conversation.workspaceId, runId, conversation.id, 'assistant', reply, {
      promptTokens: raw.promptTokens,
      completionTokens: raw.completionTokens,
      totalTokens: raw.totalTokens,
    });
    aiAgentsDebug.step(runId, 'reply:aiMessage_logged', {
      promptTokens: raw.promptTokens,
      completionTokens: raw.completionTokens,
      totalTokens: raw.totalTokens,
    });
    return reply;
  }

  private async summarizeForHuman(
    runId: string,
    version: AgentVersionConfig,
    conversation: any,
    customerText: string | null,
    decision: AgentDecision,
    knowledgeHits: KnowledgeHit[],
  ) {
    aiAgentsDebug.step(runId, 'summary:gateway_start', {
      provider: version.llmConfig.provider,
      model: version.llmConfig.model,
      customerText,
      decision,
      knowledgeHitCount: knowledgeHits.length,
    });
    const response = await this.gateway.completeText({
      workspaceId: conversation.workspaceId,
      runId,
      operation: 'summary',
      provider: version.llmConfig.provider,
      model: version.llmConfig.model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: 'Write a compact human handoff summary with issue, customer state, known facts, and next best action.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            customerText,
            decision,
            contact: this.contactSnapshot(conversation.contact),
            recentMessages: conversation.messages.map((message: any) => ({
              direction: message.direction,
              text: message.text,
            })),
            knowledgeTitles: knowledgeHits.map((hit) => hit.title).filter(Boolean),
          }),
        },
      ],
    });
    aiAgentsDebug.step(runId, 'summary:gateway_result', {
      response,
      content: response.content,
    });
    return response.content;
  }

  private async loadMemories(workspaceId: string, contactId: string, conversationId: string) {
    aiAgentsDebug.log('runtime.db', 'loadMemories start', { workspaceId, contactId, conversationId });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT "scope", "memory_key" AS "key", "value", "confidence", "last_observed_at"
        FROM "ai_memories"
        WHERE "workspace_id" = $1::uuid
          AND (
            ("scope" = 'contact' AND "contact_id" = $2::uuid)
            OR ("scope" = 'conversation' AND "conversation_id" = $3::uuid)
          )
          AND ("expires_at" IS NULL OR "expires_at" > CURRENT_TIMESTAMP)
        ORDER BY "last_observed_at" DESC
        LIMIT 30
      `,
      workspaceId,
      contactId,
      conversationId,
    );
    aiAgentsDebug.log('runtime.db', 'loadMemories result', {
      workspaceId,
      contactId,
      conversationId,
      count: rows.length,
      memories: rows,
    });
    return rows;
  }

  private async isConversationAiPaused(workspaceId: string, conversationId: string) {
    aiAgentsDebug.log('runtime.db', 'isConversationAiPaused start', { workspaceId, conversationId });
    const rows = await this.prisma.$queryRawUnsafe<Array<{ value: any }>>(
      `
        SELECT "value"
        FROM "ai_memories"
        WHERE "workspace_id" = $1::uuid
          AND "conversation_id" = $2::uuid
          AND "scope" = 'conversation'
          AND "memory_key" = 'ai_status'
        LIMIT 1
      `,
      workspaceId,
      conversationId,
    );

    const paused = rows[0]?.value?.status === 'paused';
    aiAgentsDebug.log('runtime.db', 'isConversationAiPaused result', {
      workspaceId,
      conversationId,
      paused,
      value: rows[0]?.value,
    });
    return paused;
  }

  private async persistMemoryUpdates(workspaceId: string, contactId: string, conversationId: string, decision: AgentDecision) {
    aiAgentsDebug.log('runtime.db', 'persistMemoryUpdates start', {
      workspaceId,
      contactId,
      conversationId,
      updates: decision.memoryUpdates,
    });
    for (const memory of decision.memoryUpdates || []) {
      aiAgentsDebug.log('runtime.db', 'persistMemoryUpdate item start', {
        workspaceId,
        contactId,
        conversationId,
        memory,
      });
      if (memory.scope === 'contact') {
        await this.prisma.$executeRawUnsafe(
          `
            INSERT INTO "ai_memories"
              ("workspace_id", "contact_id", "scope", "memory_key", "value", "confidence")
            VALUES ($1::uuid, $2::uuid, 'contact', $3, $4::jsonb, $5)
            ON CONFLICT ("workspace_id", "contact_id", "memory_key")
            WHERE "scope" = 'contact' AND "contact_id" IS NOT NULL
            DO UPDATE SET "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence",
                          "updated_at" = CURRENT_TIMESTAMP, "last_observed_at" = CURRENT_TIMESTAMP
          `,
          workspaceId,
          contactId,
          memory.key,
          JSON.stringify(memory.value || {}),
          memory.confidence ?? 0.8,
        );
      } else {
        await this.prisma.$executeRawUnsafe(
          `
            INSERT INTO "ai_memories"
              ("workspace_id", "conversation_id", "scope", "memory_key", "value", "confidence")
            VALUES ($1::uuid, $2::uuid, 'conversation', $3, $4::jsonb, $5)
            ON CONFLICT ("workspace_id", "conversation_id", "memory_key")
            WHERE "scope" = 'conversation' AND "conversation_id" IS NOT NULL
            DO UPDATE SET "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence",
                          "updated_at" = CURRENT_TIMESTAMP, "last_observed_at" = CURRENT_TIMESTAMP
          `,
          workspaceId,
          conversationId,
          memory.key,
          JSON.stringify(memory.value || {}),
          memory.confidence ?? 0.8,
        );
      }
      aiAgentsDebug.log('runtime.db', 'persistMemoryUpdate item result', {
        workspaceId,
        contactId,
        conversationId,
        key: memory.key,
        scope: memory.scope,
      });
    }
    aiAgentsDebug.log('runtime.db', 'persistMemoryUpdates result', {
      workspaceId,
      contactId,
      conversationId,
      updateCount: decision.memoryUpdates?.length || 0,
    });
  }

  private async getRecentAutoReplyCount(workspaceId: string, conversationId: string) {
    aiAgentsDebug.log('runtime.db', 'getRecentAutoReplyCount start', { workspaceId, conversationId });
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `
        SELECT COUNT(*)::bigint AS "count"
        FROM "Message"
        WHERE "workspaceId" = $1::uuid
          AND "conversationId" = $2::uuid
          AND "direction" = 'outgoing'
          AND "metadata"->>'source' = 'ai_agent'
          AND "createdAt" > CURRENT_TIMESTAMP - interval '24 hours'
      `,
      workspaceId,
      conversationId,
    );

    const count = Number(rows[0]?.count || 0);
    aiAgentsDebug.log('runtime.db', 'getRecentAutoReplyCount result', { workspaceId, conversationId, count });
    return count;
  }

  private latestCustomerText(messages: any[]) {
    const latest = [...messages].reverse().find((message) => message.direction === 'incoming' && message.text);
    return latest?.text || null;
  }

  private normalizeDecision(raw: Partial<AgentDecision>, intent: { intent: string; confidence: number; sentiment?: string }): AgentDecision {
    const allowedStrategies = new Set(['answer', 'ask_clarifying_question', 'run_tools', 'handoff', 'no_reply']);
    return {
      intent: raw.intent || intent.intent || 'unknown',
      confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? intent.confidence ?? 0.5))),
      sentiment: raw.sentiment || (intent.sentiment as any) || 'neutral',
      needsHuman: Boolean(raw.needsHuman),
      responseStrategy: allowedStrategies.has(raw.responseStrategy || '') ? (raw.responseStrategy as any) : 'answer',
      tools: Array.isArray(raw.tools) ? raw.tools.slice(0, 3) : [],
      memoryUpdates: Array.isArray(raw.memoryUpdates) ? raw.memoryUpdates.slice(0, 5) : [],
    };
  }

  private contactSnapshot(contact: any) {
    return {
      id: contact.id,
      name: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
      status: contact.status,
      lifecycle: contact.lifecycle?.name || null,
      tags: contact.tags?.map((tag: any) => tag.tag?.name).filter(Boolean) || [],
      channels: contact.contactChannels?.map((channel: any) => ({
        type: channel.channelType,
        identifier: channel.identifier,
      })),
    };
  }

  private toVersionConfig(row: any): AgentVersionConfig {
    return {
      id: row.id,
      agentId: row.agent_id,
      name: row.name,
      tone: row.tone,
      defaultLanguage: row.default_language,
      channelAllowlist: row.channel_allowlist || [],
      businessHours: row.business_hours || {},
      llmConfig: row.llm_config || {},
      runtimeConfig: row.runtime_config || {},
      guardrails: row.guardrails || {},
      toolsAllowed: Array.isArray(row.tools_allowed) ? row.tools_allowed : [],
      knowledgeSourceIds: row.knowledge_source_ids || [],
      systemPrompt: row.system_prompt || '',
      approvalMode: row.approval_mode || 'off',
      sandboxMode: Boolean(row.sandbox_mode),
    };
  }

  private async logAiMessage(
    workspaceId: string,
    runId: string,
    conversationId: string,
    role: 'customer' | 'assistant' | 'system' | 'tool' | 'policy',
    content: string,
    metadata: Record<string, any>,
  ) {
    aiAgentsDebug.log('runtime.db', 'logAiMessage start', {
      workspaceId,
      runId,
      conversationId,
      role,
      content,
      metadata,
    });
    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO "ai_messages"
          ("workspace_id", "run_id", "conversation_id", "role", "content", "metadata",
           "prompt_tokens", "completion_tokens", "total_tokens")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8, $9)
      `,
      workspaceId,
      runId,
      conversationId,
      role,
      content,
      JSON.stringify(metadata || {}),
      Number(metadata.promptTokens || 0),
      Number(metadata.completionTokens || 0),
      Number(metadata.totalTokens || 0),
    );
    aiAgentsDebug.log('runtime.db', 'logAiMessage result', {
      workspaceId,
      runId,
      conversationId,
      role,
    });
  }

  private async finishRun(
    runId: string,
    status: 'completed' | 'waiting_approval' | 'escalated',
    decision: AgentDecision,
    reply: string | null,
    latencyMs: number,
    metadata: Record<string, any>,
  ) {
    aiAgentsDebug.log('runtime.db', 'finishRun start', {
      runId,
      status,
      decision,
      reply,
      latencyMs,
      metadata,
    });
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "ai_runs"
        SET "status" = $1,
            "intent" = $2,
            "confidence" = $3,
            "handoff_required" = $4,
            "decision_snapshot" = $5::jsonb,
            "response_snapshot" = $6::jsonb,
            "latency_ms" = $7,
            "completed_at" = CURRENT_TIMESTAMP
        WHERE "id" = $8::uuid
      `,
      status,
      decision.intent,
      decision.confidence,
      status === 'escalated',
      JSON.stringify({ decision, metadata }),
      JSON.stringify({ reply }),
      latencyMs,
      runId,
    );
    aiAgentsDebug.log('runtime.db', 'finishRun result', { runId, status, latencyMs });
  }

  private async failRun(runId: string, errorMessage: string, latencyMs: number) {
    aiAgentsDebug.log('runtime.db', 'failRun start', { runId, errorMessage, latencyMs });
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "ai_runs"
        SET "status" = 'failed',
            "error_message" = $1,
            "latency_ms" = $2,
            "completed_at" = CURRENT_TIMESTAMP
        WHERE "id" = $3::uuid
      `,
      errorMessage,
      latencyMs,
      runId,
    );
    aiAgentsDebug.log('runtime.db', 'failRun result', { runId, latencyMs });
  }
}
