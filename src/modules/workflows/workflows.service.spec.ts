import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiGatewayService } from '../ai-agents/gateway/ai-gateway.service';
import { WorkflowsService } from './workflows.service';

type WorkflowDelegateMock = {
    findFirst: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
};

type PrismaMock = {
    workflow: WorkflowDelegateMock;
    $transaction: jest.Mock;
};

type AiGatewayMock = {
    completeJson: jest.Mock;
};

function createPrismaMock(): PrismaMock {
    return {
        workflow: {
            findFirst: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            delete: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
        },
        $transaction: jest.fn(),
    };
}

function createService(aiGateway?: AiGatewayMock) {
    const prisma = createPrismaMock();
    const service = new WorkflowsService(
        prisma as unknown as PrismaService,
        aiGateway as unknown as AiGatewayService,
    );

    return { prisma, service };
}

function createValidConfig() {
    return {
        trigger: {
            type: 'conversation_opened',
            data: { sources: [] },
            conditions: [],
            advancedSettings: { triggerOncePerContact: false },
        },
        steps: [
            {
                id: 'step-1',
                type: 'assign_to',
                name: 'Assign',
                parentId: 'trigger',
                data: {},
                position: { x: 0, y: 0 },
            },
            {
                id: 'step-2',
                type: 'add_comment',
                name: 'Comment',
                parentId: 'step-1',
                data: { comment: 'Done' },
                position: { x: 0, y: 0 },
            },
        ],
        settings: {
            allowStopForContact: false,
            exitOnIncomingMessage: false,
            exitOnOutgoingMessage: false,
            exitOnManualAssignment: false,
        },
    };
}

