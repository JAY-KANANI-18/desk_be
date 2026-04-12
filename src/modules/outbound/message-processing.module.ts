import { Module } from '@nestjs/common';
import { MessageProcessingQueueService } from './message-processing-queue.service';

@Module({
  providers: [MessageProcessingQueueService],
  exports: [MessageProcessingQueueService],
})
export class MessageProcessingModule {}
