const mockWaitUntilFinished = jest.fn(async () => undefined);
const mockMessageProcessingQueueAdd = jest.fn(async () => ({
  waitUntilFinished: mockWaitUntilFinished,
}));
const mockQueueEventsWaitUntilReady = jest.fn(async () => undefined);

jest.mock('bullmq', () => ({
  QueueEvents: jest.fn().mockImplementation(() => ({
    waitUntilReady: mockQueueEventsWaitUntilReady,
  })),
}));
jest.mock('../../queues/connection', () => ({
  connection: { host: 'localhost', port: 6379 },
}));
jest.mock('../../queues/message-processing.queue', () => ({
  messageProcessingQueue: {
    name: 'message-processing',
    add: mockMessageProcessingQueueAdd,
  },
}));
jest.mock('../../queues/workflow.queue', () => ({
  workflowQueue: { add: jest.fn() },
}));
jest.mock('../notifications/notifications.service', () => ({
  NotificationsService: class NotificationsService {},
}));

import { PrismaService } from '../../prisma/prisma.service';
import { workflowQueue } from '../../queues/workflow.queue';
import { RedisService } from '../../redis/redis.service';
import { ActivityService } from '../activity/activity.service';
import { WorkflowRunContext } from './workflow-run.context';
import { WorkflowEngineService } from './workflow-engine.service';

type ContactDelegateMock = {
  count: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
};

type PrismaMock = {
  contact: ContactDelegateMock;
  contactTag: { upsert: jest.Mock };
  contactChannel: { findFirst: jest.Mock };
  conversation: { findFirst: jest.Mock };
  conversationActivity: { create: jest.Mock };
  tag: { create: jest.Mock; findFirst: jest.Mock };
  teamMember: { findMany: jest.Mock };
  workspaceMember: { findFirst: jest.Mock; findMany: jest.Mock };
  workflow: { findFirst: jest.Mock; findUnique: jest.Mock };
  workflowRun: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  workflowRunStep: {
    create: jest.Mock;
    update: jest.Mock;
  };
};

type RedisMock = {
  getJSON: jest.Mock;
  client: {
    del: jest.Mock;
    incr: jest.Mock;
    publish: jest.Mock;
    setex: jest.Mock;
  };
};

type ActivityMock = {
  record: jest.Mock;
};

type WorkflowEngineFieldTestApi = {
  startRun(job: {
    workspaceId: string;
    workflowId: string;
    contactId: string;
    conversationId?: string;
    triggerData: Record<string, unknown>;
  }): Promise<void>;
  completeRun(runId: string, ctx: WorkflowRunContext): Promise<void>;
  resumeRun(runId: string, resumeData: Record<string, unknown>): Promise<void>;
  handleAskQuestionTimeout(runId: string, stepId: string): Promise<void>;
  executeStep(runId: string, stepId: string): Promise<void>;
  handleAssignTo(
    step: {
      data: {
        action?: string;
        userId?: string;
        teamId?: string;
        assignmentLogic?: string;
        onlyOnlineUsers?: boolean;
        maxOpenContacts?: number;
      };
    },
    ctx: WorkflowRunContext,
  ): Promise<{ output: Record<string, unknown> }>;
  handleUpdateContactField(
    step: { data: { fieldId?: string; value?: string } },
    ctx: WorkflowRunContext,
  ): Promise<{ output: Record<string, unknown> }>;
  handleDateTime(
    step: {
      id: string;
      data: {
        timezone?: string;
        mode?: string;
        businessHours?: Record<string, unknown>;
        dateRangeStart?: string;
        dateRangeEnd?: string;
        connectors?: string[];
      };
    },
    ctx: WorkflowRunContext,
    config: { steps: Array<{ id: string; type: string; parentId: string; name: string }> },
  ): Promise<{ output: Record<string, unknown>; branchConnectorId: string | null }>;
  handleBranch(
    step: { id: string; type?: string; data?: Record<string, unknown> },
    ctx: WorkflowRunContext,
    config: { steps: unknown[] },
  ): Promise<{ output: Record<string, unknown>; branchConnectorId: string | null }>;
  handleSendMessage(
    step: {
      id?: string;
      type?: string;
      data: {
        channel?: string;
        defaultMessage?: { text?: string };
        attachments?: Array<Record<string, unknown>>;
        metadata?: Record<string, unknown>;
        addMessageFailureBranch?: boolean;
        connectors?: string[];
      };
    },
    ctx: WorkflowRunContext,
    config?: { steps: unknown[] },
  ): Promise<{ output: Record<string, unknown>; branchConnectorId?: string }>;
  handleAskQuestion(
    step: {
      id: string;
      data: {
        questionText: string;
        questionType: string;
        multipleChoiceOptions?: Array<{ id: string; label: string }>;
        saveAsVariable?: boolean;
        variableName?: string;
        saveAsTag?: boolean;
        addTimeoutBranch?: boolean;
        timeoutValue?: number;
        timeoutUnit?: string;
        addMessageFailureBranch?: boolean;
        connectors?: string[];
      };
    },
    ctx: WorkflowRunContext,
    config: { steps: unknown[] },
  ): Promise<{ output: Record<string, unknown>; suspend?: boolean; branchConnectorId?: string | null }>;
  handleTriggerAnotherWorkflow(
    step: {
      id?: string;
      data: {
        targetWorkflowId?: string;
        startFrom?: string;
        targetStepId?: string;
      };
    },
    ctx: WorkflowRunContext,
    config?: { steps: Array<{ id: string; type: string; parentId?: string }> },
  ): Promise<{ output: Record<string, unknown>; suspend?: boolean }>;
};

