import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type WorkflowListOptions = {
    search?: string;
    status?: string;
    page?: number;
    limit?: number;
};

type WorkflowMutationDto = {
    name?: unknown;
    description?: unknown;
    config?: unknown;
};

type WorkflowStepPayload = {
    id: string;
    type: string;
    parentId: string;
};

@Injectable()
export class WorkflowsService {
    constructor(private prisma: PrismaService) { }

    async create(workspaceId: string, dto: WorkflowMutationDto, userId: string) {
        this.validateWorkflow(dto, { requireName: true });
        const name = this.getRequiredString(dto.name, 'Workflow name is required');
        const config =
            dto.config === undefined ? null : (dto.config as Prisma.InputJsonValue);

        return this.prisma.workflow.create({
            data: {
                workspaceId,
                createBy: userId,
                name,
                description: typeof dto.description === 'string' ? dto.description : undefined,
                config,
                status: "draft"
            },
        });
    }

    async update(workspaceId: string, id: string, dto: WorkflowMutationDto) {
        const workflow = await this.prisma.workflow.findFirst({
            where: { id, workspaceId },
        });

        if (!workflow) {
            throw new NotFoundException('Workflow not found');
        }

        this.validateWorkflow(dto);
        const data: Prisma.WorkflowUpdateInput = {};

        if (dto.config !== undefined) {
            data.config = dto.config as Prisma.InputJsonValue;
        }

        if (dto.name !== undefined) {
            data.name = this.getRequiredString(dto.name, 'Workflow name is required');
        }

        if (dto.description !== undefined) {
            data.description =
                typeof dto.description === 'string' && dto.description.trim().length > 0
                    ? dto.description.trim()
                    : null;
        }

        return this.prisma.workflow.update({
            where: { id },
            data,
        });
    }
    async rename(workspaceId: string, id: string, dto: any) {
        const workflow = await this.prisma.workflow.findFirst({
            where: { id, workspaceId },
        });
        if (!workflow) {
            throw new NotFoundException('Workflow not found');
        }
        return await this.prisma.workflow.update({
            where: { id },
            data: { name: dto.name },
        });
    }

    async publish(workspaceId: string, id: string, userId: string) {
        const workflow = await this.prisma.workflow.findFirst({
            where: { id, workspaceId },
        });

        if (!workflow) {
            throw new NotFoundException('Workflow not found');
        }

        this.validateWorkflow({ config: workflow.config });

        return this.prisma.workflow.update({
            where: { id },
            data: {
                status: "published",
                publishedAt: new Date(),
                publishedBy: userId,
            },
        });
    }

    async stop(workspaceId: string, id: string) {
        return this.prisma.workflow.update({
            where: { id },
            data: { status: "stopped" },
        });
    }
    async clone(workspaceId: string, id: string, dto: { name?: string }, userId: string) {
        const workflow = await this.prisma.workflow.findFirst({
            where: { id, workspaceId },
        });
        
        if (!workflow) {
            throw new NotFoundException('Workflow not found');
        }

        return await this.prisma.workflow.create({
            data: {
                workspaceId,    
                createBy: userId,
                name: dto.name || workflow.name + ' (Clone)',
                config: workflow.config,        
                status: "draft"
            },
        });
    }

    async delete(workspaceId: string, id: string) {
        const workflow = await this.prisma.workflow.findFirst({
            where: { id, workspaceId },
        });

        if (!workflow) {
            throw new NotFoundException('Workflow not found');
        }

        return this.prisma.workflow.delete({
            where: { id },
        });
    }

