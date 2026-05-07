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
  findUnique: jest.Mock;
  updateMany: jest.Mock;
};

type PrismaMock = {
  contact: ContactDelegateMock;
  contactChannel: { findFirst: jest.Mock };
  conversation: { findFirst: jest.Mock };
  workflow: { findUnique: jest.Mock };
  workflowRun: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

type RedisMock = {
  getJSON: jest.Mock;
  client: {
    del: jest.Mock;
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
  handleSendMessage(
    step: {
      id?: string;
      type?: string;
      data: {
        channel?: string;
        defaultMessage?: { text?: string };
        attachments?: Array<Record<string, unknown>>;
        metadata?: Record<string, unknown>;
      };
    },
    ctx: WorkflowRunContext,
  ): Promise<{ output: Record<string, unknown> }>;
  handleAskQuestion(
    step: {
      id: string;
      data: {
        questionText: string;
        questionType: string;
        multipleChoiceOptions?: Array<{ id: string; label: string }>;
        saveAsVariable?: boolean;
        variableName?: string;
      };
    },
    ctx: WorkflowRunContext,
    config: { steps: unknown[] },
  ): Promise<{ output: Record<string, unknown>; suspend?: boolean; branchConnectorId?: string | null }>;
};

function createService(activity?: ActivityMock) {
  const prisma: PrismaMock = {
    contact: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    contactChannel: {
      findFirst: jest.fn(),
    },
    conversation: {
      findFirst: jest.fn(),
    },
    workflow: {
      findUnique: jest.fn(),
    },
    workflowRun: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const redis: RedisMock = {
    getJSON: jest.fn(),
    client: {
      del: jest.fn(),
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
    prisma.workflow.findUnique.mockResolvedValue({
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
