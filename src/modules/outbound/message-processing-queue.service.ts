import { Injectable } from '@nestjs/common';
import { messageProcessingQueue } from '../../queues/message-processing.queue';
import { ExternalOutboundDto, SendMessageDto } from './outbound.service';
import { InboundDto } from '../inbound/inbound.service';

@Injectable()
export class MessageProcessingQueueService {
  async enqueueSendMessage(params: SendMessageDto) {
    await messageProcessingQueue.add('outbound.send_message', {
      kind: 'outbound.send_message',
      payload: params,
    });
  }

  async enqueueQueueEntry(queueEntryId: string) {
    await messageProcessingQueue.add(
      'outbound.deliver_queue_entry',
      {
        kind: 'outbound.deliver_queue_entry',
        payload: { queueEntryId },
      },
      { jobId: queueEntryId },
    );
  }

  async enqueueInboundProcess(dto: InboundDto) {
    await messageProcessingQueue.add('inbound.process', {
      kind: 'inbound.process',
      payload: dto,
    });
  }

  async enqueueExternalOutbound(dto: ExternalOutboundDto) {
    await messageProcessingQueue.add('outbound.process_external_outbound', {
      kind: 'outbound.process_external_outbound',
      payload: dto,
    });
  }

  async enqueueWhatsappStatusUpdate(payload: {
    channelId: string;
    channelType: string;
    externalId: string;
    status: 'delivered' | 'read' | 'failed';
  }) {
    await messageProcessingQueue.add('outbound.process_whatsapp_status', {
      kind: 'outbound.process_whatsapp_status',
      payload,
    });
  }

  async enqueueMessengerDelivery(payload: {
    channelId: string;
    externalId: string;
  }) {
    await messageProcessingQueue.add('outbound.process_messenger_delivery', {
      kind: 'outbound.process_messenger_delivery',
      payload,
    });
  }

  async enqueueMessengerRead(payload: {
    channelId: string;
    contactIdentifier: string;
    watermark: number;
  }) {
    await messageProcessingQueue.add('outbound.process_messenger_read', {
      kind: 'outbound.process_messenger_read',
      payload,
    });
  }
}
