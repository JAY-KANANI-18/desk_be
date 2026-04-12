import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { connection } from '../../queues/connection';
import { InboundService } from '../inbound/inbound.service';
import { OutboundService } from './outbound.service';

@Injectable()
export class MessageProcessingWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MessageProcessingWorker.name);
  private worker?: Worker;

  constructor(
    private readonly outbound: OutboundService,
    private readonly inbound: InboundService,
  ) {}

  onApplicationBootstrap() {
    this.worker = new Worker(
      'message-processing',
      async (job: Job<{ kind: string; payload: any }>) => {
        const { kind, payload } = job.data;

        switch (kind) {
          case 'outbound.send_message':
            await this.outbound.sendMessage(payload);
            return;
          case 'outbound.deliver_queue_entry':
            await this.outbound.processQueueEntry(
              payload.queueEntryId,
              job.attemptsMade + 1,
              job.opts.attempts ?? 1,
            );
            return;
          case 'inbound.process':
            await this.inbound.process(payload);
            return;
          case 'outbound.process_external_outbound':
            await this.outbound.processExternalOutbound(payload);
            return;
          case 'outbound.process_whatsapp_status':
            await this.outbound.processWhatsappStatusUpdate(payload);
            return;
          case 'outbound.process_messenger_delivery':
            await this.outbound.processMessengerDelivery(payload);
            return;
          case 'outbound.process_messenger_read':
            await this.outbound.processMessengerRead(payload);
            return;
          default:
            this.logger.warn(`Unknown message-processing job kind: ${kind}`);
            return;
        }
      },
      { connection },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `message-processing job failed kind=${job?.name} id=${job?.id}: ${err.message}`,
      );
    });
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }
}
