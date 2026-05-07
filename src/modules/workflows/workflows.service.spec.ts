import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
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

function createService() {
    const prisma = createPrismaMock();
    const service = new WorkflowsService(prisma as unknown as PrismaService);

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