    async list(
        workspaceId: string,
        opts?: WorkflowListOptions,
    ) {
        const where: Prisma.WorkflowWhereInput = {
            workspaceId,
            ...(opts?.status && opts.status !== 'all' ? { status: opts.status } : {}),
            ...(opts?.search?.trim()
                ? {
                    OR: [
                        { name: { contains: opts.search.trim(), mode: 'insensitive' } },
                        { description: { contains: opts.search.trim(), mode: 'insensitive' } },
                    ],
                }
                : {}),
        };

        const hasPagination =
            typeof opts?.page === 'number' || typeof opts?.limit === 'number';

        if (!hasPagination) {
            return this.prisma.workflow.findMany({
                where,
                orderBy: { createdAt: 'desc' },
            });
        }

        const page = Math.max(1, opts?.page ?? 1);
        const limit = Math.min(Math.max(1, opts?.limit ?? 10), 100);
        const [items, total] = await this.prisma.$transaction([
            this.prisma.workflow.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.workflow.count({ where }),
        ]);

        return {
            items,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                hasNextPage: page * limit < total,
                hasPrevPage: page > 1,
            },
        };
    }

    async get(workspaceId: string, id: string) {
        const workflow = await this.prisma.workflow.findFirst({
            where: { id, workspaceId },
        });
        if (!workflow) {
            throw new NotFoundException('Workflow not found');
        }
        return workflow;
    }

    private validateWorkflow(
        dto: WorkflowMutationDto,
        options: { requireName?: boolean } = {},
    ) {
        if (options.requireName && !this.isNonEmptyString(dto.name)) {
            throw new BadRequestException('Workflow name is required');
        }

        if (!options.requireName && dto.name !== undefined && !this.isNonEmptyString(dto.name)) {
            throw new BadRequestException('Workflow name is required');
        }

        this.validateWorkflowConfig(dto.config);
    }

    private validateWorkflowConfig(config: unknown) {
        if (config === undefined || config === null) {
            return;
        }

        if (!this.isRecord(config)) {
            throw new BadRequestException('Workflow config must be an object');
        }

        const stepsValue = config.steps;
        if (stepsValue === undefined || stepsValue === null) {
            return;
        }

        if (!Array.isArray(stepsValue)) {
            throw new BadRequestException('Workflow config steps must be an array');
        }

        const steps = stepsValue.map((step, index) =>
            this.parseWorkflowStep(step, index),
        );
        const stepIds = new Set<string>();

        for (const step of steps) {
            if (stepIds.has(step.id)) {
                throw new BadRequestException(`Duplicate workflow step id: ${step.id}`);
            }
            stepIds.add(step.id);
        }

        const childrenByParent = new Map<string, WorkflowStepPayload[]>();

        for (const step of steps) {
            if (step.parentId !== 'trigger' && !stepIds.has(step.parentId)) {
                throw new BadRequestException(
                    `Workflow step ${step.id} references missing parent ${step.parentId}`,
                );
            }

            const children = childrenByParent.get(step.parentId) ?? [];
            children.push(step);
            childrenByParent.set(step.parentId, children);
        }

        const reachableIds = new Set<string>();
        const stack = [...(childrenByParent.get('trigger') ?? [])];

        while (stack.length > 0) {
            const step = stack.pop();
            if (!step || reachableIds.has(step.id)) continue;

            reachableIds.add(step.id);
            stack.push(...(childrenByParent.get(step.id) ?? []));
        }

        const unreachableSteps = steps.filter((step) => !reachableIds.has(step.id));
        if (unreachableSteps.length > 0) {
            throw new BadRequestException(
                `Workflow contains unreachable steps: ${unreachableSteps
                    .map((step) => step.id)
                    .join(', ')}`,
            );
        }
    }

    private parseWorkflowStep(step: unknown, index: number): WorkflowStepPayload {
        if (!this.isRecord(step)) {
            throw new BadRequestException(`Workflow step at index ${index} must be an object`);
        }

        if (!this.isNonEmptyString(step.id)) {
            throw new BadRequestException(`Workflow step at index ${index} is missing id`);
        }

        if (!this.isNonEmptyString(step.type)) {
            throw new BadRequestException(`Workflow step ${step.id} is missing type`);
        }

        if (!this.isNonEmptyString(step.parentId)) {
            throw new BadRequestException(`Workflow step ${step.id} is missing parentId`);
        }

        return {
            id: step.id,
            type: step.type,
            parentId: step.parentId,
        };
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private isNonEmptyString(value: unknown): value is string {
        return typeof value === 'string' && value.trim().length > 0;
    }

    private getRequiredString(value: unknown, message: string): string {
        if (!this.isNonEmptyString(value)) {
            throw new BadRequestException(message);
        }

        return value;
    }
}