describe('WorkflowsService', () => {
    describe('AI builder', () => {
        const originalWorkflowAiBuilderEnabled = process.env.WORKFLOW_AI_BUILDER_ENABLED;

        beforeEach(() => {
            delete process.env.WORKFLOW_AI_BUILDER_ENABLED;
        });

        afterEach(() => {
            if (originalWorkflowAiBuilderEnabled === undefined) {
                delete process.env.WORKFLOW_AI_BUILDER_ENABLED;
            } else {
                process.env.WORKFLOW_AI_BUILDER_ENABLED = originalWorkflowAiBuilderEnabled;
            }
        });

        it('keeps the workflow AI builder disabled unless the env flag is enabled', async () => {
            const { service } = createService({
                completeJson: jest.fn(),
            });

            expect(() => service.getAiBuilderContext()).toThrow(NotFoundException);
            await expect(
                service.buildWithAi('workspace-1', 'workflow-1', {
                    message: 'Build a rating flow',
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('exposes the workflow AI builder source of truth', () => {
            process.env.WORKFLOW_AI_BUILDER_ENABLED = 'true';
            const { service } = createService();

            expect(service.getAiBuilderContext()).toEqual(
                expect.objectContaining({
                    systemPrompt: expect.stringContaining('AxoDesk Workflow Builder AI'),
                    context: expect.objectContaining({
                        feature: 'workflow_build_with_ai',
                        steps: expect.arrayContaining([
                            expect.objectContaining({ type: 'trigger_another_workflow' }),
                            expect.objectContaining({ type: 'ask_question' }),
                        ]),
                    }),
                }),
            );
        });

        it('uses the AI gateway with sanitized workflow builder context', async () => {
            process.env.WORKFLOW_AI_BUILDER_ENABLED = 'true';
            const aiGateway: AiGatewayMock = {
                completeJson: jest.fn().mockResolvedValue({
                    data: {
                        mode: 'clarify',
                        assistantMessage: 'Which channel should I use?',
                        questions: ['Which channel should I use?'],
                        suggestions: [],
                        warnings: [],
                        confidence: 0.7,
                    },
                    raw: {
                        provider: 'mistral',
                        model: 'mistral-small-latest',
                        latencyMs: 42,
                    },
                }),
            };
            const { prisma, service } = createService(aiGateway);
            prisma.workflow.findFirst.mockResolvedValue({
                id: 'workflow-1',
                name: 'Lead follow up',
                description: null,
                status: 'draft',
                config: createValidConfig(),
            });

            await expect(
                service.buildWithAi('workspace-1', 'workflow-1', {
                    message: 'Build a rating flow',
                    workspaceFacts: {
                        channels: [{ id: 'channel-1', name: 'Instagram' }],
                        apiKey: 'secret-value',
                    },
                }),
            ).resolves.toEqual(
                expect.objectContaining({
                    mode: 'clarify',
                    contextVersion: expect.any(String),
                    model: {
                        provider: 'mistral',
                        name: 'mistral-small-latest',
                        latencyMs: 42,
                    },
                }),
            );
            expect(aiGateway.completeJson).toHaveBeenCalledWith(
                expect.objectContaining({
                    workspaceId: 'workspace-1',
                    operation: 'decision',
                    metadata: expect.objectContaining({
                        feature: 'workflow_ai_builder',
                        workflowId: 'workflow-1',
                    }),
                }),
            );
            const messages = aiGateway.completeJson.mock.calls[0][0].messages;
            expect(JSON.stringify(messages)).not.toContain('secret-value');
            expect(JSON.stringify(messages)).not.toContain('apiKey');
            expect(aiGateway.completeJson).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: 'mistral-small-latest',
                    maxTokens: 2200,
                    timeoutMs: expect.any(Number),
                }),
            );
        });
    });

    describe('update', () => {
        it('rejects steps that reference a missing parent', async () => {
            const { prisma, service } = createService();
            prisma.workflow.findFirst.mockResolvedValue({
                id: 'workflow-1',
                workspaceId: 'workspace-1',
            });

            const config = createValidConfig();
            config.steps[1].parentId = 'missing-step';

            await expect(
                service.update('workspace-1', 'workflow-1', { config }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(prisma.workflow.update).not.toHaveBeenCalled();
        });

        it('saves a workflow with a connected step chain', async () => {
            const { prisma, service } = createService();
            const config = createValidConfig();
            prisma.workflow.findFirst.mockResolvedValue({
                id: 'workflow-1',
                workspaceId: 'workspace-1',
            });
            prisma.workflow.update.mockResolvedValue({
                id: 'workflow-1',
                config,
            });

            await expect(
                service.update('workspace-1', 'workflow-1', { config }),
            ).resolves.toEqual({ id: 'workflow-1', config });
            expect(prisma.workflow.update).toHaveBeenCalledWith({
                where: { id: 'workflow-1' },
                data: { config },
            });
        });

        it('persists workflow name changes from the builder save endpoint', async () => {
            const { prisma, service } = createService();
            const config = createValidConfig();
            prisma.workflow.findFirst.mockResolvedValue({
                id: 'workflow-1',
                workspaceId: 'workspace-1',
            });
            prisma.workflow.update.mockResolvedValue({
                id: 'workflow-1',
                name: 'Renamed workflow',
                description: null,
                config,
            });

            await expect(
                service.update('workspace-1', 'workflow-1', {
                    name: 'Renamed workflow',
                    description: '',
                    config,
                }),
            ).resolves.toEqual({
                id: 'workflow-1',
                name: 'Renamed workflow',
                description: null,
                config,
            });
            expect(prisma.workflow.update).toHaveBeenCalledWith({
                where: { id: 'workflow-1' },
                data: {
                    name: 'Renamed workflow',
                    description: null,
                    config,
                },
            });
        });

        it('rejects blank workflow names', async () => {
            const { prisma, service } = createService();
            prisma.workflow.findFirst.mockResolvedValue({
                id: 'workflow-1',
                workspaceId: 'workspace-1',
            });

            await expect(
                service.update('workspace-1', 'workflow-1', { name: '   ' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(prisma.workflow.update).not.toHaveBeenCalled();
        });
    });

    describe('publish', () => {
        it('rejects a saved workflow with orphaned steps', async () => {
            const { prisma, service } = createService();
            const config = createValidConfig();
            config.steps[1].parentId = 'missing-step';
            prisma.workflow.findFirst.mockResolvedValue({
                id: 'workflow-1',
                workspaceId: 'workspace-1',
                config,
            });

            await expect(
                service.publish('workspace-1', 'workflow-1', 'user-1'),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(prisma.workflow.update).not.toHaveBeenCalled();
        });
    });
});
