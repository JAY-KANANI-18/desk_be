
import { Module } from '@nestjs/common';
import { MediaService } from "../media/media.service";
import { R2Service } from 'src/common/storage/r2.service';
import { ChannelAdaptersModule } from '../channel-adapters/channel-adapters.module';
import { ChannelAdaptersRegistry } from '../channel-adapters/channel-adapters.registry';

@Module({
  imports: [ChannelAdaptersModule],
  providers: [
    MediaService,
    R2Service,
    
  ],
  exports: [
    MediaService,
    R2Service,

  ],
})


export class MediaModule { }