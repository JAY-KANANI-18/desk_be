import { forwardRef, Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { WorkflowEngineService } from '../workflows/workflow-engine.service';
import { OutboundService } from '../outbound/outbound.service';
import { ChannelsModule } from '../channels/channels.module';

@Module({
    imports: [ forwardRef   (() => ChannelsModule) ],// ✅ fix],
    controllers: [MessagesController],
    providers: [MessagesService, WorkflowEngineService,OutboundService],
})
export class MessagesModule { }