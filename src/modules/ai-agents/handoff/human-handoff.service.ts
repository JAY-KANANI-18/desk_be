import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { aiAgentsDebug } from '../ai-agents-debug.logger';
import { AgentDecision } from '../runtime/agent-runtime.types';

@Injectable()
export class HumanHandoffService {
  constructor(private readonly prisma: PrismaService) {}

  shouldHandoff(input: {
    decision?: AgentDecision | null;
    guardrailReasons?: string[];
    contact?: any;
    customerText?: string | null;
    autoReplyCount?: number;
    maxAutoReplies?: number;
  }) {
    aiAgentsDebug.log('handoff', 'shouldHandoff start', {
      decision: input.decision,
      guardrailReasons: input.guardrailReasons,
      contact: input.contact,
      customerText: input.customerText,
      autoReplyCount: input.autoReplyCount,
      maxAutoReplies: input.maxAutoReplies,
    });
    const reasons = new Set(input.guardrailReasons || []);
    const text = input.customerText || '';

    if (input.decision?.needsHuman) reasons.add('decision_requested_handoff');
    if ((input.decision?.confidence ?? 1) < 0.65) reasons.add('low_confidence');
    if (input.decision?.sentiment === 'angry') reasons.add('angry_sentiment');
    if (/\b(human|agent|manager|representative|real person)\b/i.test(text)) reasons.add('customer_requested_human');
    if (/\b(refund|chargeback|lawsuit|legal|medical|prescription)\b/i.test(text)) reasons.add('sensitive_topic');
    if (input.contact?.priority === 'vip' || input.contact?.status === 'vip') reasons.add('vip_customer');
    if ((input.autoReplyCount || 0) >= (input.maxAutoReplies || 5)) reasons.add('max_auto_replies');

    const result = { handoffRequired: reasons.size > 0, reasons: [...reasons] };
    aiAgentsDebug.log('handoff', 'shouldHandoff result', result);
    return result;
  }

  async escalate(input: {
    workspaceId: string;
    runId?: string;
    conversationId: string;
    contactId?: string;
    reason: string;
    summary?: string;
    preferredTeamId?: string;
  }) {
    aiAgentsDebug.log('handoff', 'escalate start', input);
    const assignee = await this.pickBestAgent(input.workspaceId, input.preferredTeamId);
    aiAgentsDebug.log('handoff', 'assignee selected', {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      preferredTeamId: input.preferredTeamId,
      assignee,
    });

    if (assignee?.userId && input.contactId) {
      aiAgentsDebug.log('handoff', 'updating contact assignee', {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        assignee,
      });
      await this.prisma.contact.updateMany({
        where: { id: input.contactId, workspaceId: input.workspaceId },
        data: {
          assigneeId: assignee.userId,
          ...(assignee.teamId ? { teamId: assignee.teamId } : {}),
        },
      });
    }

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        INSERT INTO "ai_escalations"
          ("workspace_id", "run_id", "conversation_id", "contact_id", "reason", "summary",
           "assigned_user_id", "assigned_team_id", "status")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, $8::uuid, $9)
        RETURNING *
      `,
      input.workspaceId,
      input.runId || null,
      input.conversationId,
      input.contactId || null,
      input.reason,
      input.summary || null,
      assignee?.userId || null,
      assignee?.teamId || input.preferredTeamId || null,
      assignee?.userId ? 'assigned' : 'open',
    );
    aiAgentsDebug.log('handoff', 'escalation inserted', {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      escalation: rows[0],
    });

    await this.prisma.conversationActivity.create({
      data: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        eventType: 'ai_handoff',
        actorType: 'automation',
        subjectUserId: assignee?.userId || null,
        subjectTeamId: assignee?.teamId || input.preferredTeamId || null,
        metadata: {
          reason: input.reason,
          summary: input.summary,
          runId: input.runId,
          escalationId: rows[0]?.id,
        },
      },
    });
    aiAgentsDebug.log('handoff', 'conversation activity recorded', {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      escalationId: rows[0]?.id,
      assignee,
    });

    return rows[0];
  }

  private async pickBestAgent(workspaceId: string, teamId?: string) {
    aiAgentsDebug.log('handoff.assignment', 'pickBestAgent start', { workspaceId, teamId });
    const members = await this.prisma.workspaceMember.findMany({
      where: {
        workspaceId,
        role: { in: ['agent', 'WS_AGENT', 'manager', 'WS_MANAGER'] },
        status: 'active',
        availability: { in: ['online', 'active'] },
        ...(teamId
          ? {
              user: {
                teamMembers: {
                  some: { teamId },
                },
              },
            }
          : {}),
      },
      select: { userId: true },
      take: 25,
    });
    aiAgentsDebug.log('handoff.assignment', 'candidate members loaded', {
      workspaceId,
      teamId,
      candidateCount: members.length,
      members,
    });

    if (!members.length) {
      aiAgentsDebug.warn('handoff.assignment', 'no available members found', { workspaceId, teamId });
      return null;
    }

    const load = await Promise.all(
      members.map(async (member) => ({
        userId: member.userId,
        teamId,
        openContacts: await this.prisma.contact.count({
          where: {
            workspaceId,
            assigneeId: member.userId,
            mergedIntoContactId: null,
            conversations: { some: { status: { not: 'closed' } } },
          },
        }),
      })),
    );

    const selected = load.sort((a, b) => a.openContacts - b.openContacts)[0];
    aiAgentsDebug.log('handoff.assignment', 'pickBestAgent result', {
      workspaceId,
      teamId,
      load,
      selected,
    });
    return selected;
  }
}
