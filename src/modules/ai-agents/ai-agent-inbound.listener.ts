import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { aiAgentQueue } from 'src/queues/ai-agent.queue';
import { aiAgentsDebug } from './ai-agents-debug.logger';
import { AiAgentsFeatureService } from './ai-agents-feature.service';

@Injectable()
export class AiAgentInboundListener {
  constructor(private readonly feature: AiAgentsFeatureService) {}

  @OnEvent('message.inbound', { async: true })
  async onInboundMessage(event: { workspaceId: string; conversationId: string; message: any }) {
    aiAgentsDebug.log('inbound.listener', 'message.inbound received', {
      workspaceId: event?.workspaceId,
      conversationId: event?.conversationId,
      messageId: event?.message?.id,
      direction: event?.message?.direction,
      channelId: event?.message?.channelId,
      channelType: event?.message?.channelType,
      text: event?.message?.text,
    });

    if (!this.feature.isEnabled()) {
      aiAgentsDebug.warn('inbound.listener', 'skipping enqueue because feature is disabled', {
        workspaceId: event?.workspaceId,
        conversationId: event?.conversationId,
        messageId: event?.message?.id,
      });
      return;
    }
    if (!event?.workspaceId || !event?.conversationId || !event?.message?.id) {
      aiAgentsDebug.warn('inbound.listener', 'skipping enqueue because inbound event is incomplete', { event });
      return;
    }
    if (event.message.direction && event.message.direction !== 'incoming') {
      aiAgentsDebug.warn('inbound.listener', 'skipping enqueue because message is not incoming', {
        messageId: event.message.id,
        direction: event.message.direction,
      });
      return;
    }

    const idempotencyKey = `${event.workspaceId}:${event.message.id}:ai-agent`;
    const job = await aiAgentQueue.add(
      'ai.agent.message_received',
      {
        type: 'MESSAGE_RECEIVED',
        workspaceId: event.workspaceId,
        conversationId: event.conversationId,
        messageId: event.message.id,
        channelId: event.message.channelId,
        channelType: event.message.channelType,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
      },
      { jobId: idempotencyKey },
    );
    const counts = await aiAgentQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
    aiAgentsDebug.log('inbound.listener', 'queued AI runtime job from inbound message', {
      jobId: job.id,
      jobName: job.name,
      queue: job.queueName,
      idempotencyKey,
      workspaceId: event.workspaceId,
      conversationId: event.conversationId,
      messageId: event.message.id,
      counts,
      jobData: job.data,
    });
  }
}
