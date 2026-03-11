import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AssignContactDto } from './dto/assign.dto';
import { RealtimeService } from 'src/realtime/realtime.service';

@Injectable()
export class ContactsService {
    constructor(private prisma: PrismaService,
        private realtime: RealtimeService,) { }

    async create(workspaceId: string, dto: CreateContactDto) {
        return this.prisma.contact.create({
            data: {
                ...dto,
                workspaceId,
            },
        });
    }
    async assign(
        workspaceId: string,
        contactId: string,
        dto: AssignContactDto,
    ) {
        const contact = await this.prisma.contact.findFirst({
            where: { id: contactId, workspaceId },
        });

        if (!contact) {
            throw new NotFoundException('Contact not found');
        }

        // Validate agent if provided
        if (dto.assigneeId) {
            const member = await this.prisma.workspaceMember.findFirst({
                where: {
                    workspaceId,
                    userId: dto.assigneeId,
                    status: 'active',
                },
            });

            if (!member) {
                throw new NotFoundException('Agent not in workspace');
            }
        }

        // Validate team if provided
        if (dto.teamId) {
            const team = await this.prisma.team.findFirst({
                where: {
                    id: dto.teamId,
                    workspaceId,
                },
            });

            if (!team) {
                throw new NotFoundException('Team not found');
            }
        }

        const updated = await this.prisma.contact.update({
            where: { id: contactId },
            data: {
                assigneeId: dto.assigneeId ?? null,
                teamId: dto.teamId ?? null,
            },
        });

        // 🔥 Emit realtime event
        this.realtime.emitToWorkspace(
            workspaceId,
            'contact:updated',
            updated,
        );
        return updated;
    }

    async autoAssign(workspaceId: string, contactId: string) {
        // 1️⃣ Load conversation
        const contact = await this.prisma.contact.findFirst({
            where: { id: contactId, workspaceId },
        });

        if (!contact) return;

        let eligibleAgentIds: string[] = [];

        // 2️⃣ If conversation has team → get team agents
        if (contact.teamId) {
            const teamMembers = await this.prisma.teamMember.findMany({
                where: { teamId: contact.teamId },
                include: {
                    user: true,
                },
            });

            const workspaceMembers = await this.prisma.workspaceMember.findMany({
                where: {
                    workspaceId,
                    userId: { in: teamMembers.map(t => t.userId) },
                    role: 'agent',
                    status: 'active',
                    availability: 'online',
                },
            });

            eligibleAgentIds = workspaceMembers.map(m => m.userId);
        } else {
            // 3️⃣ Otherwise use all workspace agents
            const workspaceMembers = await this.prisma.workspaceMember.findMany({
                where: {
                    workspaceId,
                    role: 'agent',
                    status: 'active',
                    availability: 'online',
                },
            });

            eligibleAgentIds = workspaceMembers.map(m => m.userId);
        }

        if (!eligibleAgentIds.length) return;

        // 4️⃣ Get workload for each agent
        const workloads = await Promise.all(
            eligibleAgentIds.map(async (agentId) => {
                const count = await this.prisma.contact.count({
                    where: {
                        workspaceId,
                        assigneeId: agentId,
                        // status: 'open',
                    },
                });

                return {
                    userId: agentId,
                    count,
                };
            }),
        );

        // 5️⃣ Sort by least conversations
        workloads.sort((a, b) => a.count - b.count);

        const selectedAgent = workloads[0];

        // 6️⃣ Assign conversation
        const updated = await this.prisma.contact.update({
            where: { id: contactId },
            data: {
                assigneeId: selectedAgent.userId,
            },
        });

        // 7️⃣ Emit realtime update
        this.realtime.emitToWorkspace(
            workspaceId,
            'contact:updated',
            updated,
        );

        return updated;
    }

    async findAll(workspaceId: string) {
        return this.prisma.contact.findMany({
            where: { workspaceId },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findOne(workspaceId: string, id: string) {
        const contact = await this.prisma.contact.findFirst({
            where: { id, workspaceId },
        });

        if (!contact) throw new NotFoundException('Contact not found');

        return contact;
    }

    async update(workspaceId: string, id: string, dto: UpdateContactDto) {
        await this.findOne(workspaceId, id);

        return this.prisma.contact.update({
            where: { id },
            data: dto,
        });
    }

    async remove(workspaceId: string, id: string) {
        await this.findOne(workspaceId, id);

        return this.prisma.contact.delete({
            where: { id },
        });
    }

    async statusUpdate(workspaceId: string, contactId: string, status: string) {
        const contact = await this.prisma.contact.findFirst({
            where: { id: contactId, workspaceId },
        });

        if (!contact) throw new NotFoundException('Contact not found');

        return this.prisma.contact.update({
            where: { id: contactId },
            data: { status },
        });
    }
}