import { Module } from '@nestjs/common';
import { PrismaModule } from 'prisma/prisma.module';
import { ChannelRegistry } from './channel-registry.service';
import { ChannelService } from './channel.service';
import { ChannelsController } from './channels.controller';
import { R2Service } from 'src/common/storage/r2.service';
import { MediaService } from './media.service';

@Module({
    imports: [PrismaModule],
    providers: [ChannelRegistry, ChannelService,R2Service,MediaService      ],
    exports: [ChannelRegistry, ChannelService,ChannelRegistry,R2Service,MediaService], // 👈 important
    controllers: [ChannelsController], // we will add controllers later when we implement API endpoints for channels
})
export class ChannelsModule { }