function createService(activity?: ActivityMock) {
  const prisma: PrismaMock = {
    contact: {
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    contactTag: {
      upsert: jest.fn(),
    },
    contactChannel: {
      findFirst: jest.fn(),
    },
    conversation: {
      findFirst: jest.fn(),
    },
    conversationActivity: {
      create: jest.fn(),
    },
    tag: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    teamMember: {
      findMany: jest.fn(),
    },
    workspaceMember: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    workflow: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    workflowRun: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    workflowRunStep: {
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const redis: RedisMock = {
    getJSON: jest.fn(),
    client: {
      del: jest.fn(),
      incr: jest.fn(async () => 0),
      publish: jest.fn(),
      setex: jest.fn(),
    },
  };
  const service = new WorkflowEngineService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    activity as unknown as ActivityService,
  ) as unknown as WorkflowEngineFieldTestApi;

  return { prisma, redis, activity, service };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWaitUntilFinished.mockResolvedValue(undefined);
  mockMessageProcessingQueueAdd.mockResolvedValue({
    waitUntilFinished: mockWaitUntilFinished,
  });
  mockQueueEventsWaitUntilReady.mockResolvedValue(undefined);
});

function createContext(): WorkflowRunContext {
  return {
    runId: 'run-1',
    workflowId: 'workflow-1',
    workflowName: 'Product Menu',
    workspaceId: 'workspace-1',
    contactId: 'contact-1',
    contact: { lastName: 'Old' },
    trigger: {},
    steps: {},
    vars: {},
  };
}

describe('WorkflowEngineService contact field updates', () => {
  it('records workflow start and end activities on the conversation timeline', async () => {
    const activity: ActivityMock = {
      record: jest.fn(async (dto) => ({
        id: `${dto.eventType}-activity-1`,
        conversationId: dto.conversationId,
        eventType: dto.eventType,
        actorType: dto.actorType,
        metadata: dto.metadata,
        createdAt: '2026-05-07T10:30:00.000Z',
        description: dto.eventType,
      })),
    };
    const { prisma, redis, service } = createService(activity);
    prisma.workflow.findFirst.mockResolvedValue({
      id: 'workflow-1',
      name: 'Product Menu',
      status: 'published',
      config: {
        steps: [
          {
            id: 'ask-question-step',
            parentId: 'trigger',
            type: 'ask_question',
          },
        ],
      },
    });
    prisma.contact.findUnique.mockResolvedValue({
      id: 'contact-1',
      firstName: 'Jay',
      lastName: 'Kanani',
      tags: [],
      assigneeId: null,
      teamId: null,
      lifecycleId: null,
      assignee: null,
      team: null,
      lifecycle: null,
    });
    prisma.workflowRun.create.mockResolvedValue({ id: 'run-1' });

    await service.startRun({
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      triggerData: {},
    });

    expect(activity.record).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      conversationId: 'conversation-1',
      eventType: 'workflow_started',
      actorType: 'automation',
      metadata: {
        workflowId: 'workflow-1',
        workflowName: 'Product Menu',
        runId: 'run-1',
      },
    });
    expect(redis.client.publish).toHaveBeenCalledWith(
      'activity.timeline',
      JSON.stringify({
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        activity: {
          id: 'workflow_started-activity-1',
          conversationId: 'conversation-1',
          eventType: 'workflow_started',
          actorType: 'automation',
          metadata: {
            workflowId: 'workflow-1',
            workflowName: 'Product Menu',
            runId: 'run-1',
          },
          createdAt: '2026-05-07T10:30:00.000Z',
          description: 'workflow_started',
        },
      }),
    );
    expect(workflowQueue.add).toHaveBeenCalledWith(
      'execute-step',
      { type: 'EXECUTE_STEP', runId: 'run-1', stepId: 'ask-question-step' },
      expect.objectContaining({ jobId: expect.stringContaining('step-run-1-ask-question-step') }),
    );

    redis.getJSON.mockResolvedValueOnce({ runId: 'run-1', workflowId: 'workflow-1' });

    await service.completeRun('run-1', {
      ...createContext(),
      conversationId: 'conversation-1',
    });

    expect(prisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: 'completed', completedAt: expect.any(Date) },
    });
    expect(activity.record).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      conversationId: 'conversation-1',
      eventType: 'workflow_ended',
      actorType: 'automation',
      metadata: {
        workflowId: 'workflow-1',
        workflowName: 'Product Menu',
        runId: 'run-1',
      },
    });
    expect(redis.client.publish).toHaveBeenCalledWith(
      'activity.timeline',
      JSON.stringify({
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        activity: {
          id: 'workflow_ended-activity-1',
          conversationId: 'conversation-1',
          eventType: 'workflow_ended',
          actorType: 'automation',
          metadata: {
            workflowId: 'workflow-1',
            workflowName: 'Product Menu',
            runId: 'run-1',
          },
          createdAt: '2026-05-07T10:30:00.000Z',
          description: 'workflow_ended',
        },
      }),
    );
    expect(redis.client.del).toHaveBeenCalledWith('wf:ctx:run-1');
    expect(redis.client.del).toHaveBeenCalledWith('wf:active:workspace-1:contact-1');
  });

  it('starts a workflow from the requested target step when another workflow triggers it', async () => {
    const { prisma, service } = createService();
    prisma.workflow.findFirst.mockResolvedValue({
      id: 'workflow-1',
      name: 'Reusable Follow-up',
      status: 'published',
      config: {
        steps: [
          {
            id: 'first-step',
            parentId: 'trigger',
            type: 'send_message',
          },
          {
            id: 'selected-step',
            parentId: 'first-step',
            type: 'ask_question',
          },
        ],
      },
    });
    prisma.contact.findUnique.mockResolvedValue({
      id: 'contact-1',
      firstName: 'Jay',
      lastName: 'Kanani',
      tags: [],
      assigneeId: null,
      teamId: null,
      lifecycleId: null,
      assignee: null,
      team: null,
      lifecycle: null,
    });
    prisma.workflowRun.create.mockResolvedValue({ id: 'run-1' });

    await service.startRun({
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      triggerData: {
        startFrom: 'specific_step',
        targetStepId: 'selected-step',
      },
    });

    expect(workflowQueue.add).toHaveBeenCalledWith(
      'execute-step',
      { type: 'EXECUTE_STEP', runId: 'run-1', stepId: 'selected-step' },
      expect.objectContaining({ jobId: expect.stringContaining('step-run-1-selected-step') }),
    );
  });

  it('queues a manual target workflow with the selected starting step', async () => {
    const { prisma, service } = createService();
    prisma.workflow.findFirst.mockResolvedValue({
      id: 'target-workflow',
      workspaceId: 'workspace-1',
      status: 'published',
      config: {
        trigger: { type: 'manual_trigger' },
        steps: [
          {
            id: 'selected-step',
            parentId: 'trigger',
            type: 'send_message',
          },
        ],
      },
    });

    await expect(
      service.handleTriggerAnotherWorkflow(
        {
          id: 'trigger-step',
          data: {
            targetWorkflowId: 'target-workflow',
            startFrom: 'specific_step',
            targetStepId: 'selected-step',
          },
        },
        createContext(),
      ),
    ).resolves.toEqual({
      output: {
        triggered: true,
        waitForCompletion: true,
        targetWorkflowId: 'target-workflow',
        targetStepId: 'selected-step',
        resumeParentStepId: null,
      },
      suspend: true,
    });

    expect(prisma.workflow.findFirst).toHaveBeenCalledWith({
      where: { id: 'target-workflow', workspaceId: 'workspace-1' },
    });
    expect(workflowQueue.add).toHaveBeenCalledWith(
      'trigger',
      {
        type: 'TRIGGER',
        workspaceId: 'workspace-1',
        workflowId: 'target-workflow',
        contactId: 'contact-1',
        conversationId: undefined,
        triggerData: {
          triggeredByWorkflow: 'workflow-1',
          triggeredByRunId: 'run-1',
          triggeredByStepId: 'trigger-step',
          resumeParentStepId: null,
          startFrom: 'specific_step',
          targetStepId: 'selected-step',
        },
      },
    );
  });

  it('waits for the triggered workflow before continuing the parent workflow', async () => {
    const { prisma, redis, service } = createService();
    const parentContext = createContext();
    const parentSteps = [
      {
        id: 'trigger-child-workflow',
        parentId: 'trigger',
        type: 'trigger_another_workflow',
        data: {
          targetWorkflowId: 'target-workflow',
          startFrom: 'beginning',
        },
      },
      {
        id: 'parent-next-step',
        parentId: 'trigger-child-workflow',
        type: 'send_message',
        data: {},
      },
    ];

    prisma.workflowRun.findUnique.mockResolvedValue({
      id: 'run-1',
      workflowId: 'workflow-1',
      status: 'running',
    });
    redis.getJSON.mockResolvedValue(parentContext);
    prisma.workflow.findUnique.mockResolvedValue({
      id: 'workflow-1',
      name: 'Parent Workflow',
      config: { steps: parentSteps },
    });
    prisma.workflow.findFirst.mockResolvedValue({
      id: 'target-workflow',
      workspaceId: 'workspace-1',
      status: 'published',
      config: {
        trigger: { type: 'manual_trigger' },
        steps: [],
      },
    });
    prisma.workflowRunStep.create.mockResolvedValue({ id: 'run-step-1' });
    prisma.workflowRunStep.update.mockResolvedValue({});
    prisma.workflowRun.update.mockResolvedValue({});

    await service.executeStep('run-1', 'trigger-child-workflow');

    expect(workflowQueue.add).toHaveBeenNthCalledWith(
      1,
      'trigger',
      expect.objectContaining({
        type: 'TRIGGER',
        workspaceId: 'workspace-1',
        workflowId: 'target-workflow',
        contactId: 'contact-1',
        triggerData: expect.objectContaining({
          triggeredByWorkflow: 'workflow-1',
          triggeredByRunId: 'run-1',
          triggeredByStepId: 'trigger-child-workflow',
          resumeParentStepId: 'parent-next-step',
          startFrom: 'beginning',
        }),
      }),
    );
    expect(workflowQueue.add).toHaveBeenCalledTimes(1);
    expect(prisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: 'waiting' },
    });
  });

  it('resumes the parent workflow after the triggered workflow completes', async () => {
    const { prisma, redis, service } = createService();
    redis.getJSON.mockResolvedValueOnce(null);
    prisma.workflowRun.findUnique.mockResolvedValueOnce({
      id: 'parent-run',
      workflowId: 'workflow-1',
      status: 'waiting',
    });

    await service.completeRun('child-run', {
      ...createContext(),
      runId: 'child-run',
      workflowId: 'target-workflow',
      workflowName: 'Rating Workflow',
      trigger: {
        triggeredByRunId: 'parent-run',
        resumeParentStepId: 'parent-next-step',
      },
    });

    expect(workflowQueue.add).toHaveBeenCalledWith(
      'resume',
      {
        type: 'RESUME',
        runId: 'parent-run',
        resumeData: {
          triggeredWorkflowId: 'target-workflow',
          triggeredWorkflowRunId: 'child-run',
          triggeredWorkflowStatus: 'completed',
          nextStepId: 'parent-next-step',
        },
      },
    );
  });

  it('does not clear another workflow active marker when a parent run completes', async () => {
    const { redis, service } = createService();
    redis.getJSON.mockResolvedValueOnce({
      runId: 'child-run',
      workflowId: 'target-workflow',
    });

    await service.completeRun('parent-run', {
      ...createContext(),
      runId: 'parent-run',
    });

    expect(redis.client.del).toHaveBeenCalledWith('wf:ctx:parent-run');
    expect(redis.client.del).not.toHaveBeenCalledWith(
      'wf:active:workspace-1:contact-1',
    );
  });

  it('maps legacy snake-case field ids to Prisma contact fields', async () => {
    const { prisma, service } = createService();
    const ctx = createContext();
    prisma.contact.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.handleUpdateContactField(
        { data: { fieldId: 'last_name', value: 'workflow' } },
        ctx,
      ),
    ).resolves.toEqual({
      output: {
        fieldId: 'last_name',
        contactField: 'lastName',
        value: 'workflow',
      },
    });

    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { id: 'contact-1', workspaceId: 'workspace-1' },
      data: { lastName: 'workflow' },
    });
    expect(ctx.contact.lastName).toBe('workflow');
    expect(ctx.contact.last_name).toBe('workflow');
  });

  it('rejects unsupported contact fields', async () => {
    const { prisma, service } = createService();

    await expect(
      service.handleUpdateContactField(
        { data: { fieldId: 'bot_status', value: 'On' } },
        createContext(),
      ),
    ).rejects.toThrow('Unsupported contact field: bot_status');
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  it('normalises numbered multiple-choice answers to the option label', async () => {
    const { service } = createService();
    const ctx = createContext();
    ctx.vars.lastAnswer = '2';
    ctx.vars.lastAnswerMessageId = 'message-2';

    await expect(
      service.handleAskQuestion(
        {
          id: 'ask-question-step',
          data: {
            questionText: 'what is product?',
            questionType: 'multiple_choice',
            saveAsVariable: true,
            variableName: 'all_product',
            multipleChoiceOptions: [
              { id: 'product-1', label: 'Product 1' },
              { id: 'product-2', label: 'Product 2' },
              { id: 'product-3', label: 'Product 3' },
            ],
          },
        },
        ctx,
        { steps: [] },
      ),
    ).resolves.toMatchObject({
      output: { answer: 'Product 2', valid: true },
    });

    expect(ctx.vars.all_product).toBe('Product 2');
    expect(ctx.vars.lastAnswer).toBeUndefined();
    expect(ctx.vars.__processedAnswerMessageIds).toEqual(['message-2']);
  });

  it('ignores duplicate answer messages after a jumped question waits again', async () => {
    const { prisma, redis, service } = createService();
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: 'run-1',
      status: 'waiting',
      currentStepId: 'ask-question-step',
    });
    redis.getJSON.mockResolvedValue({
      ...createContext(),
      vars: {
        __processedAnswerMessageIds: ['message-2'],
      },
    });

    await service.resumeRun('run-1', {
      lastAnswer: 'Product 2',
      lastAnswerMessageId: 'message-2',
    });

    expect(prisma.workflowRun.update).not.toHaveBeenCalled();
    expect(workflowQueue.add).not.toHaveBeenCalled();
  });
});

