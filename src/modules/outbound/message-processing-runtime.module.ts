import { Module } from '@nestjs/common';
import { InboundModule } from '../inbound/inbound.module';
import { RedisModule } from '../../redis/redis.module';
import { OutboundModule } from './outbound.module';
import { MessageProcessingModule } from './message-processing.module';
import { MessageProcessingWorker } from './message-processing.worker';
import { OutboundListener } from './outbound.listener';

@Module({
  imports: [RedisModule, InboundModule, OutboundModule, MessageProcessingModule],
  providers: [MessageProcessingWorker, OutboundListener],
})
export class MessageProcessingRuntimeModule {}
