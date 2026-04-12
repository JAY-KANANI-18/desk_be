import {
  Injectable, Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import IORedis from 'ioredis';
import { RedisService } from '../../redis/redis.service';
import { OutboundJob } from '../../queues/outbound.queue';
import { MessageProcessingQueueService } from './message-processing-queue.service';

@Injectable()
export class OutboundListener implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboundListener.name);
  private subscriber: IORedis;

  constructor(
    private readonly processingQueue: MessageProcessingQueueService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap() {
    // Dedicated subscriber connection — Redis pub/sub requires separate connection
    this.subscriber = this.redis.client.duplicate();

    this.subscriber.subscribe('outbound.send', (err) => {
      if (err) this.logger.error('Failed to subscribe to outbound.send', err);
      else this.logger.log('✅ Outbound listener subscribed');
    });

    this.subscriber.on('message', async (channel, message) => {
      if (channel !== 'outbound.send') return;

      let job: OutboundJob;
      try {
        job = JSON.parse(message);
      } catch {
        this.logger.error('Failed to parse outbound job', message);
        return;
      }

      try {
        this.logger.log(
          `Queueing wf message conv=${job.conversationId} channel=${job.channelId}`,
        );
        await this.processingQueue.enqueueSendMessage({
          conversationId: job.conversationId,
          workspaceId:    job.workspaceId,
          channelId:      job.channelId,
          text:           job.text,
          authorId:       job.authorId,
          attachments:    job.attachments ?? [],
          metadata:       job.metadata ?? {},
        });
      } catch (err: any) {
        this.logger.error(
          `Failed to queue wf message conv=${job.conversationId}: ${err.message}`,
        );
      }
    });
  }

  async onApplicationShutdown() {
    await this.subscriber?.quit();
  }
}
