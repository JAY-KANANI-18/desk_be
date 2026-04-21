import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { workflowQueue } from 'src/queues/workflow.queue';
import { aiAgentsDebug } from '../ai-agents-debug.logger';

export interface AiToolExecutionContext {
  workspaceId: string;
  runId?: string;
  conversationId?: string;
  contactId?: string;
  allowedTools: string[];
  approvalMode?: 'off' | 'first_reply' | 'all_replies' | 'tools_only';
}

export interface AiToolDefinition {
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  requiresApprovalByDefault: boolean;
  execute: (ctx: AiToolExecutionContext, input: Record<string, any>) => Promise<Record<string, any>>;
}

@Injectable()
export class AiToolRegistryService {
  private readonly logger = new Logger(AiToolRegistryService.name);
  private readonly tools = new Map<string, AiToolDefinition>();

  constructor(private readonly prisma: PrismaService) {
    this.registerDefaults();
  }

  listTools() {
    const tools = [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      requiresApprovalByDefault: tool.requiresApprovalByDefault,
    }));
    aiAgentsDebug.log('tools', 'listTools result', { count: tools.length, tools });
    return tools;
  }

  getTool(name: string) {
    return this.tools.get(name);
  }

  async execute(ctx: AiToolExecutionContext, name: string, input: Record<string, any>) {
    aiAgentsDebug.log('tools', 'execute start', {
      ctx,
      toolName: name,
      input,
      registeredTools: [...this.tools.keys()],
    });
    const tool = this.tools.get(name);
    if (!tool) {
      aiAgentsDebug.warn('tools', 'execute rejected unknown tool', { ctx, toolName: name, input });
      throw new BadRequestException(`Unknown AI tool: ${name}`);
    }
    if (!ctx.allowedTools.includes(name)) {
      aiAgentsDebug.warn('tools', 'execute rejected tool not allowed', {
        ctx,
        toolName: name,
        allowedTools: ctx.allowedTools,
        input,
      });
      throw new ForbiddenException(`AI tool not allowed: ${name}`);
    }

    if (ctx.approvalMode === 'tools_only' || tool.requiresApprovalByDefault) {
      const result = {
        status: 'waiting_approval',
        toolName: name,
        output: { reason: 'tool_requires_human_approval' },
      };
      aiAgentsDebug.warn('tools', 'execute waiting for human approval', {
        ctx,
        toolName: name,
        risk: tool.risk,
        approvalMode: ctx.approvalMode,
        requiresApprovalByDefault: tool.requiresApprovalByDefault,
        result,
      });
      return result;
    }

    const started = Date.now();
    try {
      const output = await tool.execute(ctx, input || {});
      await this.logTool(ctx, name, tool.description, 'succeeded', input, output, null, Date.now() - started);
      aiAgentsDebug.log('tools', 'execute succeeded', {
        ctx,
        toolName: name,
        latencyMs: Date.now() - started,
        output,
      });
      return { status: 'succeeded', toolName: name, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logTool(ctx, name, tool.description, 'failed', input, null, message, Date.now() - started);
      aiAgentsDebug.error('tools', 'execute failed', error, {
        ctx,
        toolName: name,
        latencyMs: Date.now() - started,
        input,
      });
      throw error;
    }
  }

  private registerDefaults() {
    this.register({
      name: 'createLead',
      description: 'Mark the current contact as a qualified lead and persist qualification metadata.',
      risk: 'medium',
      requiresApprovalByDefault: false,
      execute: (ctx, input) => this.createLead(ctx, input),
    });

    this.register({
      name: 'assignConversation',
      description: 'Assign the conversation contact to a user or team.',
      risk: 'medium',
      requiresApprovalByDefault: false,
      execute: (ctx, input) => this.assignConversation(ctx, input),
    });

    this.register({
      name: 'updateContactField',
      description: 'Update safe CRM contact fields.',
      risk: 'medium',
      requiresApprovalByDefault: false,
      execute: (ctx, input) => this.updateContactField(ctx, input),
    });

    this.register({
      name: 'changeLifecycleStage',
      description: 'Move a contact to another lifecycle stage.',
      risk: 'medium',
      requiresApprovalByDefault: false,
      execute: (ctx, input) => this.changeLifecycleStage(ctx, input),
    });

    this.register({
      name: 'bookMeeting',
      description: 'Create a meeting booking through an external calendar adapter.',
      risk: 'high',
      requiresApprovalByDefault: true,
      execute: async () => ({ configured: false, message: 'Calendar adapter is not configured yet' }),
    });

    this.register({
      name: 'createTicket',
      description: 'Create an internal support ticket or external helpdesk ticket.',
      risk: 'medium',
      requiresApprovalByDefault: false,
      execute: (ctx, input) => this.createTicket(ctx, input),
    });

    this.register({
      name: 'closeConversation',
      description: 'Close the active conversation after resolution.',
      risk: 'medium',
      requiresApprovalByDefault: false,
      execute: (ctx, input) => this.closeConversation(ctx, input),
    });

    this.register({
      name: 'triggerWorkflow',
      description: 'Start a published Axodesk workflow with AI-provided variables.',
      risk: 'medium',
      requiresApprovalByDefault: false,
      execute: (ctx, input) => this.triggerWorkflow(ctx, input),
    });

    this.register({
      name: 'sendTemplate',
      description: 'Send an approved message template.',
      risk: 'high',
      requiresApprovalByDefault: true,
      execute: async () => ({ configured: false, message: 'Template send is routed through the existing outbound module' }),
    });

    this.register({
      name: 'escalateHuman',
      description: 'Escalate the conversation to a human agent.',
      risk: 'low',
      requiresApprovalByDefault: false,
      execute: (ctx, input) => this.escalateHuman(ctx, input),
    });
  }

  private register(tool: AiToolDefinition) {
    this.tools.set(tool.name, tool);
    aiAgentsDebug.log('tools.registry', 'tool registered', {
      name: tool.name,
      risk: tool.risk,
      requiresApprovalByDefault: tool.requiresApprovalByDefault,
    });
  }

  private async createLead(ctx: AiToolExecutionContext, input: Record<string, any>) {
    const contactId = this.requireContactId(ctx, input);
    aiAgentsDebug.log('tools.createLead', 'start', { ctx, input, contactId });
    await this.prisma.contact.updateMany({
      where: { id: contactId, workspaceId: ctx.workspaceId },
      data: {
        status: input.status || 'lead',
        ...(input.lifecycleId ? { lifecycleId: input.lifecycleId } : {}),
      },
    });

    await this.upsertMemory(ctx.workspaceId, contactId, 'lead_qualification', {
      budget: input.budget,
      need: input.need,
      timeline: input.timeline,
      temperature: input.temperature || 'warm',
      source: 'ai_agent',
    });

    const result = { contactId, status: input.status || 'lead' };
    aiAgentsDebug.log('tools.createLead', 'result', { ctx, result });
    return result;
  }

  private async assignConversation(ctx: AiToolExecutionContext, input: Record<string, any>) {
    const contactId = this.requireContactId(ctx, input);
    const assigneeId = input.assigneeId || null;
    const teamId = input.teamId || null;
    aiAgentsDebug.log('tools.assignConversation', 'start', { ctx, input, contactId, assigneeId, teamId });

    if (assigneeId) {
      const member = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId: ctx.workspaceId, userId: assigneeId, status: 'active' },
      });
      if (!member) throw new BadRequestException('Assignee is not an active workspace member');
    }

    if (teamId) {
      const team = await this.prisma.team.findFirst({ where: { id: teamId, workspaceId: ctx.workspaceId } });
      if (!team) throw new BadRequestException('Team does not exist in this workspace');
    }

    const updated = await this.prisma.contact.updateMany({
      where: { id: contactId, workspaceId: ctx.workspaceId },
      data: { assigneeId, teamId },
    });

    if (ctx.conversationId) {
      await this.recordConversationActivity(ctx, 'ai_assigned_conversation', { assigneeId, teamId });
    }

    const result = { updated: updated.count, contactId, assigneeId, teamId };
    aiAgentsDebug.log('tools.assignConversation', 'result', { ctx, result });
    return result;
  }

  private async updateContactField(ctx: AiToolExecutionContext, input: Record<string, any>) {
    const contactId = this.requireContactId(ctx, input);
    const allowed = new Set(['firstName', 'lastName', 'email', 'phone', 'company', 'status']);
    const field = String(input.field || '');
    if (!allowed.has(field)) throw new ForbiddenException(`AI cannot update contact field: ${field}`);
    aiAgentsDebug.log('tools.updateContactField', 'start', { ctx, input, contactId, field });

    const updated = await this.prisma.contact.updateMany({
      where: { id: contactId, workspaceId: ctx.workspaceId },
      data: { [field]: input.value },
    });

    const result = { updated: updated.count, contactId, field };
    aiAgentsDebug.log('tools.updateContactField', 'result', { ctx, result });
    return result;
  }

  private async changeLifecycleStage(ctx: AiToolExecutionContext, input: Record<string, any>) {
    const contactId = this.requireContactId(ctx, input);
    const lifecycleId = input.lifecycleId;
    if (!lifecycleId) throw new BadRequestException('lifecycleId is required');
    aiAgentsDebug.log('tools.changeLifecycleStage', 'start', { ctx, input, contactId, lifecycleId });

    const stage = await this.prisma.lifecycleStage.findFirst({
      where: { id: lifecycleId, workspaceId: ctx.workspaceId },
    });
    if (!stage) throw new BadRequestException('Lifecycle stage does not exist in this workspace');

    await this.prisma.contact.updateMany({
      where: { id: contactId, workspaceId: ctx.workspaceId },
      data: { lifecycleId },
    });

    const result = { contactId, lifecycleId, stageName: stage.name };
    aiAgentsDebug.log('tools.changeLifecycleStage', 'result', { ctx, result });
    return result;
  }

  private async createTicket(ctx: AiToolExecutionContext, input: Record<string, any>) {
    if (!ctx.conversationId) throw new BadRequestException('conversationId is required');
    aiAgentsDebug.log('tools.createTicket', 'start', { ctx, input });
    await this.recordConversationActivity(ctx, 'ai_ticket_created', {
      title: input.title || 'AI-created support ticket',
      priority: input.priority || 'normal',
      category: input.category || null,
    });
    const result = { conversationId: ctx.conversationId, title: input.title || 'AI-created support ticket' };
    aiAgentsDebug.log('tools.createTicket', 'result', { ctx, result });
    return result;
  }

  private async closeConversation(ctx: AiToolExecutionContext, input: Record<string, any>) {
    if (!ctx.conversationId) throw new BadRequestException('conversationId is required');
    aiAgentsDebug.log('tools.closeConversation', 'start', { ctx, input });
    await this.prisma.conversation.updateMany({
      where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
      data: { status: 'closed', resolvedAt: new Date() },
    });
    await this.recordConversationActivity(ctx, 'ai_closed_conversation', { reason: input.reason || 'resolved_by_ai' });
    const result = { conversationId: ctx.conversationId, status: 'closed' };
    aiAgentsDebug.log('tools.closeConversation', 'result', { ctx, result });
    return result;
  }

  private async triggerWorkflow(ctx: AiToolExecutionContext, input: Record<string, any>) {
    const workflowId = input.workflowId;
    if (!workflowId) throw new BadRequestException('workflowId is required');
    aiAgentsDebug.log('tools.triggerWorkflow', 'start', { ctx, input, workflowId });

    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, workspaceId: ctx.workspaceId, status: 'published' },
    });
    if (!workflow) throw new BadRequestException('Published workflow does not exist in this workspace');

    const job = await workflowQueue.add(
      'workflow.trigger',
      {
        type: 'TRIGGER',
        workspaceId: ctx.workspaceId,
        workflowId,
        contactId: this.requireContactId(ctx, input),
        conversationId: ctx.conversationId,
        triggerData: {
          source: 'ai_agent',
          runId: ctx.runId,
          variables: input.variables || {},
        },
      },
      { jobId: `${ctx.workspaceId}:${workflowId}:${ctx.runId || Date.now()}` },
    );
    aiAgentsDebug.log('tools.triggerWorkflow', 'workflow job queued', {
      ctx,
      workflowId,
      jobId: job.id,
      jobName: job.name,
      queue: job.queueName,
      jobData: job.data,
    });

    const result = { workflowId, queued: true };
    aiAgentsDebug.log('tools.triggerWorkflow', 'result', { ctx, result });
    return result;
  }

  private async escalateHuman(ctx: AiToolExecutionContext, input: Record<string, any>) {
    if (!ctx.conversationId) throw new BadRequestException('conversationId is required');
    aiAgentsDebug.log('tools.escalateHuman', 'start', { ctx, input });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        INSERT INTO "ai_escalations"
          ("workspace_id", "run_id", "conversation_id", "contact_id", "reason", "sentiment", "summary", "assigned_team_id")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid)
        RETURNING "id"
      `,
      ctx.workspaceId,
      ctx.runId || null,
      ctx.conversationId,
      ctx.contactId || input.contactId || null,
      input.reason || 'ai_tool_escalation',
      input.sentiment || null,
      input.summary || null,
      input.teamId || null,
    );

    await this.recordConversationActivity(ctx, 'ai_escalated_human', {
      escalationId: rows[0]?.id,
      reason: input.reason || 'ai_tool_escalation',
    });

    const result = { escalationId: rows[0]?.id, status: 'open' };
    aiAgentsDebug.log('tools.escalateHuman', 'result', { ctx, result });
    return result;
  }

  private async upsertMemory(workspaceId: string, contactId: string, key: string, value: Record<string, any>) {
    aiAgentsDebug.log('tools.memory', 'upsert start', { workspaceId, contactId, key, value });
    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO "ai_memories" ("workspace_id", "contact_id", "scope", "memory_key", "value")
        VALUES ($1::uuid, $2::uuid, 'contact', $3, $4::jsonb)
        ON CONFLICT ("workspace_id", "contact_id", "memory_key")
        WHERE "scope" = 'contact' AND "contact_id" IS NOT NULL
        DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = CURRENT_TIMESTAMP, "last_observed_at" = CURRENT_TIMESTAMP
      `,
      workspaceId,
      contactId,
      key,
      JSON.stringify(value),
    );
    aiAgentsDebug.log('tools.memory', 'upsert result', { workspaceId, contactId, key });
  }

  private async recordConversationActivity(ctx: AiToolExecutionContext, eventType: string, metadata: Record<string, any>) {
    if (!ctx.conversationId) return;
    aiAgentsDebug.log('tools.activity', 'record start', { ctx, eventType, metadata });
    await this.prisma.conversationActivity.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        eventType,
        actorType: 'automation',
        metadata: {
          ...metadata,
          runId: ctx.runId,
        },
      },
    });
    aiAgentsDebug.log('tools.activity', 'record result', {
      ctx,
      eventType,
    });
  }

  private async logTool(
    ctx: AiToolExecutionContext,
    toolName: string,
    operation: string,
    status: 'succeeded' | 'failed' | 'denied' | 'skipped',
    input: Record<string, any>,
    output: Record<string, any> | null,
    errorMessage: string | null,
    latencyMs: number,
  ) {
    try {
      aiAgentsDebug.log('tools.log', 'persist start', {
        ctx,
        toolName,
        operation,
        status,
        input,
        output,
        errorMessage,
        latencyMs,
      });
      await this.prisma.$executeRawUnsafe(
        `
          INSERT INTO "ai_tool_logs"
            ("workspace_id", "run_id", "tool_name", "operation", "status", "input", "output", "error_message", "latency_ms")
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
        `,
        ctx.workspaceId,
        ctx.runId || null,
        toolName,
        operation,
        status,
        JSON.stringify(input || {}),
        output ? JSON.stringify(output) : null,
        errorMessage,
        latencyMs,
      );
      aiAgentsDebug.log('tools.log', 'persist result', {
        ctx,
        toolName,
        status,
        latencyMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aiAgentsDebug.error('tools.log', 'persist failed', error, {
        ctx,
        toolName,
        status,
      });
      this.logger.warn(`Failed to write AI tool log: ${message}`);
    }
  }

  private requireContactId(ctx: AiToolExecutionContext, input: Record<string, any>) {
    const contactId = ctx.contactId || input.contactId;
    if (!contactId) throw new BadRequestException('contactId is required');
    return contactId;
  }
}
