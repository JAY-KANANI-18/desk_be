import { Module } from '@nestjs/common';
import { OutboundService } from './outbound.service';
import { MediaService } from '../media/media.service';
import { MediaModule } from '../media/media.module';
import { ChannelAdaptersModule } from '../channel-adapters/channel-adapters.module';
import { ChannelAdaptersRegistry } from '../channel-adapters/channel-adapters.registry';
import { MessageProcessingModule } from './message-processing.module';

@Module({
  imports: [MediaModule, ChannelAdaptersModule, MessageProcessingModule],
  providers: [
    OutboundService,
    MediaService,
  ],
  exports: [OutboundService],
})
export class OutboundModule {}
