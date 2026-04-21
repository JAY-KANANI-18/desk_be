import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { aiAgentQueue } from 'src/queues/ai-agent.queue';
import { CreateAiAgentDto, CreateKnowledgeSourceDto, FeedbackDto, UpdateAiAgentDraftDto } from './dto/ai-agent.dto';
import { aiAgentsDebug } from './ai-agents-debug.logger';
import { KnowledgeService } from './knowledge/knowledge.service';
import { AgentRuntimeService } from './runtime/agent-runtime.service';

const DEFAULT_TOOLS = [
  'createLead',
  'assignConversation',
  'updateContactField',
  'changeLifecycleStage',
  'createTicket',
  'triggerWorkflow',
  'escalateHuman',
];

@Injectable()
export class AiAgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly runtime: AgentRuntimeService,
  ) {}

  async listAgents(workspaceId: string) {
    aiAgentsDebug.log('api.service', 'listAgents start', { workspaceId });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT
          a.*,
          v."version" AS "active_version",
          v."tone" AS "active_tone",
          v."default_language" AS "active_language",
          v."channel_allowlist" AS "active_channels"
        FROM "ai_agents" a
        LEFT JOIN "ai_agent_versions" v ON v."id" = a."active_version_id"
        WHERE a."workspace_id" = $1::uuid
          AND a."archived_at" IS NULL
        ORDER BY a."updated_at" DESC
      `,
      workspaceId,
    );

    const result = rows.map((row) => this.toAgentListDto(row));
    aiAgentsDebug.log('api.service', 'listAgents result', {
      workspaceId,
      count: result.length,
      agents: result.map((agent) => ({
        id: agent.id,
        name: agent.name,
        status: agent.status,
        activeVersionId: agent.activeVersionId,
      })),
    });
    return result;
  }

  async createAgent(workspaceId: string, userId: string, dto: CreateAiAgentDto) {
    aiAgentsDebug.log('api.service', 'createAgent start', {
      workspaceId,
      userId,
      dto,
    });
    const toolsAllowed = dto.toolsAllowed?.length ? dto.toolsAllowed : DEFAULT_TOOLS;

    const result = await this.prisma.$transaction(async (tx) => {
      const agentRows = await tx.$queryRawUnsafe<any[]>(
        `
          INSERT INTO "ai_agents" ("workspace_id", "name", "description", "agent_type", "status", "created_by_user_id")
          VALUES ($1::uuid, $2, $3, $4, 'draft', $5::uuid)
          RETURNING *
        `,
        workspaceId,
        dto.name.trim(),
        dto.description || null,
        dto.agentType || 'custom',
        userId || null,
      );

      const agent = agentRows[0];
      const versionRows = await tx.$queryRawUnsafe<any[]>(
        `
          INSERT INTO "ai_agent_versions"
            ("workspace_id", "agent_id", "version", "status", "name", "tone", "default_language",
             "channel_allowlist", "llm_config", "runtime_config", "guardrails", "tools_allowed",
             "knowledge_source_ids", "system_prompt", "created_by_user_id")
          VALUES
            ($1::uuid, $2::uuid, 1, 'draft', $3, $4, $5, $6::text[], $7::jsonb, $8::jsonb,
             $9::jsonb, $10::jsonb, $11::uuid[], $12, $13::uuid)
          RETURNING *
        `,
        workspaceId,
        agent.id,
        dto.name.trim(),
        dto.tone || 'professional',
        dto.defaultLanguage || 'auto',
        dto.channelAllowlist || [],
        JSON.stringify(dto.llmConfig || {}),
        JSON.stringify({
          maxAutoReplies: 5,
          confidenceThreshold: 0.65,
          ...(dto.runtimeConfig || {}),
        }),
        JSON.stringify({
          noHallucinatedPricing: true,
          noUnsupportedRefunds: true,
          noLegalAdvice: true,
          noMedicalClaims: true,
          ...(dto.guardrails || {}),
        }),
        JSON.stringify(toolsAllowed),
        dto.knowledgeSourceIds || [],
        dto.systemPrompt || this.defaultPromptFor(dto.agentType || 'custom'),
        userId || null,
      );

      return { agent, draftVersion: versionRows[0] };
    });

    const response = {
      agent: this.toAgentDto(result.agent),
      draftVersion: this.toVersionDto(result.draftVersion),
    };
    aiAgentsDebug.log('api.service', 'createAgent result', {
      workspaceId,
      agentId: response.agent.id,
      draftVersionId: response.draftVersion.id,
      toolsAllowed,
    });
    return response;
  }

  async getAgent(workspaceId: string, agentId: string) {
    aiAgentsDebug.log('api.service', 'getAgent start', { workspaceId, agentId });
    const agents = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "ai_agents" WHERE "workspace_id" = $1::uuid AND "id" = $2::uuid LIMIT 1`,
      workspaceId,
      agentId,
    );
    if (!agents.length) throw new NotFoundException('AI agent not found');

    const versions = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT *
        FROM "ai_agent_versions"
        WHERE "workspace_id" = $1::uuid
          AND "agent_id" = $2::uuid
        ORDER BY "version" DESC
      `,
      workspaceId,
      agentId,
    );

    const response = {
      agent: this.toAgentDto(agents[0]),
      versions: versions.map((version) => this.toVersionDto(version)),
    };
    aiAgentsDebug.log('api.service', 'getAgent result', {
      workspaceId,
      agentId,
      versionCount: response.versions.length,
      activeVersionId: response.agent.activeVersionId,
    });
    return response;
  }

  async updateDraft(workspaceId: string, agentId: string, dto: UpdateAiAgentDraftDto) {
    aiAgentsDebug.log('api.service', 'updateDraft start', { workspaceId, agentId, dto });
    const agent = await this.getAgent(workspaceId, agentId);
    const latest = agent.versions[0];
    if (!latest) throw new NotFoundException('Agent has no versions');

    let draft = latest.status === 'draft' ? latest : null;
    if (!draft) {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `
          INSERT INTO "ai_agent_versions"
            ("workspace_id", "agent_id", "version", "status", "name", "tone", "default_language",
             "channel_allowlist", "business_hours", "llm_config", "runtime_config", "guardrails",
             "tools_allowed", "knowledge_source_ids", "system_prompt", "approval_mode", "sandbox_mode")
          SELECT
            "workspace_id", "agent_id", "version" + 1, 'draft', "name", "tone", "default_language",
            "channel_allowlist", "business_hours", "llm_config", "runtime_config", "guardrails",
            "tools_allowed", "knowledge_source_ids", "system_prompt", "approval_mode", "sandbox_mode"
          FROM "ai_agent_versions"
          WHERE "id" = $1::uuid
          RETURNING *
        `,
        latest.id,
      );
      draft = this.toVersionDto(rows[0]);
    }

    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "ai_agents"
        SET "name" = COALESCE($3, "name"),
            "description" = COALESCE($4, "description"),
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "workspace_id" = $1::uuid AND "id" = $2::uuid
      `,
      workspaceId,
      agentId,
      dto.name || null,
      dto.description || null,
    );

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        UPDATE "ai_agent_versions"
        SET
          "name" = COALESCE($3, "name"),
          "tone" = COALESCE($4, "tone"),
          "default_language" = COALESCE($5, "default_language"),
          "channel_allowlist" = COALESCE($6::text[], "channel_allowlist"),
          "business_hours" = COALESCE($7::jsonb, "business_hours"),
          "llm_config" = COALESCE($8::jsonb, "llm_config"),
          "runtime_config" = COALESCE($9::jsonb, "runtime_config"),
          "guardrails" = COALESCE($10::jsonb, "guardrails"),
          "tools_allowed" = COALESCE($11::jsonb, "tools_allowed"),
          "knowledge_source_ids" = COALESCE($12::uuid[], "knowledge_source_ids"),
          "system_prompt" = COALESCE($13, "system_prompt"),
          "approval_mode" = COALESCE($14, "approval_mode"),
          "sandbox_mode" = COALESCE($15, "sandbox_mode"),
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "workspace_id" = $1::uuid
          AND "id" = $2::uuid
          AND "status" = 'draft'
        RETURNING *
      `,
      workspaceId,
      draft.id,
      dto.name || null,
      dto.tone || null,
      dto.defaultLanguage || null,
      dto.channelAllowlist || null,
      dto.businessHours ? JSON.stringify(dto.businessHours) : null,
      dto.llmConfig ? JSON.stringify(dto.llmConfig) : null,
      dto.runtimeConfig ? JSON.stringify(dto.runtimeConfig) : null,
      dto.guardrails ? JSON.stringify(dto.guardrails) : null,
      dto.toolsAllowed ? JSON.stringify(dto.toolsAllowed) : null,
      dto.knowledgeSourceIds || null,
      dto.systemPrompt || null,
      dto.approvalMode || null,
      typeof dto.sandboxMode === 'boolean' ? dto.sandboxMode : null,
    );

    const result = this.toVersionDto(rows[0]);
    aiAgentsDebug.log('api.service', 'updateDraft result', {
      workspaceId,
      agentId,
      draftVersionId: result.id,
      version: result.version,
      changedKeys: Object.keys(dto || {}),
    });
    return result;
  }

  async publish(workspaceId: string, agentId: string, userId: string) {
    aiAgentsDebug.log('api.service', 'publish start', { workspaceId, agentId, userId });
    const agent = await this.getAgent(workspaceId, agentId);
    const draft = agent.versions.find((version) => version.status === 'draft') || null;

    if (!draft) {
      const activeOrPublished = agent.versions.find((version) => version.id === agent.agent.activeVersionId)
        || agent.versions.find((version) => version.status === 'published')
        || null;

      if (!activeOrPublished) throw new BadRequestException('No draft or published version available to activate');

      aiAgentsDebug.log('api.service', 'publish fallback activate existing version', {
        workspaceId,
        agentId,
        userId,
        versionId: activeOrPublished.id,
        currentAgentStatus: agent.agent.status,
      });

      await this.prisma.$executeRawUnsafe(
        `
          UPDATE "ai_agents"
          SET "status" = 'active', "active_version_id" = $3::uuid, "updated_at" = CURRENT_TIMESTAMP
          WHERE "workspace_id" = $1::uuid AND "id" = $2::uuid
        `,
        workspaceId,
        agentId,
        activeOrPublished.id,
      );

      const response = await this.getAgent(workspaceId, agentId);
      aiAgentsDebug.log('api.service', 'publish fallback result', {
        workspaceId,
        agentId,
        activeVersionId: response.agent.activeVersionId,
      });
      return response;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `
          UPDATE "ai_agent_versions"
          SET "status" = 'published', "published_at" = CURRENT_TIMESTAMP, "published_by_user_id" = $3::uuid
          WHERE "workspace_id" = $1::uuid AND "id" = $2::uuid
        `,
        workspaceId,
        draft.id,
        userId || null,
      );

      await tx.$executeRawUnsafe(
        `
          UPDATE "ai_agents"
          SET "status" = 'active', "active_version_id" = $3::uuid, "updated_at" = CURRENT_TIMESTAMP
          WHERE "workspace_id" = $1::uuid AND "id" = $2::uuid
        `,
        workspaceId,
        agentId,
        draft.id,
      );
    });

    const response = await this.getAgent(workspaceId, agentId);
    aiAgentsDebug.log('api.service', 'publish result', {
      workspaceId,
      agentId,
      activeVersionId: response.agent.activeVersionId,
    });
    return response;
  }

  async rollback(workspaceId: string, agentId: string, versionId: string) {
    aiAgentsDebug.log('api.service', 'rollback start', { workspaceId, agentId, versionId });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT *
        FROM "ai_agent_versions"
        WHERE "workspace_id" = $1::uuid
          AND "agent_id" = $2::uuid
          AND "id" = $3::uuid
          AND "status" = 'published'
        LIMIT 1
      `,
      workspaceId,
      agentId,
      versionId,
    );
    if (!rows.length) throw new BadRequestException('Only published versions can be rolled back to');

    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "ai_agents"
        SET "status" = 'active', "active_version_id" = $3::uuid, "updated_at" = CURRENT_TIMESTAMP
        WHERE "workspace_id" = $1::uuid AND "id" = $2::uuid
      `,
      workspaceId,
      agentId,
      versionId,
    );

    const response = await this.getAgent(workspaceId, agentId);
    aiAgentsDebug.log('api.service', 'rollback result', {
      workspaceId,
      agentId,
      activeVersionId: response.agent.activeVersionId,
    });
    return response;
  }

  async pause(workspaceId: string, agentId: string) {
    aiAgentsDebug.log('api.service', 'pause agent start', { workspaceId, agentId });
    await this.prisma.$executeRawUnsafe(
      `UPDATE "ai_agents" SET "status" = 'paused', "updated_at" = CURRENT_TIMESTAMP WHERE "workspace_id" = $1::uuid AND "id" = $2::uuid`,
      workspaceId,
      agentId,
    );
    return this.getAgent(workspaceId, agentId);
  }

  async archive(workspaceId: string, agentId: string) {
    aiAgentsDebug.log('api.service', 'archive agent start', { workspaceId, agentId });
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "ai_agents"
        SET "status" = 'archived', "archived_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
        WHERE "workspace_id" = $1::uuid AND "id" = $2::uuid
      `,
      workspaceId,
      agentId,
    );
    return { archived: true };
  }

  createKnowledgeSource(workspaceId: string, userId: string, dto: CreateKnowledgeSourceDto) {
    aiAgentsDebug.log('api.service', 'createKnowledgeSource start', { workspaceId, userId, dto });
    return this.knowledge.createSource(workspaceId, { ...dto, createdByUserId: userId });
  }

  listKnowledgeSources(workspaceId: string) {
    aiAgentsDebug.log('api.service', 'listKnowledgeSources start', { workspaceId });
    return this.knowledge.listSources(workspaceId);
  }

  enableKnowledgeSource(workspaceId: string, sourceId: string) {
    aiAgentsDebug.log('api.service', 'enableKnowledgeSource start', { workspaceId, sourceId });
    return this.knowledge.setSourceEnabled(workspaceId, sourceId, true);
  }

  disableKnowledgeSource(workspaceId: string, sourceId: string) {
    aiAgentsDebug.log('api.service', 'disableKnowledgeSource start', { workspaceId, sourceId });
    return this.knowledge.setSourceEnabled(workspaceId, sourceId, false);
  }

  reindexKnowledgeSource(workspaceId: string, sourceId: string) {
    aiAgentsDebug.log('api.service', 'reindexKnowledgeSource start', { workspaceId, sourceId });
    return this.knowledge.reindexSource(workspaceId, sourceId);
  }

  sandboxRun(workspaceId: string, agentId: string, dto: { conversationId: string; message: string }) {
    aiAgentsDebug.log('api.service', 'sandboxRun start', { workspaceId, agentId, dto });
    return this.runtime.runForConversation({
      workspaceId,
      agentId,
      conversationId: dto.conversationId,
      sandboxMessage: dto.message,
      mode: 'sandbox',
      idempotencyKey: `${workspaceId}:${agentId}:sandbox:${Date.now()}`,
    });
  }

  async enqueueConversationRun(workspaceId: string, conversationId: string, messageId?: string) {
    const idempotencyKey = `${workspaceId}:${conversationId}:${messageId || Date.now()}`;
    aiAgentsDebug.log('api.service', 'manual enqueueConversationRun start', {
      workspaceId,
      conversationId,
      messageId,
      idempotencyKey,
    });
    const job = await aiAgentQueue.add(
      'ai.agent.message_received',
      {
        type: 'MESSAGE_RECEIVED',
        workspaceId,
        conversationId,
        messageId,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
      },
      { jobId: idempotencyKey },
    );
    const counts = await aiAgentQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
    aiAgentsDebug.log('api.service', 'manual enqueueConversationRun queued', {
      jobId: job.id,
      jobName: job.name,
      queue: job.queueName,
      idempotencyKey,
      counts,
      jobData: job.data,
    });
    return { queued: true, idempotencyKey };
  }

  async getRun(workspaceId: string, runId: string) {
    aiAgentsDebug.log('api.service', 'getRun start', { workspaceId, runId });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "ai_runs" WHERE "workspace_id" = $1::uuid AND "id" = $2::uuid LIMIT 1`,
      workspaceId,
      runId,
    );
    if (!rows.length) throw new NotFoundException('AI run not found');

    const [messages, actions, tools] = await Promise.all([
      this.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "ai_messages" WHERE "workspace_id" = $1::uuid AND "run_id" = $2::uuid ORDER BY "created_at"`, workspaceId, runId),
      this.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "ai_actions" WHERE "workspace_id" = $1::uuid AND "run_id" = $2::uuid ORDER BY "created_at"`, workspaceId, runId),
      this.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "ai_tool_logs" WHERE "workspace_id" = $1::uuid AND "run_id" = $2::uuid ORDER BY "created_at"`, workspaceId, runId),
    ]);

    const result = { run: this.toRunDto(rows[0]), messages, actions, toolLogs: tools };
    aiAgentsDebug.log('api.service', 'getRun result', {
      workspaceId,
      runId,
      messageCount: messages.length,
      actionCount: actions.length,
      toolLogCount: tools.length,
      result,
    });
    return result;
  }

  async conversationStatus(workspaceId: string, conversationId: string) {
    aiAgentsDebug.log('api.service', 'conversationStatus start', { workspaceId, conversationId });
    const [runs, memories, approvals, escalations] = await Promise.all([
      this.prisma.$queryRawUnsafe<any[]>(
        `
          SELECT *
          FROM "ai_runs"
          WHERE "workspace_id" = $1::uuid
            AND "conversation_id" = $2::uuid
          ORDER BY "created_at" DESC
          LIMIT 1
        `,
        workspaceId,
        conversationId,
      ),
      this.prisma.$queryRawUnsafe<any[]>(
        `
          SELECT "scope", "memory_key" AS "key", "value", "confidence", "last_observed_at"
          FROM "ai_memories"
          WHERE "workspace_id" = $1::uuid
            AND "conversation_id" = $2::uuid
          ORDER BY "last_observed_at" DESC
          LIMIT 8
        `,
        workspaceId,
        conversationId,
      ),
      this.prisma.$queryRawUnsafe<any[]>(
        `
          SELECT a.*
          FROM "ai_actions" a
          JOIN "ai_runs" r ON r."id" = a."run_id"
          WHERE a."workspace_id" = $1::uuid
            AND r."conversation_id" = $2::uuid
            AND a."status" = 'waiting_approval'
          ORDER BY a."created_at" DESC
        `,
        workspaceId,
        conversationId,
      ),
      this.prisma.$queryRawUnsafe<any[]>(
        `
          SELECT *
          FROM "ai_escalations"
          WHERE "workspace_id" = $1::uuid
            AND "conversation_id" = $2::uuid
            AND "status" IN ('open', 'assigned')
          ORDER BY "created_at" DESC
          LIMIT 1
        `,
        workspaceId,
        conversationId,
      ),
    ]);

    const latestRun = runs[0] ? this.toRunDto(runs[0]) : null;
    const pendingApprovalCount = approvals.length;
    const liveState = pendingApprovalCount
      ? 'waiting_approval'
      : escalations[0]
      ? 'human_takeover'
      : latestRun?.status === 'completed'
      ? 'ai_handling'
      : 'idle';

    const result = {
      liveState,
      latestRun,
      memories,
      pendingApprovals: approvals,
      escalation: escalations[0] || null,
    };
    aiAgentsDebug.log('api.service', 'conversationStatus result', {
      workspaceId,
      conversationId,
      result,
    });
    return result;
  }

  async pauseConversation(workspaceId: string, conversationId: string, userId: string) {
    aiAgentsDebug.log('api.service', 'pauseConversation start', { workspaceId, conversationId, userId });
    await this.setConversationAiStatus(workspaceId, conversationId, {
      status: 'paused',
      updatedByUserId: userId,
      updatedAt: new Date().toISOString(),
    });
    const result = { status: 'paused' };
    aiAgentsDebug.log('api.service', 'pauseConversation result', { workspaceId, conversationId, result });
    return result;
  }

  async resumeConversation(workspaceId: string, conversationId: string, userId: string) {
    aiAgentsDebug.log('api.service', 'resumeConversation start', { workspaceId, conversationId, userId });
    await this.setConversationAiStatus(workspaceId, conversationId, {
      status: 'active',
      updatedByUserId: userId,
      updatedAt: new Date().toISOString(),
    });
    const result = { status: 'active' };
    aiAgentsDebug.log('api.service', 'resumeConversation result', { workspaceId, conversationId, result });
    return result;
  }

  async listApprovals(workspaceId: string) {
    aiAgentsDebug.log('api.service', 'listApprovals start', { workspaceId });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT
          a.*,
          r."conversation_id",
          r."contact_id",
          r."intent",
          r."confidence",
          ag."name" AS "agent_name",
          c."firstName" AS "contact_first_name",
          c."lastName" AS "contact_last_name",
          c."email" AS "contact_email",
          c."phone" AS "contact_phone"
        FROM "ai_actions" a
        JOIN "ai_runs" r ON r."id" = a."run_id"
        JOIN "ai_agents" ag ON ag."id" = r."agent_id"
        LEFT JOIN "Contact" c ON c."id" = r."contact_id"
        WHERE a."workspace_id" = $1::uuid
          AND a."status" = 'waiting_approval'
        ORDER BY a."created_at" DESC
        LIMIT 100
      `,
      workspaceId,
    );

    const result = rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      toolName: row.tool_name,
      input: row.input,
      createdAt: row.created_at,
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      intent: row.intent,
      confidence: row.confidence,
      agentName: row.agent_name,
      contactName: [row.contact_first_name, row.contact_last_name].filter(Boolean).join(' ') || 'Unknown contact',
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
    }));
    aiAgentsDebug.log('api.service', 'listApprovals result', {
      workspaceId,
      count: result.length,
      approvals: result,
    });
    return result;
  }

  async approveAction(workspaceId: string, actionId: string, userId: string, editedInput?: Record<string, any>) {
    aiAgentsDebug.log('api.service', 'approveAction start', { workspaceId, actionId, userId, editedInput });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        UPDATE "ai_actions"
        SET "status" = 'succeeded',
            "input" = COALESCE($4::jsonb, "input"),
            "output" = jsonb_build_object('approved', true, 'approvedByUserId', $3::text),
            "approved_by_user_id" = $3::uuid,
            "approved_at" = CURRENT_TIMESTAMP,
            "completed_at" = CURRENT_TIMESTAMP
        WHERE "workspace_id" = $1::uuid
          AND "id" = $2::uuid
          AND "status" = 'waiting_approval'
        RETURNING *
      `,
      workspaceId,
      actionId,
      userId || null,
      editedInput ? JSON.stringify(editedInput) : null,
    );

    if (!rows.length) throw new NotFoundException('Pending approval not found');
    const result = { approved: true, actionId };
    aiAgentsDebug.log('api.service', 'approveAction result', {
      workspaceId,
      actionId,
      row: rows[0],
      result,
    });
    return result;
  }

  async rejectAction(workspaceId: string, actionId: string, reason?: string) {
    aiAgentsDebug.log('api.service', 'rejectAction start', { workspaceId, actionId, reason });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        UPDATE "ai_actions"
        SET "status" = 'skipped',
            "output" = jsonb_build_object('approved', false, 'reason', $3::text),
            "completed_at" = CURRENT_TIMESTAMP
        WHERE "workspace_id" = $1::uuid
          AND "id" = $2::uuid
          AND "status" = 'waiting_approval'
        RETURNING *
      `,
      workspaceId,
      actionId,
      reason || null,
    );

    if (!rows.length) throw new NotFoundException('Pending approval not found');
    const result = { rejected: true, actionId };
    aiAgentsDebug.log('api.service', 'rejectAction result', {
      workspaceId,
      actionId,
      row: rows[0],
      result,
    });
    return result;
  }

  async analytics(workspaceId: string, from?: string, to?: string) {
    aiAgentsDebug.log('api.service', 'analytics start', { workspaceId, from, to });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT
          COUNT(*)::int AS "runs",
          COUNT(*) FILTER (WHERE "status" = 'completed')::int AS "completed",
          COUNT(*) FILTER (WHERE "status" = 'escalated')::int AS "escalated",
          COUNT(*) FILTER (WHERE "status" = 'failed')::int AS "failed",
          AVG("latency_ms")::int AS "avg_latency_ms",
          AVG("confidence")::float AS "avg_confidence"
        FROM "ai_runs"
        WHERE "workspace_id" = $1::uuid
          AND ($2::timestamp IS NULL OR "created_at" >= $2::timestamp)
          AND ($3::timestamp IS NULL OR "created_at" <= $3::timestamp)
      `,
      workspaceId,
      from || null,
      to || null,
    );

    const usage = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT
          "provider",
          "model",
          SUM("total_tokens")::bigint AS "total_tokens",
          SUM("cost_micros")::bigint AS "cost_micros"
        FROM "ai_usage_billing"
        WHERE "workspace_id" = $1::uuid
          AND ($2::date IS NULL OR "period_start" >= $2::date)
        GROUP BY "provider", "model"
        ORDER BY SUM("total_tokens") DESC
      `,
      workspaceId,
      from || null,
    );

    const result = { summary: rows[0], usage };
    aiAgentsDebug.log('api.service', 'analytics result', { workspaceId, from, to, result });
    return result;
  }

  async createFeedback(workspaceId: string, userId: string, dto: FeedbackDto) {
    aiAgentsDebug.log('api.service', 'createFeedback start', { workspaceId, userId, dto });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        INSERT INTO "ai_feedback"
          ("workspace_id", "run_id", "conversation_id", "message_id", "rating", "label", "comment", "created_by_user_id")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid)
        RETURNING *
      `,
      workspaceId,
      dto.runId || null,
      dto.conversationId || null,
      dto.messageId || null,
      dto.rating || null,
      dto.label || null,
      dto.comment || null,
      userId || null,
    );
    aiAgentsDebug.log('api.service', 'createFeedback result', { workspaceId, row: rows[0] });
    return rows[0];
  }

  private async setConversationAiStatus(workspaceId: string, conversationId: string, value: Record<string, any>) {
    aiAgentsDebug.log('api.service', 'setConversationAiStatus start', { workspaceId, conversationId, value });
    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO "ai_memories"
          ("workspace_id", "conversation_id", "scope", "memory_key", "value", "source")
        VALUES ($1::uuid, $2::uuid, 'conversation', 'ai_status', $3::jsonb, 'user')
        ON CONFLICT ("workspace_id", "conversation_id", "memory_key")
        WHERE "scope" = 'conversation' AND "conversation_id" IS NOT NULL
        DO UPDATE SET "value" = EXCLUDED."value", "source" = 'user',
                      "updated_at" = CURRENT_TIMESTAMP, "last_observed_at" = CURRENT_TIMESTAMP
      `,
      workspaceId,
      conversationId,
      JSON.stringify(value),
    );
    aiAgentsDebug.log('api.service', 'setConversationAiStatus result', { workspaceId, conversationId, value });
  }

  private defaultPromptFor(agentType: string) {
    const base =
      'You are an Axodesk AI Agent for customer conversations. Be accurate, concise, grounded, and escalate whenever policy or confidence requires it.';
    if (agentType === 'sales') return `${base} Qualify leads using need, budget, authority, timeline, and next step.`;
    if (agentType === 'support') return `${base} Resolve support questions from knowledge and create handoff summaries for unresolved issues.`;
    if (agentType === 'receptionist') return `${base} Route customers, collect context, and book or escalate only when configured.`;
    return base;
  }

  private toAgentListDto(row: any) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description,
      agentType: row.agent_type,
      status: row.status,
      activeVersionId: row.active_version_id,
      activeVersion: row.active_version,
      activeTone: row.active_tone,
      activeLanguage: row.active_language,
      activeChannels: row.active_channels || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toAgentDto(row: any) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description,
      agentType: row.agent_type,
      status: row.status,
      activeVersionId: row.active_version_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }

  private toVersionDto(row: any) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      version: row.version,
      status: row.status,
      name: row.name,
      tone: row.tone,
      defaultLanguage: row.default_language,
      channelAllowlist: row.channel_allowlist || [],
      businessHours: row.business_hours || {},
      llmConfig: row.llm_config || {},
      runtimeConfig: row.runtime_config || {},
      guardrails: row.guardrails || {},
      toolsAllowed: row.tools_allowed || [],
      knowledgeSourceIds: row.knowledge_source_ids || [],
      systemPrompt: row.system_prompt,
      approvalMode: row.approval_mode,
      sandboxMode: row.sandbox_mode,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toRunDto(row: any) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      agentVersionId: row.agent_version_id,
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      triggerMessageId: row.trigger_message_id,
      status: row.status,
      mode: row.mode,
      channelType: row.channel_type,
      intent: row.intent,
      confidence: row.confidence,
      handoffRequired: row.handoff_required,
      decisionSnapshot: row.decision_snapshot,
      responseSnapshot: row.response_snapshot,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      latencyMs: row.latency_ms,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  }
}
