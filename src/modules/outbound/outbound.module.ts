import { Module } from '@nestjs/common';
import { OutboundService } from './outbound.service';
import { ChannelsModule } from '../channels/channels.module';
import { PrismaService } from 'prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { MediaModule } from '../media/media.module';
import { ChannelAdaptersModule } from '../channel-adapters/channel-adapters.module';
import { ChannelAdaptersRegistry } from '../channel-adapters/channel-adapters.registry';
import { OutboundListener } from './outbound.listener';

@Module({
  imports: [MediaModule,ChannelAdaptersModule],
  providers: [OutboundService,PrismaService,MediaService,OutboundListener],
  exports: [OutboundService],
})
export class OutboundModule {}