describe('WorkflowEngineService assignment', () => {
  it('skips unconfigured assign steps instead of changing the contact', async () => {
    const { prisma, service } = createService();

    await expect(
      service.handleAssignTo(
        { data: { action: '' } },
        createContext(),
      ),
    ).resolves.toEqual({
      output: { skipped: true, reason: 'no assignment action configured' },
    });

    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(prisma.conversationActivity.create).not.toHaveBeenCalled();
  });

  it('assigns to a selected active workspace user', async () => {
    const { prisma, service } = createService();
    prisma.workspaceMember.findFirst.mockResolvedValue({ userId: 'user-1' });
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conversation-1' });
    prisma.contact.update.mockResolvedValue({});
    prisma.conversationActivity.create.mockResolvedValue({});

    await expect(
      service.handleAssignTo(
        { data: { action: 'specific_user', userId: 'user-1' } },
        createContext(),
      ),
    ).resolves.toEqual({
      output: {
        assigned: true,
        assigneeId: 'user-1',
        teamId: null,
        action: 'specific_user',
      },
    });

    expect(prisma.workspaceMember.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        status: 'active',
      },
      select: { userId: true },
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-1' },
      data: { assigneeId: 'user-1', teamId: null },
    });
    expect(prisma.conversationActivity.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        eventType: 'assigned',
        actorType: 'automation',
        subjectUserId: 'user-1',
        subjectTeamId: null,
      },
    });
  });

  it('routes workspace assignment through eligible users with the selected logic', async () => {
    const { prisma, service } = createService();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conversation-1' });
    prisma.workspaceMember.findMany.mockResolvedValue([
      { userId: 'busy-user' },
      { userId: 'available-user' },
    ]);
    prisma.contact.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    prisma.contact.update.mockResolvedValue({});
    prisma.conversationActivity.create.mockResolvedValue({});

    await expect(
      service.handleAssignTo(
        {
          data: {
            action: 'user_in_workspace',
            assignmentLogic: 'least_open_contacts',
            onlyOnlineUsers: true,
            maxOpenContacts: 3,
          },
        },
        createContext(),
      ),
    ).resolves.toEqual({
      output: {
        assigned: true,
        assigneeId: 'available-user',
        teamId: null,
        action: 'user_in_workspace',
      },
    });

    expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        role: 'agent',
        status: 'active',
        availability: 'online',
      },
      select: { userId: true },
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-1' },
      data: { assigneeId: 'available-user', teamId: null },
    });
  });
});

