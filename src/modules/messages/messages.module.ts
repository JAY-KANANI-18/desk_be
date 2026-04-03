import { forwardRef, Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { WorkflowEngineService } from '../workflows/workflow-engine.service';
import { OutboundService } from '../outbound/outbound.service';
import { ChannelsModule } from '../channels/channels.module';
import { R2Service } from 'src/common/storage/r2.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { OutboundModule } from '../outbound/outbound.module';

@Module({
    imports: [PrismaModule ,OutboundModule],
    controllers: [MessagesController],
    providers: [MessagesService],
    exports: [MessagesService],
})
export class MessagesModule { }