import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WorkflowsService {
    constructor(private prisma: PrismaService) { }

    async create(workspaceId: string, dto: any, userId: string) {
        this.validateWorkflow(dto);

        return this.prisma.workflow.create({
            data: {
                workspaceId,
                createBy: userId,
                name: dto.name,
                config: dto.config,
                status: "draft"
            },
        });
    }

    async update(workspaceId: string, id: string, dto: any) {
        const workflow = await this.prisma.workflow.findFirst({
            where: { id, workspaceId },
        });

        if (!workflow) {
            throw new NotFoundException('Workflow not found');
        }

        // this.validateWorkflow(dto);

        return this.prisma.workflow.update({
            where: { id },
            data: {
                config: dto.config,
            },
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

    async publish(workspaceId: string, id: string) {
        const workflow = await this.prisma.workflow.findFirst({
            where: { id, workspaceId },
        });

        if (!workflow) {
            throw new NotFoundException('Workflow not found');
        }

        return this.prisma.workflow.update({
            where: { id },
            data: { status: "published" },
        });
    }

    async stop(workspaceId: string, id: string) {
        return this.prisma.workflow.update({
            where: { id },
            data: { status: "stopped" },
        });
    }
    async clone(workspaceId: string, dto: any, userId: string) {
        const workflow = await this.prisma.workflow.findFirst({
            where: { id: dto.id, workspaceId },
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

    async list(workspaceId: string) {
        return this.prisma.workflow.findMany({
            where: { workspaceId },
            orderBy: { createdAt: 'desc' },
        });
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

    /**
     * Basic structure validation
     */
    private validateWorkflow(dto: any) {
        if (!dto.name) {
            throw new BadRequestException('Workflow name is required');
        }

        // if (!dto.trigger || !dto.trigger.type) {
        //     throw new BadRequestException('Trigger is required');
        // }

        // if (!Array.isArray(dto.config)) {
        //     throw new BadRequestException('config must be an array');
        // }

        // for (const node of dto.config) {
        //     if (!node.type) {
        //         throw new BadRequestException('Node type is required');
        //     }

        //     if (node.type === 'condition') {
        //         if (!node.field || !node.operator) {
        //             throw new BadRequestException(
        //                 'Condition node requires field and operator',
        //             );
        //         }
        //     }

        //     if (node.type === 'action') {
        //         if (!node.actionType) {
        //             throw new BadRequestException(
        //                 'Action node requires actionType',
        //             );
        //         }
        //     }
        // }
    }
}