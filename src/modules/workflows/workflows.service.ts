import {
    Injectable,
    NotFoundException,
    BadRequestException,
    Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiGatewayService, type AiGatewayMessage } from '../ai-agents/gateway/ai-gateway.service';
import {
    getWorkflowAiBuilderPromptPayload,
    getWorkflowAiBuilderRuntimePromptPayload,
    type WorkflowAiBuilderResponse,
} from './workflow-ai-builder.context';
import {
    assertWorkflowDeliveryForPublish,
    type WorkflowConfigLike,
} from './workflow-delivery-rulebook';

type WorkflowListOptions = {
    search?: string;
    status?: string;
    page?: number;
    limit?: number;
};

type WorkflowRunListOptions = {
    workflowId?: string;
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

type WorkflowAiBuilderChatDto = {
    message?: unknown;
    history?: unknown;
    currentConfig?: unknown;
    workspaceFacts?: unknown;
};

type WorkflowAiBuilderHistoryMessage = {
    role: 'user' | 'assistant';
    content: string;
};

type WorkflowStepPayload = {
    id: string;
    type: string;
    parentId: string;
};

type WorkflowConfigStepMetadata = {
    id: string;
    type: string;
    name: string;
};

type WorkflowRunContactSummary = {
    id: string;
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    avatarUrl: string | null;
};

type WorkflowRunRecord = Prisma.WorkflowRunGetPayload<{
    include: {
        workflow: {
            select: {
                id: true;
                name: true;
                status: true;
                config: true;
            };
        };
        steps: {
            select: {
                id: true;
                stepId: true;
                stepType: true;
                status: true;
                input: true;
                output: true;
                error: true;
                attempts: true;
                startedAt: true;
                completedAt: true;
            };
        };
    };
}>;

const ENABLED_ENV_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const WORKFLOW_RUN_STATUSES = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class WorkflowsService {
    constructor(
        private prisma: PrismaService,
        @Optional() private readonly aiGateway?: AiGatewayService,
    ) { }

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
        await this.validateWorkflowDeliveryForPublish(workspaceId, workflow.config);

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

    async listRuns(workspaceId: string, opts?: WorkflowRunListOptions) {
        const page = Math.max(1, opts?.page ?? 1);
        const limit = Math.min(Math.max(1, opts?.limit ?? 12), 50);
        const status = this.normalizeWorkflowRunStatus(opts?.status);
        const workflowId = this.normalizeOptionalUuid(opts?.workflowId, 'Workflow ID');
        const search = opts?.search?.trim();
        const searchedContactIds = search
            ? await this.findWorkflowRunContactSearchIds(workspaceId, search)
            : [];
        const baseOpts = { workflowId, search, searchedContactIds };
        const where = this.buildWorkflowRunWhere(workspaceId, { ...baseOpts, status });
        const summaryWhere = this.buildWorkflowRunWhere(workspaceId, baseOpts);

        const statusCountKeys = ['running', 'waiting', 'completed', 'failed', 'cancelled'] as const;
        const [runs, total, ...statusCountValues] = await this.prisma.$transaction([
            this.prisma.workflowRun.findMany({
                where,
                orderBy: { startedAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    workflow: {
                        select: {
                            id: true,
                            name: true,
                            status: true,
                            config: true,
                        },
                    },
                    steps: {
                        orderBy: [{ startedAt: 'asc' }, { completedAt: 'asc' }],
                        select: {
                            id: true,
                            stepId: true,
                            stepType: true,
                            status: true,
                            input: true,
                            output: true,
                            error: true,
                            attempts: true,
                            startedAt: true,
                            completedAt: true,
                        },
                    },
                },
            }),
            this.prisma.workflowRun.count({ where }),
            ...statusCountKeys.map((runStatus) =>
                this.prisma.workflowRun.count({
                    where: { ...summaryWhere, status: runStatus },
                }),
            ),
        ]);
        const statusCounts = Object.fromEntries(
            statusCountKeys.map((runStatus, index) => [runStatus, statusCountValues[index] ?? 0]),
        ) as Record<(typeof statusCountKeys)[number], number>;

        const contactsById = await this.loadWorkflowRunContacts(
            workspaceId,
            runs.map((run) => run.contactId),
        );

        return {
            items: runs.map((run) => this.toWorkflowRunDto(run, contactsById.get(run.contactId))),
            summary: this.buildWorkflowRunSummary(statusCounts),
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

    async getRun(workspaceId: string, runId: string) {
        const normalizedRunId = this.normalizeOptionalUuid(runId, 'Run ID');
        if (!normalizedRunId) {
            throw new BadRequestException('Run ID is required');
        }

        const run = await this.prisma.workflowRun.findFirst({
            where: { id: normalizedRunId, workspaceId },
            include: {
                workflow: {
                    select: {
                        id: true,
                        name: true,
                        status: true,
                        config: true,
                    },
                },
                steps: {
                    orderBy: [{ startedAt: 'asc' }, { completedAt: 'asc' }],
                    select: {
                        id: true,
                        stepId: true,
                        stepType: true,
                        status: true,
                        input: true,
                        output: true,
                        error: true,
                        attempts: true,
                        startedAt: true,
                        completedAt: true,
                    },
                },
            },
        });

        if (!run) {
            throw new NotFoundException('Workflow run not found');
        }

        const contactsById = await this.loadWorkflowRunContacts(workspaceId, [run.contactId]);
        return this.toWorkflowRunDto(run, contactsById.get(run.contactId), { detail: true });
    }

    getAiBuilderContext() {
        this.assertAiBuilderEnabled();
        return getWorkflowAiBuilderPromptPayload();
    }

    async buildWithAi(workspaceId: string, id: string, dto: WorkflowAiBuilderChatDto) {
        this.assertAiBuilderEnabled();

        if (!this.aiGateway) {
            throw new BadRequestException('Workflow AI builder is not configured');
        }

        const workflow = await this.prisma.workflow.findFirst({
            where: { id, workspaceId },
        });
        if (!workflow) {
            throw new NotFoundException('Workflow not found');
        }

        const message = this.getRequiredString(dto.message, 'Message is required');
        const promptPayload = getWorkflowAiBuilderRuntimePromptPayload();
        const currentConfig = this.isRecord(dto.currentConfig)
            ? dto.currentConfig
            : workflow.config;
        const history = this.parseAiBuilderHistory(dto.history);
        const requestContext = {
            userRequest: message,
            currentWorkflow: {
                id: workflow.id,
                name: workflow.name,
                description: workflow.description,
                status: workflow.status,
                config: currentConfig,
            },
            workspaceFacts: this.compactWorkspaceFactsForAi(dto.workspaceFacts),
        };

        const messages: AiGatewayMessage[] = [
            { role: 'system', content: promptPayload.systemPrompt },
            {
                role: 'system',
                content: `Workflow builder source of truth:\n${JSON.stringify({
                    context: promptPayload.context,
                    responseSchema: promptPayload.responseSchema,
                })}`,
            },
            ...history,
            {
                role: 'user',
                content: JSON.stringify(requestContext),
            },
        ];

        const result = await this.aiGateway.completeJson<WorkflowAiBuilderResponse>({
            workspaceId,
            operation: 'decision',
            messages,
            temperature: 0.2,
            maxTokens: 2200,
            timeoutMs: Number(process.env.WORKFLOW_AI_BUILDER_TIMEOUT_MS || 60_000),
            model: process.env.WORKFLOW_AI_BUILDER_MODEL || process.env.MISTRAL_FAST_MODEL || 'mistral-small-latest',
            metadata: {
                feature: 'workflow_ai_builder',
                workflowId: id,
                contextVersion: promptPayload.context.version,
            },
        });

        return {
            ...result.data,
            contextVersion: promptPayload.context.version,
            model: {
                provider: result.raw.provider,
                name: result.raw.model,
                latencyMs: result.raw.latencyMs,
            },
        };
    }

    private normalizeWorkflowRunStatus(status?: string) {
        if (!status || status === 'all') return undefined;
        const normalized = status.trim().toLowerCase();
        if (!WORKFLOW_RUN_STATUSES.has(normalized)) {
            throw new BadRequestException('Unsupported workflow run status');
        }
        return normalized;
    }

    private normalizeOptionalUuid(value: unknown, label: string) {
        if (value === undefined || value === null || value === '') return undefined;
        if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
            throw new BadRequestException(`${label} must be a valid UUID`);
        }
        return value.trim();
    }

    private async findWorkflowRunContactSearchIds(workspaceId: string, search: string) {
        const term = search.trim();
        if (!term) return [];

        const contacts = await this.prisma.contact.findMany({
            where: {
                workspaceId,
                OR: [
                    { firstName: { contains: term, mode: 'insensitive' } },
                    { lastName: { contains: term, mode: 'insensitive' } },
                    { email: { contains: term, mode: 'insensitive' } },
                    { phone: { contains: term, mode: 'insensitive' } },
                    { company: { contains: term, mode: 'insensitive' } },
                ],
            },
            select: { id: true },
            take: 100,
        });

        return contacts.map((contact) => contact.id);
    }

    private buildWorkflowRunWhere(
        workspaceId: string,
        opts: {
            workflowId?: string;
            status?: string;
            search?: string;
            searchedContactIds?: string[];
        },
    ): Prisma.WorkflowRunWhereInput {
        const where: Prisma.WorkflowRunWhereInput = {
            workspaceId,
            ...(opts.workflowId ? { workflowId: opts.workflowId } : {}),
            ...(opts.status ? { status: opts.status } : {}),
        };

        const search = opts.search?.trim();
        if (!search) return where;

        const searchOr: Prisma.WorkflowRunWhereInput[] = [
            { workflow: { name: { contains: search, mode: 'insensitive' } } },
            { error: { contains: search, mode: 'insensitive' } },
        ];

        if (UUID_RE.test(search)) {
            searchOr.push({ id: search }, { workflowId: search }, { contactId: search });
        }

        if (opts.searchedContactIds?.length) {
            searchOr.push({ contactId: { in: opts.searchedContactIds } });
        }

        return {
            ...where,
            OR: searchOr,
        };
    }

    private async loadWorkflowRunContacts(workspaceId: string, contactIds: string[]) {
        const uniqueIds = [...new Set(contactIds.filter(Boolean))];
        if (uniqueIds.length === 0) return new Map<string, WorkflowRunContactSummary>();

        const contacts = await this.prisma.contact.findMany({
            where: {
                workspaceId,
                id: { in: uniqueIds },
            },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                company: true,
                avatarUrl: true,
            },
        });

        return new Map(contacts.map((contact) => [contact.id, contact]));
    }

    private buildWorkflowRunSummary(
        statusCounts: Record<'running' | 'waiting' | 'completed' | 'failed' | 'cancelled', number>,
    ) {
        const counts = {
            total: Object.values(statusCounts).reduce((sum, count) => sum + count, 0),
            running: statusCounts.running,
            waiting: statusCounts.waiting,
            completed: statusCounts.completed,
            failed: statusCounts.failed,
            cancelled: statusCounts.cancelled,
        };

        return {
            ...counts,
            active: counts.running + counts.waiting,
            attention: counts.failed + counts.waiting,
            successRate:
                counts.completed + counts.failed > 0
                    ? Math.round((counts.completed / (counts.completed + counts.failed)) * 100)
                    : null,
        };
    }

    private toWorkflowRunDto(
        run: WorkflowRunRecord,
        contact?: WorkflowRunContactSummary,
        opts: { detail?: boolean } = {},
    ) {
        const stepMetadata = this.getWorkflowStepMetadata(run.workflow.config);
        const stepEvents = run.steps.map((step) =>
            this.toWorkflowRunStepDto(step, stepMetadata, opts),
        );
        const currentStep = run.currentStepId
            ? stepMetadata.get(run.currentStepId)
            : undefined;
        const lastStep = [...stepEvents]
            .reverse()
            .find((step) => step.type !== 'branch_connector');
        const totalSteps = Math.max(
            1,
            [...stepMetadata.values()].filter((step) => step.type !== 'branch_connector').length,
        );
        const completedSteps = new Set(
            stepEvents
                .filter((step) => step.type !== 'branch_connector' && step.status === 'completed')
                .map((step) => step.stepId),
        ).size;
        const failedSteps = stepEvents.filter(
            (step) => step.type !== 'branch_connector' && step.status === 'failed',
        ).length;
        const runningSteps = stepEvents.filter(
            (step) => step.type !== 'branch_connector' && step.status === 'running',
        ).length;
        const executedSteps = Math.min(totalSteps, completedSteps + failedSteps + runningSteps);
        const contactName = this.formatRunContactName(contact);

        return {
            id: run.id,
            workflowId: run.workflowId,
            workflowName: run.workflow.name,
            workflowStatus: run.workflow.status,
            contactId: run.contactId,
            contact: contact
                ? {
                    ...contact,
                    name: contactName,
                }
                : {
                    id: run.contactId,
                    name: 'Unknown contact',
                    firstName: '',
                    lastName: null,
                    email: null,
                    phone: null,
                    company: null,
                    avatarUrl: null,
                },
            status: run.status,
            currentStepId: run.currentStepId,
            currentStepName: currentStep?.name ?? lastStep?.name ?? null,
            currentStepType: currentStep?.type ?? lastStep?.type ?? null,
            trigger: this.describeWorkflowRunTrigger(run.workflow.config, run.triggerData),
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            failedAt: run.failedAt,
            error: run.error,
            durationMs: this.getWorkflowRunDurationMs(run),
            progress: {
                completed: completedSteps,
                failed: failedSteps,
                running: runningSteps,
                pending: Math.max(0, totalSteps - executedSteps),
                total: totalSteps,
                percent: Math.min(100, Math.round((executedSteps / totalSteps) * 100)),
            },
            stepTrail: stepEvents.slice(-6),
            steps: opts.detail ? stepEvents : undefined,
            triggerData: opts.detail ? this.sanitizeWorkflowRunValue(run.triggerData) : undefined,
            variables: opts.detail ? this.sanitizeWorkflowRunValue(run.variables) : undefined,
        };
    }

    private toWorkflowRunStepDto(
        step: WorkflowRunRecord['steps'][number],
        stepMetadata: Map<string, WorkflowConfigStepMetadata>,
        opts: { detail?: boolean },
    ) {
        const metadata = stepMetadata.get(step.stepId);

        return {
            id: step.id,
            stepId: step.stepId,
            name: metadata?.name ?? this.humanizeStepType(step.stepType),
            type: metadata?.type ?? step.stepType,
            status: step.status,
            attempts: step.attempts,
            startedAt: step.startedAt,
            completedAt: step.completedAt,
            durationMs: this.getStepDurationMs(step.startedAt, step.completedAt),
            error: step.error,
            input: opts.detail ? this.sanitizeWorkflowRunValue(step.input) : undefined,
            output: opts.detail ? this.sanitizeWorkflowRunValue(step.output) : undefined,
        };
    }

    private getWorkflowStepMetadata(config: Prisma.JsonValue | null): Map<string, WorkflowConfigStepMetadata> {
        const map = new Map<string, WorkflowConfigStepMetadata>();
        if (!this.isRecord(config) || !Array.isArray(config.steps)) return map;

        for (const step of config.steps) {
            if (!this.isRecord(step) || !this.isNonEmptyString(step.id) || !this.isNonEmptyString(step.type)) {
                continue;
            }
            const name = this.isNonEmptyString(step.name)
                ? step.name
                : this.humanizeStepType(step.type);
            map.set(step.id, {
                id: step.id,
                type: step.type,
                name,
            });
        }

        return map;
    }

    private describeWorkflowRunTrigger(config: Prisma.JsonValue | null, triggerData: Prisma.JsonValue | null) {
        const triggerType =
            this.isRecord(config) &&
            this.isRecord(config.trigger) &&
            typeof config.trigger.type === 'string'
                ? config.trigger.type
                : 'workflow';
        const data = this.isRecord(triggerData) ? triggerData : {};
        const event =
            this.stringFromUnknown(data.topic) ??
            this.stringFromUnknown(data.event) ??
            this.stringFromUnknown(data.type) ??
            this.humanizeStepType(triggerType);
        const reference =
            this.stringFromUnknown(data.name) ??
            this.stringFromUnknown(data.orderName) ??
            this.stringFromUnknown(data.orderId) ??
            this.stringFromUnknown(data.externalOrderId) ??
            this.stringFromUnknown(data.messageText);

        return {
            type: triggerType,
            label: this.humanizeStepType(triggerType),
            event,
            reference: reference ? reference.slice(0, 120) : null,
        };
    }

    private formatRunContactName(contact?: WorkflowRunContactSummary) {
        if (!contact) return 'Unknown contact';
        return [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || 'Unnamed contact';
    }

    private getWorkflowRunDurationMs(run: WorkflowRunRecord) {
        const end = run.completedAt ?? run.failedAt ?? new Date();
        return Math.max(0, end.getTime() - run.startedAt.getTime());
    }

    private getStepDurationMs(startedAt: Date | null, completedAt: Date | null) {
        if (!startedAt) return null;
        const end = completedAt ?? new Date();
        return Math.max(0, end.getTime() - startedAt.getTime());
    }

    private humanizeStepType(value: string) {
        return value
            .replace(/[._-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, (match) => match.toUpperCase());
    }

    private stringFromUnknown(value: unknown) {
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    }

    private sanitizeWorkflowRunValue(value: unknown, depth = 0): unknown {
        if (depth > 4) return '[omitted]';
        if (value === null || value === undefined) return value ?? null;

        if (typeof value === 'string') {
            return value.length > 800 ? `${value.slice(0, 800)}...` : value;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }

        if (Array.isArray(value)) {
            return value.slice(0, 30).map((item) => this.sanitizeWorkflowRunValue(item, depth + 1));
        }

        if (!this.isRecord(value)) {
            return String(value);
        }

        const sanitized: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value).slice(0, 50)) {
            sanitized[key] = this.isSensitiveAiBuilderKey(key)
                ? '[redacted]'
                : this.sanitizeWorkflowRunValue(item, depth + 1);
        }
        return sanitized;
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

    private async validateWorkflowDeliveryForPublish(
        workspaceId: string,
        config: Prisma.JsonValue | null,
    ) {
        if (!this.isRecord(config)) return;

        const channels = await this.prisma.channel.findMany({
            where: { workspaceId },
            select: { id: true, type: true, status: true },
        });

        assertWorkflowDeliveryForPublish(
            config as unknown as WorkflowConfigLike,
            channels,
        );
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

    private parseAiBuilderHistory(value: unknown): WorkflowAiBuilderHistoryMessage[] {
        if (!Array.isArray(value)) return [];

        return value
            .slice(-6)
            .map((message): WorkflowAiBuilderHistoryMessage | null => {
                if (!this.isRecord(message)) return null;
                const role = message.role;
                const content = message.content;

                if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
                    return null;
                }

                return {
                    role,
                    content: content.slice(0, 1200),
                };
            })
            .filter((message): message is WorkflowAiBuilderHistoryMessage => message !== null);
    }

    private compactWorkspaceFactsForAi(value: unknown) {
        const facts = this.isRecord(value) ? value : {};
        return this.sanitizeAiBuilderInput({
            channels: this.compactAiFactList(facts.channels, ['id', 'type', 'name', 'status']),
            tags: this.compactAiFactList(facts.tags, ['id', 'value', 'name', 'label', 'color', 'emoji']),
            users: this.compactAiFactList(facts.users, ['id', 'userId', 'name', 'label', 'email', 'availability']),
            teams: this.compactAiFactList(facts.teams, ['id', 'name']),
            lifecycleStages: this.compactAiFactList(facts.lifecycleStages, ['id', 'name', 'label']),
            existingWorkflows: this.compactAiFactList(facts.existingWorkflows, ['id', 'name', 'status']),
            selectedNodeId: facts.selectedNodeId,
            selectedStep: this.compactWorkflowStepForAi(facts.selectedStep),
            validationWarnings: this.compactAiFactList(facts.validationWarnings, ['nodeId', 'title', 'message']),
        });
    }

    private compactAiFactList(value: unknown, allowedKeys: string[]) {
        if (!Array.isArray(value)) return [];
        return value.slice(0, 30).map((item) => {
            if (!this.isRecord(item)) return item;
            const compact: Record<string, unknown> = {};
            for (const key of allowedKeys) {
                if (item[key] !== undefined) compact[key] = item[key];
            }
            return compact;
        });
    }

    private compactWorkflowStepForAi(value: unknown) {
        if (!this.isRecord(value)) return null;
        return {
            id: value.id,
            type: value.type,
            name: value.name,
            parentId: value.parentId,
            data: value.data,
        };
    }

    private sanitizeAiBuilderInput(value: unknown, depth = 0): unknown {
        if (depth > 3) return '[omitted]';
        if (value === null) return null;

        if (typeof value === 'string') {
            return value.slice(0, 500);
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }

        if (Array.isArray(value)) {
            return value
                .slice(0, 30)
                .map((item) => this.sanitizeAiBuilderInput(item, depth + 1));
        }

        if (!this.isRecord(value)) {
            return undefined;
        }

        const sanitized: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value).slice(0, 40)) {
            if (this.isSensitiveAiBuilderKey(key)) {
                sanitized[key] = '[redacted]';
                continue;
            }
            sanitized[key] = this.sanitizeAiBuilderInput(item, depth + 1);
        }

        return sanitized;
    }

    private assertAiBuilderEnabled() {
        if (!this.isAiBuilderEnabled()) {
            throw new NotFoundException('Workflow AI builder is disabled');
        }
    }

    private isAiBuilderEnabled() {
        const value = process.env.WORKFLOW_AI_BUILDER_ENABLED;
        return typeof value === 'string' && ENABLED_ENV_VALUES.has(value.trim().toLowerCase());
    }

    private isSensitiveAiBuilderKey(key: string) {
        const normalized = key.toLowerCase();
        return (
            normalized.includes('secret') ||
            normalized.includes('token') ||
            normalized.includes('password') ||
            normalized.includes('apikey') ||
            normalized.includes('api_key') ||
            normalized.includes('cookie') ||
            normalized.includes('authorization')
        );
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