describe('WorkflowEngineService branch routing', () => {
  it('matches supported contact fields and contact tags from the workflow context', async () => {
    const { service } = createService();
    const ctx = createContext();
    ctx.contact = {
      ...ctx.contact,
      lifecycleId: 'stage-qualified',
      tags: ['tag-vip', 'tag-product'],
    };

    await expect(
      service.handleBranch(
        { id: 'branch-step', type: 'branch', data: {} },
        ctx,
        {
          steps: [
            {
              id: 'qualified-connector',
              type: 'branch_connector',
              parentId: 'branch-step',
              name: 'Qualified',
              data: {
                conditions: [
                  {
                    id: 'cond-lifecycle',
                    category: 'contact_field',
                    field: 'lifecycle_id',
                    operator: 'is_equal_to',
                    value: 'stage-qualified',
                  },
                  {
                    id: 'cond-tags',
                    category: 'contact_tags',
                    operator: 'has_all_of',
                    value: ['tag-vip', 'tag-product'],
                    logicalOperator: 'AND',
                  },
                ],
              },
            },
            {
              id: 'else-connector',
              type: 'branch_connector',
              parentId: 'branch-step',
              name: 'Else',
              data: { conditions: [], isElse: true },
            },
          ],
        },
      ),
    ).resolves.toEqual({
      output: { matchedBranch: 'Qualified' },
      branchConnectorId: 'qualified-connector',
    });
  });

  it('treats empty tag arrays as not existing and falls back to Else', async () => {
    const { service } = createService();
    const ctx = createContext();
    ctx.contact = { ...ctx.contact, tags: [] };

    await expect(
      service.handleBranch(
        { id: 'branch-step', type: 'branch', data: {} },
        ctx,
        {
          steps: [
            {
              id: 'tag-connector',
              type: 'branch_connector',
              parentId: 'branch-step',
              name: 'Tagged',
              data: {
                conditions: [
                  {
                    id: 'cond-tags',
                    category: 'contact_tags',
                    operator: 'exists',
                    value: [],
                  },
                ],
              },
            },
            {
              id: 'else-connector',
              type: 'branch_connector',
              parentId: 'branch-step',
              name: 'Else',
              data: { conditions: [], isElse: true },
            },
          ],
        },
      ),
    ).resolves.toEqual({
      output: { matchedBranch: 'Else' },
      branchConnectorId: 'else-connector',
    });
  });

  it('matches channel IDs and assignee availability for non-variable categories', async () => {
    const { service } = createService();
    const ctx = createContext();
    ctx.contact = { ...ctx.contact, assigneeAvailability: 'away' };
    ctx.trigger = { channelId: 'channel-1', channel: 'instagram' };

    await expect(
      service.handleBranch(
        { id: 'branch-step', type: 'branch', data: {} },
        ctx,
        {
          steps: [
            {
              id: 'channel-connector',
              type: 'branch_connector',
              parentId: 'branch-step',
              name: 'Instagram Away',
              data: {
                conditions: [
                  {
                    id: 'cond-channel',
                    category: 'last_interacted_channel',
                    operator: 'is_equal_to',
                    value: 'channel-1',
                  },
                  {
                    id: 'cond-assignee-status',
                    category: 'assignee_status',
                    operator: 'is_equal_to',
                    value: 'away',
                    logicalOperator: 'AND',
                  },
                ],
              },
            },
          ],
        },
      ),
    ).resolves.toEqual({
      output: { matchedBranch: 'Instagram Away' },
      branchConnectorId: 'channel-connector',
    });
  });
});

