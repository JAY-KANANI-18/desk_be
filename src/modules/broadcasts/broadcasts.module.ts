import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { OutboundModule } from '../outbound/outbound.module';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';

@Module({
  imports: [PrismaModule, OutboundModule],
  controllers: [BroadcastsController],
  providers: [BroadcastsService],
  exports: [BroadcastsService],
})
export class BroadcastsModule {}

