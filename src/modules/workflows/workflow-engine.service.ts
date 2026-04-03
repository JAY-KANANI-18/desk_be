// src/modules/workflows/workflow-engine.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { workflowQueue, WorkflowJob } from '../../queues/workflow.queue';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkflowRunContext } from './workflow-run.context';
import { log } from 'console';
import { OutboundService } from '../outbound/outbound.service';

const RUN_CTX_TTL = 60 * 60 * 24;
const ACTIVE_RUN_KEY = (workspaceId: string, contactId: string) =>
  `wf:active:${workspaceId}:${contactId}`;
const RUN_CTX_KEY = (runId: string) => `wf:ctx:${runId}`;

@Injectable()
export class WorkflowEngineService {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) { }

  // ── Event listeners ──────────────────────────────────────────────────────

  @OnEvent('contact.tag_updated')
  async onContactTagUpdated(event: {
    workspaceId: string;
    contactId: string;
    action: 'added' | 'removed';
    tagId: string;
    tags: string[];
  }) {
    await this.trigger({
      workspaceId: event.workspaceId,
      eventType: 'contact_tag_updated',
      contactId: event.contactId,
      triggerData: { action: event.action, tagId: event.tagId, tags: event.tags },
    });
  }

  @OnEvent('contact.lifecycle_updated')
  async onContactLifecycleUpdated(event: {
    workspaceId: string;
    contactId: string;
    lifecycleId: string;
  }) {
    await this.trigger({
      workspaceId: event.workspaceId,
      eventType: 'lifecycle_updated',
      contactId: event.contactId,
      triggerData: { lifecycleId: event.lifecycleId },
    });
  }

  @OnEvent('contact.field_updated')
  async onContactFieldUpdated(event: {
    workspaceId: string;
    contactId: string;
    fields: Record<string, any>;
  }) {
    await this.trigger({
      workspaceId: event.workspaceId,
      eventType: 'contact_field_updated',
      contactId: event.contactId,
      triggerData: { fields: event.fields },
    });
  }

  @OnEvent('contact.assigned')
  async onContactAssigned(event: {
    workspaceId: string;
    contactId: string;
    assigneeId: string | null;
    teamId: string | null;
  }) {
    await this.trigger({
      workspaceId: event.workspaceId,
      eventType: 'contact_assigned',
      contactId: event.contactId,
      triggerData: { assigneeId: event.assigneeId, teamId: event.teamId },
    });
  }

  @OnEvent('conversation.opened')
  async onConversationOpened(event: {
    workspaceId: string;
    contactId: string;
    conversationId: string;
    source: string;
    channel: string;
  }) {
    await this.trigger({
      workspaceId: event.workspaceId,
      eventType: 'conversation_opened',
      contactId: event.contactId,
      conversationId: event.conversationId,
      triggerData: { source: event.source, channel: event.channel },
    });
  }

  @OnEvent('conversation.closed')
  async onConversationClosed(event: {
    workspaceId: string;
    contactId: string;
    conversationId: string;
    source: string;
    channel: string;
  }) {
    await this.trigger({
      workspaceId: event.workspaceId,
      eventType: 'conversation_closed',
      contactId: event.contactId,
      conversationId: event.conversationId,
      triggerData: { source: event.source, channel: event.channel },
    });
  }

  @OnEvent('message.inbound')
  async onInboundMessage(event: {
    workspaceId: string;
    conversationId: string;
    message: any;
  }) {
    if (event.message.direction !== 'incoming') return;

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: event.conversationId },
    });
    if (!conversation) return;

    const activeRunData = await this.redis.getJSON(
      ACTIVE_RUN_KEY(event.workspaceId, conversation.contactId),
    );
    if (!activeRunData) return;

    const run = await this.prisma.workflowRun.findUnique({
      where: { id: activeRunData.runId },
    });
    if (!run || run.status !== 'waiting') return;

    const workflow = await this.prisma.workflow.findUnique({
      where: { id: run.workflowId },
    });
    if (!workflow) return;

    const config = workflow.config as any;
    const currentStep = (config.steps ?? []).find(
      (s: any) => s.id === run.currentStepId,
    );
    if (!currentStep || currentStep.type !== 'ask_question') return;

    await workflowQueue.add('resume', {
      type: 'RESUME',
      runId: run.id,
      resumeData: {
        lastAnswer: event.message.text ?? '',
        lastAnswerMessageId: event.message.id,
      },
    });
  }

  // ── Trigger entry point ──────────────────────────────────────────────────

  async trigger(opts: {
    workspaceId: string;
    eventType: string;
    contactId: string;
    conversationId?: string;
    triggerData: Record<string, any>;
  }) {
    const { workspaceId, eventType, contactId, conversationId, triggerData } = opts;
    this.logger.debug(`Triggering workflows for event ${eventType} contact=${contactId} conversation=${conversationId}`, { triggerData });
    const workflows = await this.prisma.workflow.findMany({
      where: { workspaceId, status: 'published' },
    });
    this.logger.debug(`Triggering workflows for event ${eventType} contact=${contactId} conversation=${conversationId}`, { workflowCount: workflows.length, triggerData });

    for (const workflow of workflows) {
      this.logger.debug(`Evaluating workflow ${workflow.name} for trigger event ${eventType}`, { workflowId: workflow.id, config: workflow.config });
      const config = workflow.config as any;
      if (!config?.trigger || config.trigger.type !== eventType) continue;

      try {
        await this.evaluateAndEnqueue(workflow, contactId, conversationId, triggerData);
      } catch (err) {
        this.logger.error(`Trigger eval failed wf=${workflow.id} contact=${contactId}`, err);
      }
    }
  }

  // ── Evaluate + dedup ─────────────────────────────────────────────────────

  private async evaluateAndEnqueue(
    workflow: any,
    contactId: string,
    conversationId: string | undefined,
    triggerData: Record<string, any>,
  ) {
    const config = workflow.config as any;
    const workspaceId = workflow.workspaceId;
    const settings = config.trigger?.advancedSettings ?? {};

    // 1. Block if contact already has active run on this workflow
    const activeRunData = await this.redis.getJSON(ACTIVE_RUN_KEY(workspaceId, contactId));
    if (activeRunData?.workflowId === workflow.id) {
      this.logger.debug(`Skipping — active run exists contact=${contactId} wf=${workflow.id}`);
      return;
    }

    // 2. triggerOncePerContact
    if (settings.triggerOncePerContact) {
      const prev = await this.prisma.workflowRun.findFirst({
        where: {
          workflowId: workflow.id,
          contactId,
          status: { in: ['completed', 'running', 'waiting'] },
        },
      });
      if (prev) return;
    }

    // 3. Cooldown
    if (settings.cooldownHours) {
      const recent = await this.prisma.workflowRun.findFirst({
        where: {
          workflowId: workflow.id,
          contactId,
          startedAt: {
            gte: new Date(Date.now() - settings.cooldownHours * 3_600_000),
          },
        },
      });
      if (recent) return;
    }

    // 4. Evaluate trigger conditions
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      include: { tags: { select: { tagId: true } } },
    });
    if (!contact) return;

    const contactData = { ...contact, tags: contact.tags.map((t) => t.tagId) };

    const conditionsMet = this.evaluateConditions(
      config.trigger.conditions ?? [],
      contactData,
      triggerData,
    );
    this.logger.debug(`Evaluated trigger conditions for workflow ${workflow.name} contact=${contactId}: met=${conditionsMet}`, { conditions: config.trigger.conditions, contactData, triggerData });
    if (!conditionsMet) return;

    // 5. Extra validation per trigger type
    if (!this.validateTriggerData(config.trigger, triggerData)) return;

    // 6. Enqueue
    await workflowQueue.add(
      'trigger',
      {
        type: 'TRIGGER',
        workspaceId,
        workflowId: workflow.id,
        contactId,
        conversationId,
        triggerData,
      } satisfies WorkflowJob,
      { jobId: `trigger-${workflow.id}-${contactId}-${Date.now()}` },
    );

    this.logger.log(`Enqueued wf=${workflow.id} contact=${contactId} event=${config.trigger.type}`);
  }

  // ── Trigger-type specific data validation ────────────────────────────────

  private validateTriggerData(trigger: any, triggerData: Record<string, any>): boolean {
    const data = trigger.data ?? {};
    this.logger.debug(`Validating trigger data for trigger type=${trigger.type}`, { triggerData, configData: data });

    switch (trigger.type) {
      case 'conversation_opened': {
        // If sources filter set, check source matches
        if (data.sources?.length > 0) {
          return data.sources.includes(triggerData.source);
        }
        return true;
      }

      case 'conversation_closed': {
        let ok = true;
        if (data.sources?.length > 0) {
          ok = ok && data.sources.includes(triggerData.source);
        }
        if (data.categories?.length > 0) {
          ok = ok && data.categories.includes(triggerData.category);
        }
        return ok;
      }

      case 'contact_tag_updated': {
        // If specific tags configured, check tag matches
        if (data.tags?.length > 0) {
          if (!data.tags.includes(triggerData.tagId)) return false;
        }
        // If action configured, check action matches
        if (data.action && data.action !== triggerData.action) return false;
        return true;
      }

      case 'contact_field_updated': {
        // If specific field configured, check field matches
        if (data.fieldId && !Object.keys(triggerData.fields ?? {}).includes(data.fieldId)) {
          return false;
        }
        return true;
      }

      case 'lifecycle_updated': {
        if (data.stageSelection === 'specific' && data.stages?.length > 0) {
          const stageMatch = data.stages.includes(triggerData.lifecycleId);
          // Handle triggerWhenCleared — allow if lifecycleId is null
          if (data.triggerWhenCleared && triggerData.lifecycleId === null) return true;
          return stageMatch;
        }
        return true;
      }

      case 'manual_trigger':
        return true;

      default:
        return true;
    }
  }

  // ── Start run ────────────────────────────────────────────────────────────

  async startRun(job: {
    workspaceId: string;
    workflowId: string;
    contactId: string;
    conversationId?: string;
    triggerData: Record<string, any>;
  }) {
    const { workspaceId, workflowId, contactId, conversationId, triggerData } = job;

    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow || workflow.status !== 'published') return;

    const config = workflow.config as any;
    const contact = await this.loadContactData(contactId);
    this.logger.debug(`Starting workflow run wf=${workflow.name} contact=${contact.firstName} ${contact.lastName} conversation=${conversationId}`, { triggerData });

    const run = await this.prisma.workflowRun.create({
      data: { workspaceId, workflowId, contactId, status: 'running', triggerData },
    });

    const ctx: WorkflowRunContext = {
      runId: run.id,
      workflowId,
      workspaceId,
      contactId,
      conversationId,
      contact,
      trigger: triggerData,
      steps: {},
      vars: {},
    };

    await this.saveContext(ctx);

    await this.redis.client.setex(
      ACTIVE_RUN_KEY(workspaceId, contactId),
      RUN_CTX_TTL,
      JSON.stringify({ runId: run.id, workflowId }),
    );

    // First step: parentId === 'trigger'
    const firstStep = (config.steps ?? []).find((s: any) => s.parentId === 'trigger');
    if (!firstStep) {
      await this.completeRun(run.id, ctx);
      return;
    }

    await this.enqueueStep(run.id, firstStep.id);
  }

  // ── Execute step ─────────────────────────────────────────────────────────

  async executeStep(runId: string, stepId: string) {
    this.logger.debug(`Executing step ${stepId} for run ${runId}`);
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run || !['running', 'waiting'].includes(run.status)) return;

    const ctx = await this.loadContext(runId);
    if (!ctx) {
      this.logger.error(`No context for run=${runId}`);
      return;
    }

    const workflow = await this.prisma.workflow.findUnique({ where: { id: run.workflowId } });
    this.logger.debug(`Loaded workflow ${workflow?.name} for run ${runId}`, { workflow });
    if (!workflow) return;

    const config = workflow.config as any;
    const steps: any[] = config.steps ?? [];
    const step = steps.find((s) => s.id === stepId);

    if (!step) {
      this.logger.warn(`Step ${stepId} not found, completing run`);
      await this.completeRun(runId, ctx);
      return;
    }

    const stepRun = await this.prisma.workflowRunStep.create({
      data: {
        runId,
        stepId,
        stepType: step.type,
        status: 'running',
        startedAt: new Date(),
        input: step.data ?? {},
      },
    });

    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { currentStepId: stepId },
    });

    try {
      this.logger.debug(`Running handler for step type=${step.type} id=${step.id} run=${runId}`);
      const result: any = await this.runStepHandler(step, ctx, config);

      await this.prisma.workflowRunStep.update({
        where: { id: stepRun.id },
        data: {
          status: 'completed',
          output: result.output ?? {},
          completedAt: new Date(),
          attempts: { increment: 1 },
        },
      });

      ctx.steps[stepId] = { output: result.output, status: 'completed' };
      await this.saveContext(ctx);

      if (result.suspend) {
        await this.prisma.workflowRun.update({
          where: { id: runId },
          data: { status: 'waiting' },
        });
        return;
      }

      const nextStepId =
        result.nextStepId ??
        this.findNextStep(stepId, steps, result.branchConnectorId);

      if (!nextStepId) {
        await this.completeRun(runId, ctx);
        return;
      }

      await this.enqueueStep(runId, nextStepId);
    } catch (err: any) {
      await this.handleStepError(stepRun.id, runId, step, ctx, steps, err);
    }
  }

  // ── Resume run ───────────────────────────────────────────────────────────

  async resumeRun(runId: string, resumeData: Record<string, any>) {
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== 'waiting') return;

    const ctx = await this.loadContext(runId);
    if (!ctx) return;

    ctx.vars = { ...ctx.vars, ...resumeData };
    await this.saveContext(ctx);

    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { status: 'running' },
    });

    if (run.currentStepId) {
      await this.enqueueStep(runId, run.currentStepId);
    }
  }

  // ── Step router ──────────────────────────────────────────────────────────

  private async runStepHandler(step: any, ctx: WorkflowRunContext, config: any) {
    this.logger.debug(`Executing step type=${step.type} id=${step.id} run=${ctx.runId}`);

    switch (step.type) {
      case 'send_message': return this.handleSendMessage(step, ctx);
      case 'ask_question': return this.handleAskQuestion(step, ctx, config);
      case 'assign_to': return this.handleAssignTo(step, ctx);
      case 'update_contact_tag': return this.handleUpdateContactTag(step, ctx);
      case 'update_contact_field': return this.handleUpdateContactField(step, ctx);
      case 'branch': return this.handleBranch(step, ctx, config);
      case 'wait': return this.handleWait(step, ctx);
      case 'http_request': return this.handleHttpRequest(step, ctx);
      case 'jump_to': return this.handleJumpTo(step, ctx);
      case 'open_conversation': return this.handleOpenConversation(step, ctx);
      case 'close_conversation': return this.handleCloseConversation(step, ctx);
      case 'add_comment': return this.handleAddComment(step, ctx);
      case 'date_time': return this.handleDateTime(step, ctx, config);
      case 'trigger_another_workflow': return this.handleTriggerAnotherWorkflow(step, ctx);
      case 'branch_connector': return this.handleBranchConnector(step, ctx, config);
      default:
        this.logger.warn(`No handler for step type: ${step.type}`);
        return { output: {} };
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  // send_message
  private async handleSendMessage(step: any, ctx: WorkflowRunContext) {
  const { defaultMessage, attachments = [] } = step.data;

  // Require either text or attachments
  if (!defaultMessage?.text && attachments.length === 0) {
    return { output: { skipped: true, reason: 'no message content' } };
  }

  const conversation = await this.prisma.conversation.findFirst({
    where: { contactId: ctx.contactId },
    include: { lastMessage: true },
  });
  if (!conversation) return { output: { skipped: true, reason: 'no open conversation' } };

  const text = this.interpolate(defaultMessage?.text ?? '', ctx);

  // Resolve channelId
  let channelId = step.data.channel === 'last_interacted'
    ? conversation.lastMessage?.channelId ?? null
    : step.data.channel;

  if (!channelId) {
    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: { contactId: ctx.contactId },
      orderBy: { createdAt: 'desc' },
    });
    channelId = contactChannel?.channelId ?? null;
  }

  if (!channelId) {
    return { output: { skipped: true, reason: 'no channel resolved' } };
  }

  await this.redis.client.publish(
    'outbound.send',
    JSON.stringify({
      workspaceId:    ctx.workspaceId,
      conversationId: conversation.id,
      channelId,
      text:           text || undefined,
      authorId:       null,
      // Pass attachments directly — already uploaded to R2, just URLs
      attachments: attachments.map((att: any) => ({
        url:      att.url,
        type:     att.type,
        filename: att.filename,
        mimeType: att.mimeType,
        size:     att.size,
      })),
      metadata: {},
    }),
  );

  return { output: { sent: true, text, attachments: attachments.length } };
}


  // ask_question
 private async handleAskQuestion(step: any, ctx: WorkflowRunContext, config: any) {
  const lastAnswer = ctx.vars?.lastAnswer;
  const steps: any[] = config.steps ?? [];

  const findConnector = (name: string) =>
    steps.find(
      (s) => s.parentId === step.id &&
             s.type === 'branch_connector' &&
             s.name === name,
    );

  if (lastAnswer === undefined) {
    await this.handleSendMessage(
      { data: { channel: 'last_interacted', defaultMessage: { text: step.data.questionText } } },
      ctx,
    );
    return { output: { waiting: true }, suspend: true };
  }

  const validation = this.validateAnswer(lastAnswer, step.data.questionType, step.data);

  if (!validation.valid) {
    this.logger.debug(
      `ask_question validation failed answer="${lastAnswer}" reason="${validation.reason}"`,
    );

    // Clear answer from context
    delete ctx.vars.lastAnswer;
    delete ctx.vars.lastAnswerMessageId;

    // ── MUST save context here so jump_to re-entry sees clean state ──────
    await this.saveContext(ctx);

    const failureConnector = findConnector('Failure');
    return {
      output: { answer: lastAnswer, valid: false, reason: validation.reason },
      branchConnectorId: failureConnector?.id ?? null,
    };
  }

  // Valid answer
  const output: Record<string, any> = { answer: lastAnswer, valid: true };

  if (step.data.saveAsVariable && step.data.variableName) {
    ctx.vars[step.data.variableName] = lastAnswer;
  }

  if (step.data.saveAsContactField && step.data.contactFieldId) {
    await this.prisma.contact.update({
      where: { id: ctx.contactId },
      data: { [step.data.contactFieldId]: lastAnswer },
    });
    ctx.contact[step.data.contactFieldId] = lastAnswer;
  }

  if (step.data.saveAsTag && step.data.questionType === 'multiple_choice') {
    const tag = await this.prisma.tag.findFirst({
      where: { workspaceId: ctx.workspaceId, name: lastAnswer },
    });
    if (tag) {
      await this.prisma.contactTag.upsert({
        where: { contactId_tagId: { contactId: ctx.contactId, tagId: tag.id } },
        create: { contactId: ctx.contactId, tagId: tag.id },
        update: {},
      });
    }
  }

  delete ctx.vars.lastAnswer;
  delete ctx.vars.lastAnswerMessageId;

  // ── Save context after valid answer too ───────────────────────────────
  await this.saveContext(ctx);

  const successConnector = findConnector('Success');
  return {
    output,
    branchConnectorId: successConnector?.id ?? null,
  };
}

  // ── Answer validator ──────────────────────────────────────────────────────

  private validateAnswer(
    answer: string,
    questionType: string,
    stepData: any,
  ): { valid: boolean; reason?: string } {
    if (!answer || answer.trim() === '') {
      return { valid: false, reason: 'empty answer' };
    }

    const val = answer.trim();

    switch (questionType) {
      case 'text':
        // Text always valid as long as not empty
        return { valid: true };

      case 'number': {
        const num = parseFloat(val);
        if (isNaN(num)) {
          return { valid: false, reason: 'not a valid number' };
        }
        if (stepData.numberMin !== undefined && num < stepData.numberMin) {
          return { valid: false, reason: `number must be at least ${stepData.numberMin}` };
        }
        if (stepData.numberMax !== undefined && num > stepData.numberMax) {
          return { valid: false, reason: `number must be at most ${stepData.numberMax}` };
        }
        return { valid: true };
      }

      case 'email': {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(val)) {
          return { valid: false, reason: 'not a valid email address' };
        }
        return { valid: true };
      }

      case 'phone': {
        // Allow +, digits, spaces, dashes, parentheses
        const phoneRegex = /^\+?[\d\s\-().]{7,20}$/;
        if (!phoneRegex.test(val)) {
          return { valid: false, reason: 'not a valid phone number' };
        }
        return { valid: true };
      }

      case 'url': {
        try {
          new URL(val.startsWith('http') ? val : `https://${val}`);
          return { valid: true };
        } catch {
          return { valid: false, reason: 'not a valid URL' };
        }
      }

      case 'date': {
        const date = new Date(val);
        if (isNaN(date.getTime())) {
          return { valid: false, reason: 'not a valid date' };
        }
        return { valid: true };
      }

      case 'rating': {
        const rating = parseInt(val);
        if (isNaN(rating) || rating < 1 || rating > 5) {
          return { valid: false, reason: 'rating must be between 1 and 5' };
        }
        return { valid: true };
      }

      case 'multiple_choice': {
        const options: { id: string; label: string }[] = stepData.multipleChoiceOptions ?? [];
        if (!options.length) return { valid: true };

        const match = options.find(
          (o) => o.label.toLowerCase() === val.toLowerCase(),
        );
        if (!match) {
          return {
            valid: false,
            reason: `answer must be one of: ${options.map((o) => o.label).join(', ')}`,
          };
        }
        return { valid: true };
      }

      case 'location': {
        // Expect "lat,lng" format or a place name — just check not empty
        // Real validation depends on your channel (WhatsApp sends structured location)
        return { valid: true };
      }

      default:
        return { valid: true };
    }
  }

  // assign_to
  private async handleAssignTo(step: any, ctx: WorkflowRunContext) {
    const { action, userId, teamId, assignmentLogic, onlyOnlineUsers } = step.data;
    this.logger.debug(`Handling assign_to action=${action} userId=${userId} teamId=${teamId} logic=${assignmentLogic} onlyOnline=${onlyOnlineUsers}`, { ctx });
    const conversation = await this.prisma.conversation.findFirst({
      where: { contactId: ctx.contactId },
    });
    console.log({ conversation });

    this.logger.debug(`Found conversation for contact ${conversation.contactId !== ctx.contactId}: ${conversation?.id}`);
    // if (!conversation) return { output: { skipped: true, reason: 'no open conversation' } };

    let assigneeId: string | null = null;
    let assignedTeamId: string | null = null;

    switch (action) {
      case 'specific_user': {
        assigneeId = userId ?? null;
        break;
      }

      case 'user_in_team': {
        assignedTeamId = teamId ?? null;
        const members = await this.getEligibleAgents(
          ctx.workspaceId, teamId, onlyOnlineUsers,
        );
        assigneeId = await this.pickAgent(members, ctx.workspaceId, assignmentLogic);
        break;
      }

      case 'user_in_workspace': {
        const members = await this.getEligibleAgents(
          ctx.workspaceId, null, onlyOnlineUsers,
        );
        assigneeId = await this.pickAgent(members, ctx.workspaceId, assignmentLogic);
        break;
      }

      case 'unassign': {
        assigneeId = null;
        assignedTeamId = null;
        break;
      }
    }

    // Update contact assignment
    let updatedContact = await this.prisma.contact.update({
      where: { id: ctx.contactId },
      data: {
        assigneeId,
        teamId: assignedTeamId,
      },
    });
    console.log({ updatedContact });


    // Log activity
    let conversationActivity = await this.prisma.conversationActivity.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: conversation.id!,
        eventType: action === 'unassign' ? 'unassigned' : 'assigned',
        actorType: 'automation',
        subjectUserId: assigneeId,
        subjectTeamId: assignedTeamId,
      },
    });
    console.log({ conversationActivity });


    return { output: { assigned: true, assigneeId, teamId: assignedTeamId, action } };
  }

  private async getEligibleAgents(
    workspaceId: string,
    teamId: string | null,
    onlyOnline: boolean,
  ): Promise<string[]> {
    const where: any = {
      workspaceId,
      role: 'agent',
      status: 'active',
    };

    if (onlyOnline) where.availability = 'online';

    if (teamId) {
      const teamMembers = await this.prisma.teamMember.findMany({
        where: { teamId },
        select: { userId: true },
      });
      where.userId = { in: teamMembers.map((m) => m.userId) };
    }

    const members = await this.prisma.workspaceMember.findMany({
      where,
      select: { userId: true },
    });

    return members.map((m) => m.userId);
  }

  private async pickAgent(
    agentIds: string[],
    workspaceId: string,
    logic: string,
  ): Promise<string | null> {
    if (!agentIds.length) return null;
    if (logic === 'round_robin') {
      // Simple round-robin via Redis counter
      const key = `wf:rr:${workspaceId}`;
      const idx = await this.redis.client.incr(key);
      return agentIds[idx % agentIds.length];
    }

    // least_open_contacts
    const workloads = await Promise.all(
      agentIds.map(async (id) => ({
        id,
        count: await this.prisma.contact.count({
          where: { workspaceId, assigneeId: id },
        }),
      })),
    );
    workloads.sort((a, b) => a.count - b.count);
    return workloads[0]?.id ?? null;
  }

  // update_contact_tag
  private async handleUpdateContactTag(step: any, ctx: WorkflowRunContext) {
    const { action, tags } = step.data; // tags: string[] of tag IDs

    if (!tags?.length) return { output: { skipped: true, reason: 'no tags configured' } };

    if (action === 'add') {
      await this.prisma.contactTag.createMany({
        data: tags.map((tagId: string) => ({ contactId: ctx.contactId, tagId })),
        skipDuplicates: true,
      });
    } else {
      await this.prisma.contactTag.deleteMany({
        where: { contactId: ctx.contactId, tagId: { in: tags } },
      });
    }

    // Refresh tags in context
    const updated = await this.prisma.contactTag.findMany({
      where: { contactId: ctx.contactId },
      select: { tagId: true },
    });
    ctx.contact.tags = updated.map((t) => t.tagId);

    return { output: { action, tags } };
  }

  // update_contact_field
  private async handleUpdateContactField(step: any, ctx: WorkflowRunContext) {
    const { fieldId, value } = step.data;
    if (!fieldId) return { output: { skipped: true, reason: 'no fieldId' } };

    const interpolated = this.interpolate(String(value ?? ''), ctx);

    await this.prisma.contact.update({
      where: { id: ctx.contactId },
      data: { [fieldId]: interpolated },
    });

    ctx.contact[fieldId] = interpolated;

    return { output: { fieldId, value: interpolated } };
  }

  // branch — evaluates BranchCondition[] per connector
  private async handleBranch(step: any, ctx: WorkflowRunContext, config: any) {
    const steps: any[] = config.steps ?? [];
    const connectors = steps.filter(
      (s) => s.parentId === step.id && s.type === 'branch_connector',
    );
    this.logger.debug(`Evaluating branch step ${step.id} with connectors ${connectors.map((c) => c.name).join(', ')}`, { ctx, connectors });
    for (const connector of connectors) {
      if (connector.name === 'Else') continue;

      const conditions: any[] = connector.data?.conditions ?? [];
      const match = this.evaluateBranchConditions(conditions, ctx);
      this.logger.debug(`Evaluated branch connector ${connector.name} with conditions ${JSON.stringify(conditions)}: match=${match}`, { ctx, conditions });
      if (match) {
        return {
          output: { matchedBranch: connector.name },
          branchConnectorId: connector.id,
        };
      }
    }

    // Fallback to Else
    const elseConnector = connectors.find((c) => c.name === 'Else');
    return {
      output: { matchedBranch: 'Else' },
      branchConnectorId: elseConnector?.id ?? null,
    };
  }

  // branch_connector — passthrough, find first child step
  private async handleBranchConnector(step: any, ctx: WorkflowRunContext, config: any) {
    const steps: any[] = config.steps ?? [];
    const firstChild = steps.find(
      (s) => s.parentId === step.id && s.type !== 'branch_connector',
    );
    return { output: {}, nextStepId: firstChild?.id ?? null };
  }

  // wait
  private async handleWait(step: any, ctx: WorkflowRunContext) {
    const { value, unit } = step.data;
    const ms = this.toMs(value, unit);

    await workflowQueue.add(
      'resume-after-wait',
      { type: 'RESUME', runId: ctx.runId, resumeData: {} } satisfies WorkflowJob,
      { delay: ms },
    );

    return { output: { waitMs: ms, unit, value }, suspend: true };
  }

  // http_request
  private async handleHttpRequest(step: any, ctx: WorkflowRunContext) {
    const { method, url, headers = [], body, responseMappings = [], saveResponseStatus, responseStatusVariableName } = step.data;

    const resolvedUrl = this.interpolate(url ?? '', ctx);
    if (!resolvedUrl) return { output: { skipped: true, reason: 'no URL' } };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const resolvedHeaders: Record<string, string> = {};
      for (const h of headers) {
        if (h.key) resolvedHeaders[h.key] = this.interpolate(h.value ?? '', ctx);
      }

      const res = await fetch(resolvedUrl, {
        method,
        headers: resolvedHeaders,
        body: method !== 'GET' ? this.interpolate(body ?? '', ctx) : undefined,
        signal: controller.signal,
      });

      const json = await res.json().catch(() => ({}));

      // Map response to variables / contact fields
      for (const mapping of responseMappings) {
        if (!mapping.jsonKey) continue;
        const val = this.getNestedValue(json, mapping.jsonKey);
        if (mapping.variableName) ctx.vars[mapping.variableName] = val;
      }

      // Save response status as variable
      if (saveResponseStatus && responseStatusVariableName) {
        ctx.vars[responseStatusVariableName] = res.status;
      }

      return { output: { status: res.status, body: json } };
    } finally {
      clearTimeout(timeout);
    }
  }

  // jump_to
  private async handleJumpTo(step: any, ctx: WorkflowRunContext) {
    const { targetStepId, maxJumps } = step.data;
    if (!targetStepId) return { output: { skipped: true, reason: 'no targetStepId' } };

    const jumpKey = `wf:jumps:${ctx.runId}:${step.id}`;
    const jumps = parseInt((await this.redis.client.get(jumpKey)) ?? '0');

    if (jumps >= (maxJumps ?? 3)) {
      this.logger.warn(`Max jumps reached step=${step.id} run=${ctx.runId}`);
      return { output: { skipped: true, reason: 'max jumps reached' } };
    }

    await this.redis.client.incr(jumpKey);
    return { output: { jumped: true, to: targetStepId }, nextStepId: targetStepId };
  }

  // open_conversation
  private async handleOpenConversation(step: any, ctx: WorkflowRunContext) {
    await this.prisma.conversation.updateMany({
      where: { contactId: ctx.contactId, workspaceId: ctx.workspaceId },
      data: { status: 'open', updatedAt: new Date() },
    });
    return { output: { opened: true } };
  }

  // close_conversation
  private async handleCloseConversation(step: any, ctx: WorkflowRunContext) {
    const { addClosingNotes, notes, category } = step.data;

    const conversation = await this.prisma.conversation.findFirst({
      where: { contactId: ctx.contactId, workspaceId: ctx.workspaceId, status: { not: 'closed' } },
    });
    if (!conversation) return { output: { skipped: true } };

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: 'closed', resolvedAt: new Date() },
    });

    if (addClosingNotes && notes) {
      await this.prisma.message.create({
        data: {
          workspaceId: ctx.workspaceId,
          conversationId: conversation.id,
          channelId: null,
          channelType: 'system',
          type: 'note',
          direction: 'outgoing',
          text: this.interpolate(notes, ctx),
          status: 'sent',
          sentAt: new Date(),
          metadata: category ? { category } : undefined,
        },
      });
    }

    await this.prisma.conversationActivity.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: conversation.id,
        eventType: 'closed',
        actorType: 'automation',
        metadata: category ? { category } : undefined,
      },
    });

    return { output: { closed: true, category } };
  }

  // add_comment
  private async handleAddComment(step: any, ctx: WorkflowRunContext) {
    const text = this.interpolate(step.data.comment ?? '', ctx);
    if (!text) return { output: { skipped: true, reason: 'empty comment' } };

    const conversation = await this.prisma.conversation.findFirst({
      where: { contactId: ctx.contactId, status: { not: 'closed' } },
    });
    if (!conversation) return { output: { skipped: true, reason: 'no open conversation' } };

    await this.prisma.message.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: conversation.id,
        channelId: null,
        channelType: 'system',
        type: 'note',
        direction: 'outgoing',
        text,
        status: 'sent',
        sentAt: new Date(),
      },
    });

    return { output: { commented: true, text } };
  }

  // date_time — routes to In Range / Out of Range connector
  private async handleDateTime(step: any, ctx: WorkflowRunContext, config: any) {
    const { timezone, mode, businessHours, dateRangeStart, dateRangeEnd } = step.data;
    const now = new Date();
    const steps: any[] = config.steps ?? [];

    const connectors = steps.filter(
      (s) => s.parentId === step.id && s.type === 'branch_connector',
    );

    let inRange = false;

    if (mode === 'business_hours' && businessHours) {
      const day = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        timeZone: timezone ?? 'UTC',
      }).format(now).toLowerCase();

      const time = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: timezone ?? 'UTC',
      }).format(now);

      const hours = businessHours[day];
      if (hours?.enabled && hours.startTime && hours.endTime) {
        inRange = time >= hours.startTime && time <= hours.endTime;
      }
    } else if (mode === 'date_range' && dateRangeStart && dateRangeEnd) {
      inRange = now >= new Date(dateRangeStart) && now <= new Date(dateRangeEnd);
    }

    const targetName = inRange ? 'In Range' : 'Out of Range';
    const connector = connectors.find((c) => c.name === targetName);

    return {
      output: { inRange, targetName, timezone, mode },
      branchConnectorId: connector?.id ?? null,
    };
  }

  // trigger_another_workflow
  private async handleTriggerAnotherWorkflow(step: any, ctx: WorkflowRunContext) {
    const { targetWorkflowId, startFrom, targetStepId } = step.data;
    if (!targetWorkflowId) return { output: { skipped: true, reason: 'no targetWorkflowId' } };

    const targetWorkflow = await this.prisma.workflow.findUnique({
      where: { id: targetWorkflowId },
    });
    if (!targetWorkflow || targetWorkflow.status !== 'published') {
      return { output: { skipped: true, reason: 'target workflow not published' } };
    }

    await workflowQueue.add('trigger', {
      type: 'TRIGGER',
      workspaceId: ctx.workspaceId,
      workflowId: targetWorkflowId,
      contactId: ctx.contactId,
      conversationId: ctx.conversationId,
      triggerData: {
        ...ctx.trigger,
        triggeredByWorkflow: ctx.workflowId,
        startFrom,
        targetStepId: startFrom === 'specific_step' ? targetStepId : undefined,
      },
    } satisfies WorkflowJob);

    return { output: { triggered: true, targetWorkflowId } };
  }

  // ── Condition evaluators ─────────────────────────────────────────────────

  // For TRIGGER conditions (TriggerCondition[]) — field-based flat evaluation
  evaluateConditions(
    conditions: any[],
    contact: Record<string, any>,
    triggerData: Record<string, any>,
  ): boolean {
    if (!conditions?.length) return true;

    let result = true;

    for (let i = 0; i < conditions.length; i++) {
      const cond = conditions[i];
      const fieldValue = this.resolveTriggerField(cond.field, contact, triggerData);
      const match = this.evaluateSingle(cond.operator, fieldValue, cond.value);

      if (i === 0) {
        result = match;
      } else {
        const logic = conditions[i - 1].logicalOperator ?? 'AND';
        result = logic === 'AND' ? result && match : result || match;
      }
    }

    return result;
  }

  // For BRANCH conditions (BranchCondition[]) — category + field evaluation
  private evaluateBranchConditions(conditions: any[], ctx: WorkflowRunContext): boolean {
    if (!conditions?.length) return true;

    let result = true;

    for (let i = 0; i < conditions.length; i++) {
      const cond = conditions[i];
      const fieldValue = this.resolveBranchField(cond, ctx);
      const match = this.evaluateSingle(cond.operator, fieldValue, cond.value);

      if (i === 0) {
        result = match;
      } else {
        const logic = conditions[i - 1].logicalOperator ?? 'AND';
        result = logic === 'AND' ? result && match : result || match;
      }
    }

    return result;
  }

  private resolveTriggerField(
    field: string,
    contact: Record<string, any>,
    triggerData: Record<string, any>,
  ): any {
    // Try contact first, then trigger data
    return contact?.[field] ?? triggerData?.[field];
  }

  private resolveBranchField(cond: any, ctx: WorkflowRunContext): any {
    const { category, field } = cond;
    const contact = ctx.contact;
    const trigger = ctx.trigger;

    switch (category) {
      case 'contact_field':
        return contact?.[field];

      case 'contact_tags':
        return contact?.tags ?? []; // string[] of tag IDs

      case 'variable':
        return ctx.vars?.[field] ?? trigger?.[field];

      case 'assignee_status': {
        // Resolve from workspace member availability
        // Stored in context from loadContactData
        return contact?.assigneeAvailability ?? null;
      }

      case 'last_interacted_channel':
        return trigger?.channel ?? null;

      case 'last_incoming_message':
        return trigger?.lastIncomingMessage ?? null;

      case 'last_outgoing_message':
        return trigger?.lastOutgoingMessage ?? null;

      case 'last_outgoing_message_source':
        return trigger?.lastOutgoingMessageSource ?? null;

      case 'time_since_last_incoming': {
        if (!trigger?.lastIncomingAt) return null;
        return Date.now() - new Date(trigger.lastIncomingAt).getTime(); // ms
      }

      case 'time_since_last_outgoing': {
        if (!trigger?.lastOutgoingAt) return null;
        return Date.now() - new Date(trigger.lastOutgoingAt).getTime(); // ms
      }

      default:
        return undefined;
    }
  }

  private evaluateSingle(operator: string, value: any, condValue: any): boolean {
    // Handle array-based operators first
    if (['has_any_of', 'has_all_of', 'has_none_of'].includes(operator)) {
      const arr = Array.isArray(value) ? value : [value];
      const vals = Array.isArray(condValue) ? condValue : [condValue];

      switch (operator) {
        case 'has_any_of': return arr.some((a) => vals.includes(a));
        case 'has_all_of': return vals.every((v) => arr.includes(v));
        case 'has_none_of': return !arr.some((a) => vals.includes(a));
      }
    }

    // Null / existence checks
    const isEmpty = value === null || value === undefined || value === '';
    if (operator === 'exists') return !isEmpty;
    if (operator === 'does_not_exist') return isEmpty;
    if (isEmpty) return false;

    // Timestamp operators
    if (['is_timestamp_after', 'is_timestamp_before', 'is_timestamp_between'].includes(operator)) {
      const ts = new Date(value).getTime();
      switch (operator) {
        case 'is_timestamp_after': return ts > new Date(condValue).getTime();
        case 'is_timestamp_before': return ts < new Date(condValue).getTime();
        case 'is_timestamp_between': {
          const [from, to] = String(condValue).split('|');
          return ts >= new Date(from).getTime() && ts <= new Date(to).getTime();
        }
      }
    }

    // Time-duration operators (value is ms since last event)
    if (['is_greater_than_time', 'is_less_than_time', 'is_between_time'].includes(operator)) {
      const ms = Number(value);
      const parts = String(condValue).split('|');
      const unitMap: Record<string, number> = {
        minutes: 60_000, hours: 3_600_000, days: 86_400_000,
      };
      switch (operator) {
        case 'is_greater_than_time': {
          const unit = unitMap[parts[1]] ?? 60_000;
          return ms > Number(parts[0]) * unit;
        }
        case 'is_less_than_time': {
          const unit = unitMap[parts[1]] ?? 60_000;
          return ms < Number(parts[0]) * unit;
        }
        case 'is_between_time': {
          const unit = unitMap[parts[2]] ?? 60_000;
          return ms >= Number(parts[0]) * unit && ms <= Number(parts[1]) * unit;
        }
      }
    }

    // Numeric operators
    if (['is_greater_than', 'is_less_than', 'is_between'].includes(operator)) {
      const num = parseFloat(String(value));
      switch (operator) {
        case 'is_greater_than': return num > parseFloat(String(condValue));
        case 'is_less_than': return num < parseFloat(String(condValue));
        case 'is_between': {
          const [lo, hi] = String(condValue).split('|').map(parseFloat);
          return num >= lo && num <= hi;
        }
      }
    }

    // String operators
    const v = String(value).toLowerCase();
    const cv = String(condValue).toLowerCase();

    switch (operator) {
      case 'is_equal_to': return v === cv;
      case 'is_not_equal_to': return v !== cv;
      case 'contains': return v.includes(cv);
      case 'does_not_contain': return !v.includes(cv);
      default:
        this.logger.warn(`Unknown operator: ${operator}`);
        return false;
    }
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  private findNextStep(
    currentStepId: string,
    steps: any[],
    branchConnectorId?: string | null,
  ): string | null {
    if (branchConnectorId) {
      // First non-connector child of the chosen connector
      const child = steps.find(
        (s) => s.parentId === branchConnectorId && s.type !== 'branch_connector',
      );
      return child?.id ?? null;
    }

    // Linear: next step whose parentId is currentStepId, skip connectors
    const next = steps.find(
      (s) => s.parentId === currentStepId && s.type !== 'branch_connector',
    );
    return next?.id ?? null;
  }

  // ── Run lifecycle ────────────────────────────────────────────────────────

  private async completeRun(runId: string, ctx: WorkflowRunContext) {
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { status: 'completed', completedAt: new Date() },
    });
    await this.cleanupRun(runId, ctx);
    this.logger.log(`Run completed runId=${runId}`);
  }

  private async failRun(runId: string, ctx: WorkflowRunContext, error: string) {
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { status: 'failed', failedAt: new Date(), error },
    });
    await this.cleanupRun(runId, ctx);
    this.logger.error(`Run failed runId=${runId} error=${error}`);
  }

  private async cleanupRun(runId: string, ctx: WorkflowRunContext) {
    await this.redis.client.del(RUN_CTX_KEY(runId));
    await this.redis.client.del(ACTIVE_RUN_KEY(ctx.workspaceId, ctx.contactId));
  }

  private async handleStepError(
    stepRunId: string,
    runId: string,
    step: any,
    ctx: WorkflowRunContext,
    steps: any[],
    err: any,
  ) {
    const message = err?.message ?? String(err);
    this.logger.error(`Step error step=${step.id} run=${runId}: ${message}`);

    await this.prisma.workflowRunStep.update({
      where: { id: stepRunId },
      data: {
        status: 'failed',
        error: message,
        completedAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    // Route to Error connector if configured
    const errorConnector = steps.find(
      (s) => s.parentId === step.id &&
        s.type === 'branch_connector' &&
        s.name === 'Error',
    );

    if (errorConnector) {
      await this.enqueueStep(runId, errorConnector.id);
    } else {
      await this.failRun(runId, ctx, message);
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  private async enqueueStep(runId: string, stepId: string) {
    await workflowQueue.add(
      'execute-step',
      { type: 'EXECUTE_STEP', runId, stepId } satisfies WorkflowJob,
      { jobId: `step-${runId}-${stepId}-${Date.now()}` },
    );
  }

  private async saveContext(ctx: WorkflowRunContext) {
    await this.redis.client.setex(
      RUN_CTX_KEY(ctx.runId),
      RUN_CTX_TTL,
      JSON.stringify(ctx),
    );
  }

  private async loadContext(runId: string): Promise<WorkflowRunContext | null> {
    return this.redis.getJSON(RUN_CTX_KEY(runId));
  }

  private async loadContactData(contactId: string): Promise<Record<string, any>> {
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        tags: { select: { tagId: true } },
        assignee: { select: { id: true } },
        team: { select: { id: true, name: true } },
        lifecycle: { select: { id: true, name: true } },
      },
    });

    if (!contact) return {};

    return {
      ...contact,
      tags: contact.tags.map((t) => t.tagId),
      assigneeId: contact.assigneeId,
      teamId: contact.teamId,
      lifecycleId: contact.lifecycleId,
      lifecycleName: contact.lifecycle?.name,
    };
  }

  private interpolate(template: string, ctx: WorkflowRunContext): string {
    if (!template) return '';
    return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const parts = key.trim().split('.');
      let val: any = {
        contact: ctx.contact,
        vars: ctx.vars,
        trigger: ctx.trigger,
      };
      for (const p of parts) val = val?.[p];
      return val != null ? String(val) : '';
    });
  }

  private getNestedValue(obj: any, path: string): any {
    if (!path || !obj) return undefined;
    return path.split('.').reduce((acc, key) => acc?.[key], obj);
  }

  private toMs(value: number, unit: string): number {
    const map: Record<string, number> = {
      seconds: 1_000,
      minutes: 60_000,
      hours: 3_600_000,
      days: 86_400_000,
    };
    return value * (map[unit] ?? 3_600_000);
  }
}