describe('WorkflowEngineService ask question', () => {
  it('waits for the outbound message job before the send step continues', async () => {
    const { prisma, service } = createService();
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      lastMessage: { channelId: 'instagram-channel-1' },
    });

    await expect(
      service.handleSendMessage(
        {
          id: 'send-message-step',
          type: 'send_message',
          data: {
            channel: 'last_interacted',
            defaultMessage: { text: 'prod 1' },
          },
        },
        createContext(),
      ),
    ).resolves.toEqual({
      output: { sent: true, text: 'prod 1', attachments: 0 },
    });

    expect(mockMessageProcessingQueueAdd).toHaveBeenCalledWith(
      'outbound.send_message',
      {
        kind: 'outbound.send_message',
        payload: {
          workspaceId: 'workspace-1',
          conversationId: 'conversation-1',
          channelId: 'instagram-channel-1',
          text: 'prod 1',
          attachments: [],
          metadata: {},
        },
      },
    );
    expect(mockQueueEventsWaitUntilReady).toHaveBeenCalledTimes(1);
    expect(mockWaitUntilFinished).toHaveBeenCalledWith(expect.any(Object), 30000);
  });

  it('routes successful send message steps through the success connector when failure branching is enabled', async () => {
    const { prisma, service } = createService();
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      lastMessage: { channelId: 'instagram-channel-1' },
    });

    await expect(
      service.handleSendMessage(
        {
          id: 'send-message-step',
          type: 'send_message',
          data: {
            channel: 'last_interacted',
            defaultMessage: { text: 'prod 1' },
            addMessageFailureBranch: true,
            connectors: ['success-connector', 'failure-connector'],
          },
        },
        createContext(),
        {
          steps: [
            {
              id: 'success-connector',
              parentId: 'send-message-step',
              type: 'branch_connector',
              name: 'Success',
            },
            {
              id: 'failure-connector',
              parentId: 'send-message-step',
              type: 'branch_connector',
              name: 'Failure',
            },
          ],
        },
      ),
    ).resolves.toEqual({
      output: { sent: true, text: 'prod 1', attachments: 0 },
      branchConnectorId: 'success-connector',
    });
  });

  it('routes failed send message steps through the failure connector when failure branching is enabled', async () => {
    const { prisma, service } = createService();
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      lastMessage: { channelId: 'instagram-channel-1' },
    });
    mockWaitUntilFinished.mockRejectedValueOnce(new Error('provider rejected'));

    await expect(
      service.handleSendMessage(
        {
          id: 'send-message-step',
          type: 'send_message',
          data: {
            channel: 'last_interacted',
            defaultMessage: { text: 'prod 1' },
            addMessageFailureBranch: true,
            connectors: ['success-connector', 'failure-connector'],
          },
        },
        createContext(),
        {
          steps: [
            {
              id: 'success-connector',
              parentId: 'send-message-step',
              type: 'branch_connector',
              name: 'Success',
            },
            {
              id: 'failure-connector',
              parentId: 'send-message-step',
              type: 'branch_connector',
              name: 'Failure',
            },
          ],
        },
      ),
    ).resolves.toEqual({
      output: { failed: true, reason: 'provider rejected' },
      branchConnectorId: 'failure-connector',
    });
  });

  it('sends multiple-choice options as quick replies while waiting for an answer', async () => {
    const { prisma, redis, service } = createService();
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      lastMessage: { channelId: 'instagram-channel-1' },
    });

    await expect(
      service.handleAskQuestion(
        {
          id: 'ask-question-step',
          data: {
            questionText: 'what is product?',
            questionType: 'multiple_choice',
            multipleChoiceOptions: [
              { id: 'product-1', label: 'Product 1' },
              { id: 'product-2', label: 'Product 2' },
              { id: 'product-3', label: 'Product 3' },
            ],
          },
        },
        createContext(),
        { steps: [] },
      ),
    ).resolves.toEqual({
      output: { waiting: true, quickReplies: 3 },
      suspend: true,
    });

    expect(mockMessageProcessingQueueAdd).toHaveBeenCalledWith(
      'outbound.send_message',
      {
        kind: 'outbound.send_message',
        payload: {
          workspaceId: 'workspace-1',
          conversationId: 'conversation-1',
          channelId: 'instagram-channel-1',
          text: 'what is product?',
          attachments: [],
          metadata: {
            quickReplies: [
              { title: 'Product 1', payload: 'Product 1' },
              { title: 'Product 2', payload: 'Product 2' },
              { title: 'Product 3', payload: 'Product 3' },
            ],
          },
        },
      },
    );
    expect(redis.client.publish).not.toHaveBeenCalledWith('outbound.send', expect.any(String));
  });

  it('schedules the timeout branch when asking a question with timeout enabled', async () => {
    const { prisma, service } = createService();
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      lastMessage: { channelId: 'instagram-channel-1' },
    });

    await expect(
      service.handleAskQuestion(
        {
          id: 'ask-question-step',
          data: {
            questionText: 'what is product?',
            questionType: 'multiple_choice',
            multipleChoiceOptions: [{ id: 'product-1', label: 'Product 1' }],
            addTimeoutBranch: true,
            timeoutValue: 2,
            timeoutUnit: 'minutes',
            connectors: ['success-connector', 'failure-connector', 'timeout-connector'],
          },
        },
        createContext(),
        {
          steps: [
            {
              id: 'timeout-connector',
              parentId: 'ask-question-step',
              type: 'branch_connector',
              name: 'Timeout',
            },
          ],
        },
      ),
    ).resolves.toEqual({
      output: { waiting: true, quickReplies: 1 },
      suspend: true,
    });

    expect(workflowQueue.add).toHaveBeenCalledWith(
      'ask-question-timeout',
      { type: 'ASK_QUESTION_TIMEOUT', runId: 'run-1', stepId: 'ask-question-step' },
      { delay: 120000, jobId: 'ask-timeout-run-1-ask-question-step' },
    );
  });

  it('routes an unanswered question to the timeout connector when the timeout job fires', async () => {
    const { prisma, redis, service } = createService();
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: 'run-1',
      workflowId: 'workflow-1',
      status: 'waiting',
      currentStepId: 'ask-question-step',
    });
    redis.getJSON.mockResolvedValue(createContext());
    prisma.workflow.findUnique.mockResolvedValue({
      id: 'workflow-1',
      config: {
        steps: [
          {
            id: 'ask-question-step',
            type: 'ask_question',
            parentId: 'trigger',
            data: {
              addTimeoutBranch: true,
              connectors: ['success-connector', 'failure-connector', 'timeout-connector'],
            },
          },
          {
            id: 'timeout-connector',
            type: 'branch_connector',
            parentId: 'ask-question-step',
            name: 'Timeout',
          },
          {
            id: 'timeout-child',
            type: 'send_message',
            parentId: 'timeout-connector',
          },
        ],
      },
    });

    await service.handleAskQuestionTimeout('run-1', 'ask-question-step');

    expect(prisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: 'running' },
    });
    expect(workflowQueue.add).toHaveBeenCalledWith(
      'execute-step',
      { type: 'EXECUTE_STEP', runId: 'run-1', stepId: 'timeout-child' },
      expect.objectContaining({ jobId: expect.stringContaining('step-run-1-timeout-child') }),
    );
  });

  it('routes ask-question message send failures to the message failure connector', async () => {
    const { prisma, service } = createService();
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      lastMessage: { channelId: 'instagram-channel-1' },
    });
    mockWaitUntilFinished.mockRejectedValueOnce(new Error('provider rejected'));

    await expect(
      service.handleAskQuestion(
        {
          id: 'ask-question-step',
          data: {
            questionText: 'what is product?',
            questionType: 'multiple_choice',
            multipleChoiceOptions: [{ id: 'product-1', label: 'Product 1' }],
            addMessageFailureBranch: true,
            connectors: ['success-connector', 'failure-connector', 'timeout-connector', 'message-failure-connector'],
          },
        },
        createContext(),
        {
          steps: [
            {
              id: 'message-failure-connector',
              parentId: 'ask-question-step',
              type: 'branch_connector',
              name: 'Message Failure',
            },
          ],
        },
      ),
    ).resolves.toEqual({
      output: { messageFailed: true, reason: 'provider rejected' },
      branchConnectorId: 'message-failure-connector',
    });
  });

  it('creates and assigns a tag from a multiple-choice answer when save as tag is enabled', async () => {
    const { prisma, service } = createService();
    const ctx = createContext();
    ctx.vars.lastAnswer = 'Product 1';
    ctx.vars.lastAnswerMessageId = 'message-1';
    prisma.tag.findFirst.mockResolvedValue(null);
    prisma.tag.create.mockResolvedValue({ id: 'tag-1', name: 'Product 1' });
    prisma.contactTag.upsert.mockResolvedValue({});

    await expect(
      service.handleAskQuestion(
        {
          id: 'ask-question-step',
          data: {
            questionText: 'what is product?',
            questionType: 'multiple_choice',
            multipleChoiceOptions: [{ id: 'product-1', label: 'Product 1' }],
            saveAsTag: true,
          },
        },
        ctx,
        { steps: [] },
      ),
    ).resolves.toMatchObject({
      output: { answer: 'Product 1', valid: true, tagId: 'tag-1', tagName: 'Product 1' },
    });

    expect(prisma.tag.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        name: 'Product 1',
        createdBy: 'workflow',
      },
    });
    expect(prisma.contactTag.upsert).toHaveBeenCalledWith({
      where: { contactId_tagId: { contactId: 'contact-1', tagId: 'tag-1' } },
      create: { contactId: 'contact-1', tagId: 'tag-1' },
      update: {},
    });
  });

  it('sends rating questions as five star-only quick replies', async () => {
    const { prisma, service } = createService();
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      lastMessage: { channelId: 'instagram-channel-1' },
    });

    await expect(
      service.handleAskQuestion(
        {
          id: 'ask-question-step',
          data: {
            questionText: 'Rate our support',
            questionType: 'rating',
          },
        },
        createContext(),
        { steps: [] },
      ),
    ).resolves.toEqual({
      output: { waiting: true, quickReplies: 5 },
      suspend: true,
    });

    expect(mockMessageProcessingQueueAdd).toHaveBeenCalledWith(
      'outbound.send_message',
      {
        kind: 'outbound.send_message',
        payload: {
          workspaceId: 'workspace-1',
          conversationId: 'conversation-1',
          channelId: 'instagram-channel-1',
          text: 'Rate our support',
          attachments: [],
          metadata: {
            quickReplies: [
              { title: '⭐', payload: '1' },
              { title: '⭐⭐', payload: '2' },
              { title: '⭐⭐⭐', payload: '3' },
              { title: '⭐⭐⭐⭐', payload: '4' },
              { title: '⭐⭐⭐⭐⭐', payload: '5' },
            ],
          },
        },
      },
    );
  });

  it('normalises star emoji rating replies to the numeric rating', async () => {
    const { service } = createService();
    const ctx = createContext();
    ctx.vars.lastAnswer = '⭐⭐⭐';
    ctx.vars.lastAnswerMessageId = 'message-3';

    await expect(
      service.handleAskQuestion(
        {
          id: 'ask-question-step',
          data: {
            questionText: 'Rate our support',
            questionType: 'rating',
            saveAsVariable: true,
            variableName: 'support_rating',
          },
        },
        ctx,
        { steps: [] },
      ),
    ).resolves.toMatchObject({
      output: { answer: '3', valid: true },
    });

    expect(ctx.vars.support_rating).toBe('3');
    expect(ctx.vars.lastAnswer).toBeUndefined();
  });
});

