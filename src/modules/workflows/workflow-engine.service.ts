import { Injectable } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
// import { ConversationsService } from '../conversations/conversations.service';
import { workflowQueue } from '../../queues/workflow.queue';

@Injectable()
export class WorkflowEngineService {
    constructor(
        private prisma: PrismaService,
        // private conversations: ConversationsService,
    ) { }

    async handleMessageReceived(payload: {
        workspaceId: string;
        conversationId: string;
        messageText: string;
    }) {
        // ALERT: type any is wrong need to remove in future
        const workflows: any[] = await this.prisma.workflow.findMany({
            where: {
                workspaceId: payload.workspaceId,
                isActive: true,
            },
        });

        for (const workflow of workflows) {
            if (workflow.trigger?.type !== 'message.received') continue;

            const nodes = workflow.nodes as any[];

            let conditionPassed = true;

            for (const node of nodes) {
                if (node.type === 'condition') {
                    if (
                        node.field === 'message.text' &&
                        node.operator === 'contains'
                    ) {
                        if (!payload.messageText?.includes(node.value)) {
                            conditionPassed = false;
                        }
                    }
                }
            }

            if (!conditionPassed) continue;

            // 🔥 Instead of executing directly
            await workflowQueue.add(
                'execute-workflow',
                {
                    workspaceId: payload.workspaceId,
                    conversationId: payload.conversationId,
                    nodes,
                },
                {
                    removeOnComplete: true,
                },
            );
        }
    }
}