describe('WorkflowEngineService date/time routing', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-07T10:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('routes date-only ranges inclusively for the selected timezone', async () => {
    const { service } = createService();

    await expect(
      service.handleDateTime(
        {
          id: 'date-time-step',
          data: {
            mode: 'date_range',
            timezone: 'Asia/Kolkata',
            dateRangeStart: '2026-05-07',
            dateRangeEnd: '2026-05-07',
            connectors: ['in-range', 'out-of-range'],
          },
        },
        createContext(),
        {
          steps: [
            {
              id: 'in-range',
              type: 'branch_connector',
              parentId: 'date-time-step',
              name: 'Renamed success',
            },
            {
              id: 'out-of-range',
              type: 'branch_connector',
              parentId: 'date-time-step',
              name: 'Renamed failure',
            },
          ],
        },
      ),
    ).resolves.toMatchObject({
      output: {
        inRange: true,
        currentDate: '2026-05-07',
      },
      branchConnectorId: 'in-range',
    });
  });

  it('routes business hours to out-of-range when the current weekday is closed', async () => {
    const { service } = createService();

    await expect(
      service.handleDateTime(
        {
          id: 'date-time-step',
          data: {
            mode: 'business_hours',
            timezone: 'Asia/Kolkata',
            businessHours: {
              monday: {
                enabled: true,
                startTime: '09:00',
                endTime: '18:00',
              },
            },
            connectors: ['in-range', 'out-of-range'],
          },
        },
        createContext(),
        {
          steps: [
            {
              id: 'in-range',
              type: 'branch_connector',
              parentId: 'date-time-step',
              name: 'In Range',
            },
            {
              id: 'out-of-range',
              type: 'branch_connector',
              parentId: 'date-time-step',
              name: 'Out of Range',
            },
          ],
        },
      ),
    ).resolves.toMatchObject({
      output: {
        inRange: false,
        currentDay: 'thursday',
      },
      branchConnectorId: 'out-of-range',
    });
  });
});
